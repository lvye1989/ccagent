import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { ZpayClient, signZpay } from '../../src/platform/zpay';
import { isolatedDatabase } from './database-fixture';

test('ZPAY protocol fixture with real isolated Supabase orders, notification events and refunds', { timeout: 240000 }, async t => {
  const fixture = await isolatedDatabase();
  process.env.DB_MAX_CONNECTIONS = '4';
  process.env.AUTH_URL = 'https://ccagent.example.invalid';
  process.env.ZPAY_PID = 'fixturemerchant';
  process.env.ZPAY_KEY = randomBytes(32).toString('hex');
  const merchantId = process.env.ZPAY_PID, key = process.env.ZPAY_KEY;
  const { database, closeDatabase } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  const { createPaymentService, createRechargeOrder } = await import('../src/core/payments');
  const { saveConfiguration } = await import('../src/core/configuration');
  const { walletFor, postLedger } = await import('../src/core/wallet');
  const payer = randomUUID(), admin = randomUUID();
  const responses = new Map<string, { money: string; paid: boolean; refund: 'success' | 'rejected' | 'unknown' }>();
  let queryCalls = 0, refundCalls = 0;
  const provider = new ZpayClient({ merchantId, key, fetch: async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://zpayz.cn');
    if (url.searchParams.get('act') === 'order') {
      queryCalls++;
      const orderId = url.searchParams.get('out_trade_no')!, entry = responses.get(orderId)!;
      return Response.json({ code: 1, status: entry.paid ? 1 : 0, pid: merchantId, type: 'alipay', out_trade_no: orderId, trade_no: `trade_${orderId}`, money: entry.money });
    }
    assert.equal(url.searchParams.get('act'), 'refund'); assert.equal(init?.method, 'POST');
    refundCalls++;
    const form = new URLSearchParams(String(init?.body)), entry = responses.get(form.get('out_trade_no')!)!;
    assert.equal((await walletFor(payer)).frozen >= 1000000n, true, 'refund must be frozen before contacting provider');
    if (entry.refund === 'unknown') throw new Error('simulated transport interruption');
    return Response.json({ code: entry.refund === 'success' ? 1 : 0 });
  } });
  const service = createPaymentService({ merchantId, key, origin: process.env.AUTH_URL, provider });
  async function order(refund: 'success' | 'rejected' | 'unknown' = 'success') {
    const created = await createRechargeOrder(payer, '1.00');
    responses.set(created.orderId, { money: '1.00', paid: true, refund });
    return created.orderId;
  }
  function notification(id: string, overrides: Record<string, string> = {}) {
    const fields = { pid: merchantId, out_trade_no: id, trade_no: `trade_${id}`, type: 'alipay', money: '1.00', trade_status: 'TRADE_SUCCESS', sign_type: 'MD5', ...overrides };
    return new URLSearchParams({ ...fields, sign: signZpay(fields, key) });
  }
  try {
    await database().db.insert(tables.user).values([{ id: payer, name: 'Payer fixture', email: `${payer}@example.invalid`, emailVerified: true }, { id: admin, name: 'Admin fixture', email: `${admin}@example.invalid`, emailVerified: true }]);
    await saveConfiguration(admin, { changes: [{ key: 'payment_enabled', value: true, version: 0 }] });
    const first = await order();
    await t.test('order creation validates fen amounts and builds signed HTTPS POST checkout', async () => {
      const [stored] = await database().db.select().from(tables.orders).where(eq(tables.orders.id, first));
      assert.equal(stored.userId, payer); assert.equal(stored.amountFen, 100n);
      const checkout = service.checkout(stored);
      assert.equal(checkout.action, 'https://zpayz.cn/submit.php'); assert.equal(checkout.method, 'POST');
      assert.equal(checkout.fields.money, '1.00'); assert.equal(new URL(checkout.fields.notify_url).search, '');
      await assert.rejects(() => createRechargeOrder(payer, '1.001'), { status: 400 });
      await assert.rejects(() => createRechargeOrder(payer, '0.01'), { status: 400 });
      assert.equal((await walletFor(payer)).balance, 0n);
    });
    await t.test('valid and duplicate notifications persist once within deadline and never credit directly', async () => {
      const started = Date.now();
      await service.receiveNotification(notification(first));
      assert.ok(Date.now() - started < 5000);
      await Promise.all(Array.from({ length: 4 }, () => service.receiveNotification(notification(first))));
      const [{ count }] = await database().db.select({ count: sql<number>`count(*)::integer` }).from(tables.paymentEvents).where(eq(tables.paymentEvents.orderId, first));
      assert.equal(count, 1); assert.equal((await walletFor(payer)).balance, 0n);
      const forged = notification(first); forged.set('sign', '0'.repeat(32));
      await assert.rejects(() => service.receiveNotification(forged));
      await assert.rejects(() => service.receiveNotification(notification(first, { money: '2.00' })));
      await assert.rejects(() => service.receiveNotification(notification(first, { pid: 'othermerchant' })));
      assert.equal(queryCalls, 0);
    });
    await t.test('concurrent authenticated upstream queries credit a paid order exactly once', async () => {
      await Promise.all(Array.from({ length: 4 }, () => service.reconcileOrder(first, `trade_${first}`)));
      assert.equal((await walletFor(payer)).balance, 1000000n);
      const rows = await database().db.select().from(tables.ledger).where(eq(tables.ledger.reference, `recharge:${first}`));
      assert.equal(rows.length, 1);
      const [event] = await database().db.select().from(tables.paymentEvents).where(eq(tables.paymentEvents.orderId, first));
      assert.equal(event.status, 'verified');
    });
    const missed = await order('unknown');
    await t.test('missing callback can be reconciled; mismatched upstream amount cannot credit', async () => {
      await service.reconcileOrder(missed);
      assert.equal((await walletFor(payer)).balance, 2000000n);
      const bad = await order(); responses.get(bad)!.money = '9.99';
      await assert.rejects(() => service.reconcileOrder(bad));
      assert.equal((await walletFor(payer)).balance, 2000000n);
    });
    await t.test('concurrent full refund requests freeze first and send only one upstream refund', async () => {
      await Promise.all(Array.from({ length: 3 }, () => service.requestRefund(first, admin, 'Refund concurrency fixture')));
      assert.equal(refundCalls, 1);
      const balance = await walletFor(payer); assert.equal(balance.balance, 1000000n); assert.equal(balance.frozen, 0n);
      const [refund] = await database().db.select().from(tables.refunds).where(eq(tables.refunds.orderId, first));
      assert.equal(refund.status, 'success');
      await service.requestRefund(first, admin, 'Duplicate attempt fixture');
      assert.equal(refundCalls, 1);
    });
    await t.test('unknown refund stays frozen, is not retried or inferred from payment query, and requires evidence', async () => {
      const pending = await service.requestRefund(missed, admin, 'Unknown result fixture');
      assert.equal(pending.status, 'pending'); assert.equal((await walletFor(payer)).frozen, 1000000n);
      const before = queryCalls;
      await service.requestRefund(missed, admin, 'Do not repeat fixture');
      await service.reconcileOrder(missed);
      assert.equal(refundCalls, 2); assert.equal(queryCalls, before);
      await assert.rejects(() => service.resolveRefund(pending.id, 'rejected', admin, 'Checked refund evidence fixture'), { status: 409 });
      await database().db.update(tables.refunds).set({ createdAt: new Date(Date.now() - 180000) }).where(eq(tables.refunds.id, pending.id));
      await service.resolveRefund(pending.id, 'rejected', admin, 'Fixture evidence: upstream confirms rejection');
      const balance = await walletFor(payer); assert.equal(balance.balance, 1000000n); assert.equal(balance.frozen, 0n);
    });
    await t.test('insufficient available balance prevents refund before contacting upstream', async () => {
      const next = await order(); await service.reconcileOrder(next);
      await database().db.transaction(tx => postLedger(tx, payer, 'fixture-spend', 'adjustment', -1500000n, 0n));
      const callsBefore = refundCalls;
      await assert.rejects(() => service.requestRefund(next, admin, 'Insufficient funds fixture'), { status: 402 });
      assert.equal(refundCalls, callsBefore);
      const records = await database().db.select().from(tables.refunds).where(eq(tables.refunds.orderId, next));
      assert.equal(records.length, 0); assert.equal((await walletFor(payer)).frozen, 0n);
    });
    await t.test('an explicit upstream refund rejection releases the full authorization', async () => {
      const rejected = await order('rejected'); await service.reconcileOrder(rejected);
      const before = (await walletFor(payer)).balance;
      const result = await service.requestRefund(rejected, admin, 'Explicit rejection fixture');
      assert.equal(result.status, 'rejected');
      assert.equal((await walletFor(payer)).balance, before); assert.equal((await walletFor(payer)).frozen, 0n);
      const [{ count }] = await database().db.select({ count: sql<number>`count(*)::integer` }).from(tables.audit).where(and(eq(tables.audit.action, 'refunds.provider_result'), eq(tables.audit.objectId, result.id)));
      assert.equal(count, 1);
    });
  } finally { await closeDatabase(); await fixture.cleanup(); }
});
