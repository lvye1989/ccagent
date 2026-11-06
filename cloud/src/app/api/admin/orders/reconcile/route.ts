import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { database } from '@/core/db';
import { audit } from '@/core/db/schema';
import { requirePermission } from '@/core/auth';
import { paymentService } from '@/core/payments';
import { errorResponse, json, readJson, requireSameOrigin } from '@/core/http';

export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const actor = await requirePermission(request.headers, 'orders.read');
    const input = z.object({ orderId: z.string().regex(/^\d{1,32}$/) }).strict().parse(await readJson(request));
    const result = await paymentService().reconcileOrder(input.orderId);
    await database().db.insert(audit).values({ id: randomUUID(), actorId: actor.user.id, action: 'orders.reconcile', objectId: input.orderId, result: result.status });
    return json(result);
  } catch (error) { return errorResponse(error); }
}
