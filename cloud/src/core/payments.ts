import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { ZpayClient, createMerchantOrderNumber, parseZpayNotification, verifyPaymentNotification } from '../../../src/platform/zpay';
import { MICRO_FEN, parseRechargeMoney, paymentMoneyToMicro } from '../../../src/platform/money';
import { database } from './db';
import { audit, orders, paymentEvents, refunds } from './db/schema';
import { authEnvironment, databaseSchema } from './env';
import { configurationValues } from './configuration';
import { HttpError } from './http';
import { postLedger } from './wallet';

type Provider = Pick<ZpayClient, 'checkout' | 'queryPaidOrder' | 'refund'>;
export function createPaymentService(options: { merchantId: string; key: string; origin: string; provider: Provider }) {
  const expected = (order: typeof orders.$inferSelect, tradeNo?: string) => ({ merchantOrder: order.id, amountMicro: order.amountFen * MICRO_FEN, ...(tradeNo || order.tradeNo ? { tradeNo: tradeNo || order.tradeNo! } : {}) });

  async function receiveNotification(search: URLSearchParams) {
    const parameters = parseZpayNotification(search), id = parameters.out_trade_no || '';
    if (!/^\d{1,32}$/.test(id)) throw new HttpError(400, 'INVALID_NOTIFICATION', '通知无效。');
    const payment = verifyPaymentNotification(parameters, { merchantOrder: id, amountMicro: paymentMoneyToMicro(parameters.money || '') }, options.merchantId, options.key);
    const hash = createHash('sha256').update(JSON.stringify([options.merchantId, id, payment.tradeNo, payment.amountMicro.toString(), payment.channel])).digest('hex');
    const schema = databaseSchema();
    // A single durable statement checks local ownership/amount/channel and persists the event.
    // No upstream query or user login is on the notification acknowledgement path.
    const query = database().client.unsafe<{ valid: boolean }[]>(`WITH matched AS (
      SELECT id FROM "${schema}".orders WHERE id=$1 AND merchant_id=$2 AND amount_fen=$3::bigint AND channel='alipay'
        AND (trade_no IS NULL OR trade_no=$4)
    ), saved AS (
      INSERT INTO "${schema}".payment_events(id,order_id,trade_no,deduplication_hash)
      SELECT $5,id,$4,$6 FROM matched ON CONFLICT(deduplication_hash) DO NOTHING RETURNING id
    ) SELECT EXISTS(SELECT 1 FROM matched) as valid, (SELECT count(*) FROM saved) as inserted`,
    [id, options.merchantId, (payment.amountMicro / MICRO_FEN).toString(), payment.tradeNo, randomUUID(), hash]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const rows = await Promise.race([query, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { void query.cancel().catch(() => {}); reject(new HttpError(503, 'NOTIFICATION_NOT_PERSISTED', '通知暂未保存。')); }, 4000);
      })]);
      if (!rows[0]?.valid) throw new HttpError(400, 'ORDER_MISMATCH', '通知与订单不符。');
      return { orderId: id, tradeNo: payment.tradeNo };
    } finally { if (timer) clearTimeout(timer); }
  }

  async function reconcileOrder(orderId: string, tradeNo?: string) {
    const db = database().db;
    const [original] = await db.select().from(orders).where(eq(orders.id, orderId));
    if (!original) throw new HttpError(404, 'ORDER_NOT_FOUND', '订单不存在。');
    if (original.merchantId !== options.merchantId) throw new HttpError(503, 'MERCHANT_CONFIGURATION_CHANGED', '该订单的支付商户配置需要核验。');
    if (original.status !== 'pending') {
      if (original.tradeNo) await db.update(paymentEvents).set({ status: 'verified', processedAt: new Date() }).where(and(eq(paymentEvents.orderId, orderId), eq(paymentEvents.tradeNo, original.tradeNo), eq(paymentEvents.status, 'pending')));
      return { status: original.status };
    }
    await db.update(paymentEvents).set({ attempts: sql`${paymentEvents.attempts} + 1` }).where(and(eq(paymentEvents.orderId, orderId), eq(paymentEvents.status, 'pending')));
    const paid = await options.provider.queryPaidOrder(expected(original, tradeNo));
    if (!paid) { await db.update(orders).set({ checkedAt: new Date() }).where(eq(orders.id, orderId)); return { status: 'pending' }; }
    return db.transaction(async tx => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
      if (order.merchantId !== options.merchantId || order.amountFen * MICRO_FEN !== paid.amountMicro || order.channel !== paid.channel || (order.tradeNo && order.tradeNo !== paid.tradeNo)) throw new HttpError(409, 'ORDER_MISMATCH', '支付查单与本地订单不符。');
      if (order.status === 'pending') {
        await postLedger(tx, order.userId, `recharge:${order.id}`, 'recharge', paid.amountMicro, 0n, { orderId: order.id, tradeNo: paid.tradeNo });
        await tx.update(orders).set({ status: 'credited', tradeNo: paid.tradeNo, creditedAt: new Date(), checkedAt: new Date() }).where(eq(orders.id, orderId));
      }
      await tx.update(paymentEvents).set({ status: 'verified', processedAt: new Date() }).where(and(eq(paymentEvents.orderId, orderId), eq(paymentEvents.tradeNo, paid.tradeNo), eq(paymentEvents.status, 'pending')));
      return { status: order.status === 'pending' ? 'credited' : order.status };
    });
  }

  async function refundResult(refundId: string, outcome: 'success' | 'rejected', actorId?: string, evidence?: string) {
    return database().db.transaction(async tx => {
      const [reference] = await tx.select().from(refunds).where(eq(refunds.id, refundId));
      if (!reference) throw new HttpError(404, 'REFUND_NOT_FOUND', '退款申请不存在。');
      const [order] = await tx.select().from(orders).where(eq(orders.id, reference.orderId)).for('update');
      const [refund] = await tx.select().from(refunds).where(eq(refunds.id, refundId)).for('update');
      if (['success', 'rejected'].includes(refund.status)) {
        if (refund.status !== outcome) throw new HttpError(409, 'REFUND_CONFLICT', '退款已有不同的处理结果。');
        return refund;
      }
      if (actorId && Date.now() - refund.createdAt.getTime() < 120000) throw new HttpError(409, 'REFUND_IN_PROGRESS', '退款请求仍可能在处理中，请稍后核验。');
      await postLedger(tx, refund.userId, `refund:${refund.id}:finish`, outcome === 'success' ? 'refund' : 'refund_release', outcome === 'success' ? -refund.amount : 0n, -refund.amount,
        { orderId: order.id, refundId: refund.id, ...(actorId ? { actorId, evidence } : {}) });
      const [result] = await tx.update(refunds).set({ status: outcome, updatedAt: new Date() }).where(eq(refunds.id, refund.id)).returning();
      await tx.update(orders).set({ status: outcome === 'success' ? 'refunded' : 'credited' }).where(eq(orders.id, order.id));
      await tx.insert(audit).values({ id: randomUUID(), actorId: actorId || refund.initiatedBy, action: actorId ? 'refunds.manual_resolution' : 'refunds.provider_result', objectId: refund.id, result: outcome,
        metadata: { orderId: order.id, ...(actorId ? { evidence } : {}) } });
      return result;
    });
  }

  async function requestRefund(orderId: string, actorId: string, reason: string) {
    const db = database().db;
    const prepared = await db.transaction(async tx => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
      if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', '订单不存在。');
      const [existing] = await tx.select().from(refunds).where(eq(refunds.orderId, orderId));
      if (existing) return { refund: existing, created: false, order };
      if (order.status !== 'credited' || !order.tradeNo || order.merchantId !== options.merchantId) throw new HttpError(409, 'REFUND_NOT_AVAILABLE', '该订单目前不能发起原路退款。');
      const id = randomUUID(), amount = order.amountFen * MICRO_FEN;
      await postLedger(tx, order.userId, `refund:${id}:hold`, 'refund_hold', 0n, amount, { orderId, refundId: id });
      const [refund] = await tx.insert(refunds).values({ id, orderId, userId: order.userId, amount, initiatedBy: actorId, reason }).returning();
      await tx.update(orders).set({ status: 'refunding' }).where(eq(orders.id, orderId));
      await tx.insert(audit).values({ id: randomUUID(), actorId, action: 'refunds.request', objectId: id, result: 'held', metadata: { orderId, amount: amount.toString(), reason } });
      return { refund, created: true, order };
    });
    // Neither client retries nor background reconciliation repeat a submitted refund.
    if (!prepared.created) return prepared.refund;
    const [claimed] = await db.update(refunds).set({ status: 'submitting', updatedAt: new Date() }).where(and(eq(refunds.id, prepared.refund.id), eq(refunds.status, 'held'))).returning();
    if (!claimed) return prepared.refund;
    const result = await options.provider.refund(expected(prepared.order), claimed.amount);
    if (result.status === 'unknown') {
      const [pending] = await db.update(refunds).set({ status: 'pending', updatedAt: new Date() }).where(eq(refunds.id, claimed.id)).returning();
      return pending;
    }
    return refundResult(claimed.id, result.status);
  }
  return { receiveNotification, reconcileOrder, requestRefund, resolveRefund: refundResult,
    checkout: (order: typeof orders.$inferSelect) => options.provider.checkout(expected(order), `${options.origin}/api/payments/zpay/notify`, `${options.origin}/payment/return`) };
}

