import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@/core/auth';
import { database } from '@/core/db';
import { audit, ledger, wallets } from '@/core/db/schema';
import { errorResponse, HttpError, json, readJson, requireSameOrigin } from '@/core/http';
import { moneyValue, postLedger } from '@/core/wallet';
import { lockAccount } from '@/core/database-locks';

const common = z.object({ userId: z.string().min(1).max(200), reason: z.string().trim().min(5).max(200), idempotencyKey: z.string().uuid() });
const adjustment = z.union([
  common.extend({ delta: z.string().regex(/^-?[1-9]\d{0,15}$/) }).strict(),
  common.extend({ targetBalance: z.string().regex(/^(?:0|[1-9]\d{0,15})$/) }).strict(),
]);
const conflict = () => new HttpError(409, 'IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同的余额调整。');

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const current = await requirePermission(request.headers, 'wallets.write');
    const input = adjustment.parse(await readJson(request));
    const target = 'targetBalance' in input ? moneyValue(input.targetBalance) : undefined;
    const absolute = 'delta' in input ? moneyValue(input.delta.replace(/^-/, ''), true) : undefined;
    const requestedDelta = 'delta' in input ? (input.delta.startsWith('-') ? -absolute! : absolute!) : undefined;
    const result = await database().db.transaction(async tx => {
      await lockAccount(tx, input.userId);
      // Runtime deliberately cannot UPDATE wallets; the shared account mutex serializes every financial writer.
      const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, input.userId));
      if (!wallet) throw new HttpError(503, 'WALLET_NOT_FOUND', '用户钱包不存在，请刷新用户列表后重试。');
      const reference = `adjustment:${input.idempotencyKey}`;
      const [savedLedger] = await tx.select().from(ledger).where(eq(ledger.reference, reference));
      const [savedAudit] = await tx.select().from(audit).where(eq(audit.id, input.idempotencyKey));
      const matches = (value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const metadata = value as Record<string, unknown>;
        return metadata.actorId === current.user.id && metadata.reason === input.reason && (target === undefined
          ? (metadata.mode === undefined || metadata.mode === 'delta') && metadata.delta === requestedDelta!.toString()
          : metadata.mode === 'set' && metadata.targetBalance === target.toString());
      };
      const recordAudit = async (metadata: Record<string, unknown>) => {
        const inserted = await tx.insert(audit).values({ id: input.idempotencyKey, actorId: current.user.id, action: 'wallets.adjustment', objectId: input.userId, result: 'success', metadata })
          .onConflictDoNothing().returning({ id: audit.id });
        if (!inserted.length) throw conflict();
      };
      if (savedAudit && (savedAudit.actorId !== current.user.id || savedAudit.action !== 'wallets.adjustment' || savedAudit.objectId !== input.userId || !matches(savedAudit.metadata))) throw conflict();
      if (savedLedger) {
        if (savedLedger.userId !== input.userId || savedLedger.kind !== 'adjustment' || savedLedger.frozenDelta !== 0n || !matches(savedLedger.metadata)) throw conflict();
        if (!savedAudit) await recordAudit(savedLedger.metadata as Record<string, unknown>);
        return { saved: true, changed: true, replayed: true, delta: savedLedger.balanceDelta, balance: savedLedger.balanceAfter, frozen: savedLedger.frozenAfter };
      }
      if (savedAudit) {
        const metadata = savedAudit.metadata as Record<string, unknown>;
        if (target === undefined || metadata.delta !== '0' || metadata.unchanged !== true) throw conflict();
        if (typeof metadata.frozen !== 'string') throw conflict();
        return { saved: true, changed: false, replayed: true, delta: '0', balance: target, frozen: moneyValue(metadata.frozen) };
      }
      const delta = target === undefined ? requestedDelta! : target - wallet.balance;
      const nextBalance = wallet.balance + delta;
      if (nextBalance < wallet.frozen) throw new HttpError(402, 'INSUFFICIENT_BALANCE', '调整后的总余额不能低于当前冻结金额。');
      moneyValue(nextBalance.toString());
      const metadata = { actorId: current.user.id, reason: input.reason, delta: delta.toString(),
        ...(target === undefined ? {} : { mode: 'set', targetBalance: target.toString(), ...(delta === 0n ? { unchanged: true, frozen: wallet.frozen.toString() } : {}) }) };
      // Audit is reserved before posting, in the same transaction: a cross-account UUID collision rolls everything back.
      await recordAudit(metadata);
      if (delta !== 0n) await postLedger(tx, input.userId, reference, 'adjustment', delta, 0n, metadata);
      return { saved: true, changed: delta !== 0n, replayed: false, delta, balance: nextBalance, frozen: wallet.frozen };
    });
    return json(result);
  } catch (error) { return errorResponse(error); }
}
