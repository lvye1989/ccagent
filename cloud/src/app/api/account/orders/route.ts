import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireSession } from '@/core/auth';
import { database } from '@/core/db';
import { orders } from '@/core/db/schema';
import { createRechargeOrder } from '@/core/payments';
import { errorResponse, json, pagination, readJson, requireSameOrigin } from '@/core/http';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const { user } = await requireSession(request.headers), url = new URL(request.url), paging = pagination(url), orderId = url.searchParams.get('id');
    const rows = await database().db.select({ id: orders.id, amountFen: orders.amountFen, status: orders.status, createdAt: orders.createdAt, creditedAt: orders.creditedAt })
      .from(orders).where(and(eq(orders.userId, user.id), orderId ? eq(orders.id, orderId) : undefined)).orderBy(sql`${orders.createdAt} desc`).limit(paging.pageSize).offset(paging.offset);
    return json({ orders: rows, page: paging.page, pageSize: paging.pageSize });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const { user } = await requireSession(request.headers);
    const input = z.object({ amount: z.string().min(1).max(16) }).strict().parse(await readJson(request));
    return json(await createRechargeOrder(user.id, input.amount), 201);
  } catch (error) { return errorResponse(error); }
}
