import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { requirePermission } from '@/core/auth';
import { database } from '@/core/db';
import { apiKeys, audit } from '@/core/db/schema';
import { errorResponse, HttpError, json, readJson, requireSameOrigin } from '@/core/http';
import { moneyValue } from '@/core/wallet';

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const current = await requirePermission(request.headers, 'keys.write');
    const input = z.discriminatedUnion('action', [z.object({ action: z.literal('revoke') }).strict(), z.object({ action: z.literal('limit'), limit: z.string().max(16).nullable() }).strict()]).parse(await readJson(request));
    const { id } = await context.params;
    await database().db.transaction(async tx => {
      const [key] = await tx.select().from(apiKeys).where(eq(apiKeys.id, id)).for('update');
      if (!key) throw new HttpError(404, 'KEY_NOT_FOUND', 'Key 不存在。');
      if (input.action === 'revoke') await tx.update(apiKeys).set({ enabled: false, revokedAt: new Date() }).where(eq(apiKeys.id, id));
      else {
        const limit = input.limit === null ? null : moneyValue(input.limit, true);
        if (limit !== null && limit < key.spent + key.frozen) throw new HttpError(400, 'LIMIT_BELOW_USAGE', '额度不能低于已使用金额与冻结额度之和。');
        await tx.update(apiKeys).set({ limit }).where(eq(apiKeys.id, id));
      }
      await tx.insert(audit).values({ id: randomUUID(), actorId: current.user.id, action: `keys.${input.action}`, objectId: id, result: 'success', metadata: input });
    });
    return json({ saved: true });
  } catch (error) { return errorResponse(error); }
}
