import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { database } from './db';
import { ledger, namespace, reservations, wallets } from './db/schema';
import { HttpError } from './http';

type DB = ReturnType<typeof database>['db'];
type Transaction = Parameters<Parameters<DB['transaction']>[0]>[0];
type LedgerKind = 'recharge' | 'authorization' | 'settlement' | 'release' | 'refund_hold' | 'refund' | 'refund_release' | 'adjustment';
const postLedgerFunction = sql`${sql.identifier(namespace.schemaName)}.${sql.identifier('post_ledger')}`;

export async function postLedger(tx: Transaction, userId: string, reference: string, kind: LedgerKind, balanceDelta: bigint, frozenDelta: bigint,
  metadata: Record<string, unknown> = {}): Promise<void> {
  // The helper returns void; request a builtin scalar instead of the unused
  // composite ledger row so concurrent first calls need no type discovery.
  try { await tx.execute(sql`select (${postLedgerFunction}(${userId}::text, ${reference}::text, ${kind}::text, ${balanceDelta.toString()}::bigint, ${frozenDelta.toString()}::bigint, ${JSON.stringify(metadata)}::jsonb)).id`); }
  catch (error) { financialError(error); }
}

export async function walletFor(userId: string) {
  const [wallet] = await database().db.select().from(wallets).where(eq(wallets.userId, userId));
  if (!wallet) throw new HttpError(503, 'WALLET_NOT_FOUND', '账户余额信息暂不可用。');
  return { balance: wallet.balance, frozen: wallet.frozen, available: wallet.balance - wallet.frozen, currency: 'CNY', unit: 'micro-yuan' };
}
export function moneyValue(value: string, positive = false): bigint {
  if (!/^(?:0|[1-9]\d{0,15})$/.test(value)) throw new HttpError(400, 'INVALID_AMOUNT', '金额必须为有效整数微元。');
  const amount = BigInt(value);
  if (amount > 9_000_000_000_000_000n || (positive && amount === 0n)) throw new HttpError(400, 'INVALID_AMOUNT', '金额超出允许范围。');
  return amount;
}

const storedReservation = z.object({ id: z.string(), user_id: z.string(), key_id: z.string(), route_id: z.string(), task_id: z.string(),
  idempotency_key: z.string(), request_hash: z.string(), status: z.string(), authorized: z.string(), charged: z.string(),
  price_snapshot: z.unknown(), usage: z.unknown().nullable(), result_blob_id: z.string().nullable(), created_at: z.string(), updated_at: z.string(), reconcile_at: z.string() });
function reservationResult(value: unknown): typeof reservations.$inferSelect {
  const row = storedReservation.parse(value);
  return { id: row.id, userId: row.user_id, keyId: row.key_id, routeId: row.route_id, taskId: row.task_id, idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash, status: row.status, authorized: BigInt(row.authorized), charged: BigInt(row.charged), priceSnapshot: row.price_snapshot,
    usage: row.usage, resultBlobId: row.result_blob_id, createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at), reconcileAt: new Date(row.reconcile_at) };
}
function financialError(error: unknown): never {
  let cause = error;
  while (cause instanceof Error && cause.cause instanceof Error) cause = cause.cause;
  const known: Record<string, [number, string]> = { KEY_DISABLED: [403, '账户或 API Key 已停用。'], WALLET_NOT_FOUND: [503, '账户余额信息暂不可用。'],
    INSUFFICIENT_BALANCE: [402, '可用余额不足，请充值后重试。'], KEY_LIMIT_EXCEEDED: [402, '本 Key 的可用额度不足。'],
    IDEMPOTENCY_CONFLICT: [409, '同一请求标识不能用于不同的调用。'], SETTLEMENT_CONFLICT: [409, '调用已按其他结果结算。'],
    CALL_NOT_FOUND: [404, '调用记录不存在。'], INVALID_AUTHORIZATION: [400, '授权参数无效。'], INVALID_SETTLEMENT: [400, '结算金额超出授权额度。'],
    DATABASE_LOCK_BUSY: [503, '当前操作较多，请稍后重试。'] };
  const entry = cause instanceof Error ? known[cause.message] : undefined;
  if (entry && cause instanceof Error) throw new HttpError(entry[0], cause.message, entry[1]);
  throw error;
}

/** The database performs all locks, invariant checks and mutations in one statement. */
export async function authorizeUsage(input: { userId: string; keyId: string; routeId: string; taskId: string; idempotencyKey: string;
  requestHash: string; authorized: bigint; priceSnapshot: Record<string, unknown> }) {
  try {
    const fn = sql`${sql.identifier(namespace.schemaName)}.${sql.identifier('authorize_usage')}`;
    const [result] = await database().db.execute<{ result: { reservation: unknown; replay: boolean } }>(sql`select ${fn}(${input.userId}::text, ${input.keyId}::text, ${input.routeId}::text,
      ${input.taskId}::text, ${input.idempotencyKey}::text, ${input.requestHash}::text, ${input.authorized.toString()}::bigint, ${JSON.stringify(input.priceSnapshot)}::jsonb) as result`);
    return { reservation: reservationResult(result.result.reservation), replay: result.result.replay };
  } catch (error) { return financialError(error); }
}

export async function finishUsage(input: { userId: string; reservationId: string; charged: bigint; usage: Record<string, unknown>; release?: boolean }) {
  try {
    const fn = sql`${sql.identifier(namespace.schemaName)}.${sql.identifier('finish_usage')}`;
    const [result] = await database().db.execute<{ result: unknown }>(sql`select ${fn}(${input.userId}::text, ${input.reservationId}::text,
      ${input.charged.toString()}::bigint, ${JSON.stringify(input.usage)}::jsonb, ${!!input.release}::boolean) as result`);
    return reservationResult(result.result);
  } catch (error) { return financialError(error); }
}

export async function walletLedger(userId: string, offset: number, limit: number) {
  return database().db.select().from(ledger).where(eq(ledger.userId, userId)).orderBy(sql`${ledger.createdAt} desc`, sql`${ledger.id} desc`).limit(limit).offset(offset);
}
