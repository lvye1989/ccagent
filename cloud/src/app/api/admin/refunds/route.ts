import { z } from 'zod';
import { requirePermission } from '@/core/auth';
import { paymentService } from '@/core/payments';
import { errorResponse, json, readJson, requireSameOrigin } from '@/core/http';

export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const { user } = await requirePermission(request.headers, 'refunds.write');
    const input = z.object({ orderId: z.string().regex(/^\d{1,32}$/), reason: z.string().trim().min(5).max(200) }).strict().parse(await readJson(request));
    return json({ refund: await paymentService().requestRefund(input.orderId, user.id, input.reason) });
  } catch (error) { return errorResponse(error); }
}
export async function PUT(request: Request) {
  try {
    requireSameOrigin(request);
    const { user } = await requirePermission(request.headers, 'refunds.write');
    const input = z.object({ refundId: z.string().uuid(), outcome: z.enum(['success', 'rejected']), evidence: z.string().trim().min(10).max(300) }).strict().parse(await readJson(request));
    return json({ refund: await paymentService().resolveRefund(input.refundId, input.outcome, user.id, input.evidence) });
  } catch (error) { return errorResponse(error); }
}
