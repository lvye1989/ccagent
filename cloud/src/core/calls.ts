import { and, eq, gt } from 'drizzle-orm';
import { requireSession } from './auth';
import { database } from './db';
import { blobs, reservations } from './db/schema';
import { HttpError } from './http';
import { callIdentifierPattern } from './call-identifiers';

/** A revoked platform Key does not hide its owner's previous billing records. */
export async function ownedCallStatus(request: Request, requestId: string) {
  const { user } = await requireSession(request.headers);
  if (!callIdentifierPattern.test(requestId)) throw new HttpError(400, 'INVALID_CALL_ID', '调用标识无效。');
  const [record] = await database().db.select({ id: reservations.id, routeId: reservations.routeId, taskId: reservations.taskId,
    requestId: reservations.idempotencyKey, status: reservations.status, authorized: reservations.authorized, charged: reservations.charged,
    priceSnapshot: reservations.priceSnapshot, usage: reservations.usage, createdAt: reservations.createdAt, updatedAt: reservations.updatedAt,
    resultId: reservations.resultBlobId }).from(reservations).where(and(eq(reservations.userId, user.id), eq(reservations.idempotencyKey, requestId))).limit(1);
  if (!record) throw new HttpError(404, 'CALL_NOT_FOUND', '调用记录不存在。');
  const [result] = record.resultId ? await database().db.select({ expiresAt: blobs.expiresAt }).from(blobs)
    .where(and(eq(blobs.id, record.resultId), eq(blobs.userId, user.id), eq(blobs.status, 'ready'), gt(blobs.expiresAt, new Date()))).limit(1) : [];
  const { resultId: _privateId, ...publicRecord } = record;
  const usage = record.usage && typeof record.usage === 'object' ? record.usage as Record<string, unknown> : {};
  // Supplier task handles and finalization leases remain server-private.
  if (usage.imageTask && typeof usage.imageTask === 'object') {
    const task = usage.imageTask as Record<string, unknown>;
    publicRecord.usage = { ...usage, imageTask: { status: task.status, ...(typeof task.code === 'string' ? { code: task.code } : {}) } };
  }
  return { ...publicRecord, executedRouteId: typeof usage.executedRouteId === 'string' && /^[a-z0-9][a-z0-9._:-]{0,79}$/.test(usage.executedRouteId) ? usage.executedRouteId
    : typeof usage.attempts === 'number' && Number.isSafeInteger(usage.attempts) && usage.attempts > 0 ? record.routeId : null,
    fallbackUsed: usage.fallbackUsed === true, resultAvailable: Boolean(result), resultExpiresAt: result?.expiresAt ?? null };
}
