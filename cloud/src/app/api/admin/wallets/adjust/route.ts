import { z } from 'zod';
import { requirePermission } from '@/core/auth';
import { database } from '@/core/db';
import { audit } from '@/core/db/schema';
import { errorResponse, json, readJson, requireSameOrigin } from '@/core/http';
import { moneyValue, postLedger } from '@/core/wallet';

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const current = await requirePermission(request.headers, 'wallets.write');
    const input = z.object({ userId: z.string().min(1).max(200), delta: z.string().regex(/^-?[1-9]\d{0,15}$/), reason: z.string().trim().min(5).max(200), idempotencyKey: z.string().uuid() }).strict().parse(await readJson(request));
    const absolute = moneyValue(input.delta.replace(/^-/, ''), true), delta = input.delta.startsWith('-') ? -absolute : absolute;
    await database().db.transaction(async tx => {
      const metadata = { actorId: current.user.id, reason: input.reason, delta: delta.toString() };
      await postLedger(tx, input.userId, `adjustment:${input.idempotencyKey}`, 'adjustment', delta, 0n, metadata);
      await tx.insert(audit).values({ id: input.idempotencyKey, actorId: current.user.id, action: 'wallets.adjustment', objectId: input.userId, result: 'success', metadata }).onConflictDoNothing();
    });
    return json({ saved: true });
  } catch (error) { return errorResponse(error); }
}
