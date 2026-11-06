import { randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, lte } from 'drizzle-orm';
import { database } from './db';
import { audit, reservations } from './db/schema';
import { cleanupExpiredFiles } from './files';
import { HttpError } from './http';
import { reconcilePayments } from './payments';
import { finishUsage } from './wallet';

export function requireMaintenanceIdentity(request: Request): void {
  const secret = process.env.CRON_SECRET;
  if (!secret || !/^[A-Za-z0-9_-]{32,200}$/.test(secret)) throw new HttpError(503, 'MAINTENANCE_NOT_CONFIGURED', '维护服务尚未配置。');
  const expected = Buffer.from(`Bearer ${secret}`), actual = Buffer.from(request.headers.get('authorization') || '');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HttpError(401, 'MAINTENANCE_UNAUTHORIZED', '维护请求未获授权。');
}

/** One autocommit settlement per call preserves the key -> wallet -> reservation lock order. */
export async function releaseExpiredUsage(options: { limit?: number; deadline?: number } = {}) {
  const db = database().db;
  const expired = await db.select({ id: reservations.id, userId: reservations.userId }).from(reservations)
    .where(and(inArray(reservations.status, ['held', 'pending']), lte(reservations.reconcileAt, new Date())))
    .orderBy(reservations.reconcileAt).limit(Math.min(Math.max(options.limit ?? 100, 1), 200));
  let released = 0, deferred = 0, completed = 0;
  for (const item of expired) {
    if (Date.now() >= (options.deadline ?? Infinity)) { deferred += expired.length - completed; break; }
    try {
      await finishUsage({ userId: item.userId, reservationId: item.id, charged: 0n, release: true,
        usage: { reason: 'unmeasured_after_24h', platformAbsorbed: true, automatic: true } });
      released++;
    } catch (error) {
      // A measured settlement may have won the race; it must never be overwritten or charged again.
      if (!(error instanceof HttpError && error.code === 'SETTLEMENT_CONFLICT')) deferred++;
    }
    completed++;
  }
  return { examined: expired.length, released, deferred };
}

export async function runMaintenance() {
  const deadline = Date.now() + 210000;
  const jobs = await Promise.allSettled([
    releaseExpiredUsage({ deadline }),
    process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID ? cleanupExpiredFiles(100, deadline) : Promise.resolve({ skipped: 'storage_not_configured' }),
    process.env.ZPAY_PID && process.env.ZPAY_KEY ? reconcilePayments({ deadline }) : Promise.resolve({ skipped: 'payments_not_configured' }),
  ]);
  const names = ['usage', 'files', 'payments'] as const;
  const result = Object.fromEntries(jobs.map((job, index) => [names[index], job.status === 'fulfilled' ? job.value : { failed: true }]));
  const failed = jobs.some(job => job.status === 'rejected');
  await database().db.insert(audit).values({ id: randomUUID(), actorId: null, action: 'system.maintenance', objectId: 'scheduled',
    result: failed ? 'partial' : 'success', metadata: result });
  if (failed) throw new HttpError(503, 'MAINTENANCE_PARTIAL', '部分维护任务需要再次执行。');
  return result;
}