export function paymentService() {
  const merchantId = process.env.ZPAY_PID || '', key = process.env.ZPAY_KEY || '';
  if (!merchantId || !key) throw new HttpError(503, 'PAYMENT_NOT_CONFIGURED', '充值服务暂未开放。');
  const origin = authEnvironment().origin;
  if (!origin.startsWith('https://')) throw new HttpError(503, 'PAYMENT_HTTPS_REQUIRED', '支付服务需要正式 HTTPS 地址。');
  return createPaymentService({ merchantId, key, origin, provider: new ZpayClient({ merchantId, key, baseUrl: process.env.ZPAY_API_BASE_URL || 'https://zpayz.cn', channelId: process.env.ZPAY_CHANNEL_ID }) });
}
export async function createRechargeOrder(userId: string, amountText: string) {
  const config = await configurationValues();
  if (!config.payment_enabled) throw new HttpError(503, 'PAYMENT_DISABLED', '充值服务暂未开放。');
  let amount: bigint;
  try { amount = parseRechargeMoney(amountText); } catch { throw new HttpError(400, 'INVALID_AMOUNT', '请输入有效人民币金额，最多两位小数。'); }
  const amountFen = amount / MICRO_FEN;
  if (amountFen < BigInt(config.recharge_min_fen) || amountFen > BigInt(config.recharge_max_fen)) throw new HttpError(400, 'RECHARGE_AMOUNT_OUT_OF_RANGE', '充值金额超出允许范围。');
  const service = paymentService(), id = createMerchantOrderNumber();
  const [order] = await database().db.insert(orders).values({ id, userId, amountFen, merchantId: process.env.ZPAY_PID! }).returning();
  service.checkout(order); // Validate all gateway/callback settings before returning a payable order.
  return { orderId: id, checkoutUrl: `/checkout/${id}` };
}
export async function reconcilePayments(options: { deadline?: number } = {}) {
  const service = paymentService(), db = database().db;
  const pending = await db.select({ id: orders.id }).from(orders).where(eq(orders.status, 'pending')).orderBy(sql`${orders.checkedAt} asc nulls first`, orders.createdAt).limit(10);
  let verified = 0, deferred = 0, examined = 0;
  for (const order of pending) {
    if (Date.now() >= (options.deadline ?? Infinity)) break;
    examined++;
    try { const result = await service.reconcileOrder(order.id); if (result.status === 'credited') verified++; }
    catch { deferred++; await db.update(orders).set({ checkedAt: new Date() }).where(eq(orders.id, order.id)); }
  }
  return { examined, verified, deferred };
}
