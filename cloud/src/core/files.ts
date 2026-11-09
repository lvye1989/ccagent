import { createHash, randomUUID } from 'node:crypto';
import { and, eq, lte, ne } from 'drizzle-orm';
import { del, get, head, issueSignedToken, presignUrl, put } from '@vercel/blob';
import { z } from 'zod';
import { database } from './db';
import { blobs } from './db/schema';
import { HttpError } from './http';

const lifetimeMs = 15 * 60 * 1000;
const uploadLifetimeMs = 2 * 60 * 1000;
const limits = { request: 32 * 1024 * 1024, image: 30 * 1024 * 1024, audio: 50 * 1024 * 1024 } as const;
const types = {
  request: ['application/json'], image: ['image/png', 'image/jpeg', 'image/webp'], audio: ['audio/wav', 'audio/mpeg', 'audio/webm', 'audio/ogg', 'audio/mp4'],
} as const;
const suffix: Record<string, string> = { 'application/json': 'json', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'text/event-stream': 'sse', 'text/plain': 'txt' };
export const uploadInput = z.object({ purpose: z.enum(['request', 'image', 'audio']), contentType: z.string().max(80), size: z.number().int().min(1).max(50 * 1024 * 1024) }).strict().superRefine((value, context) => {
  if (!(types[value.purpose] as readonly string[]).includes(value.contentType) || value.size > limits[value.purpose]) context.addIssue({ code: 'custom', message: 'Unsupported content type or size' });
});
function ownerPrefix(userId: string) { return `ccagent/users/${createHash('sha256').update(userId).digest('hex').slice(0, 32)}/`; }
function checkedPath(record: Pick<typeof blobs.$inferSelect, 'pathname' | 'userId'>): string {
  if (!record.pathname.startsWith(ownerPrefix(record.userId)) || !/^ccagent\/users\/[a-f0-9]{32}\/(?:request|image|audio|result|voice-result)\/[a-f0-9-]{36}\.[a-z0-9]{2,5}$/.test(record.pathname)) throw new HttpError(503, 'INVALID_FILE_PATH', '文件记录需要核验。');
  return record.pathname;
}
function requireStorage() {
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) throw new HttpError(503, 'STORAGE_NOT_CONFIGURED', '文件服务尚未配置。');
}
export async function ownedFile(userId: string, id: string, allowedPurposes?: readonly string[], pending = false) {
  const [record] = await database().db.select().from(blobs).where(and(eq(blobs.id, id), eq(blobs.userId, userId))).limit(1);
  if (!record || ['deleted', 'purged'].includes(record.status)) throw new HttpError(404, 'FILE_NOT_FOUND', '文件不存在。');
  if (record.expiresAt.getTime() <= Date.now()) throw new HttpError(410, 'FILE_EXPIRED', '临时文件已过期，请重新上传。');
  if (allowedPurposes && !allowedPurposes.includes(record.purpose)) throw new HttpError(400, 'FILE_PURPOSE_MISMATCH', '文件用途与此次请求不符。');
  if (!pending && record.status !== 'ready') throw new HttpError(409, 'FILE_NOT_READY', '文件尚未完成上传。');
  checkedPath(record);
  return record;
}
export async function initializeUpload(userId: string, input: z.infer<typeof uploadInput>) {
  requireStorage();
  const valid = uploadInput.parse(input), id = randomUUID(), pathname = `${ownerPrefix(userId)}${valid.purpose}/${id}.${suffix[valid.contentType]}`;
  const expiresAt = new Date(Date.now() + lifetimeMs), validUntil = Date.now() + uploadLifetimeMs;
  await database().db.insert(blobs).values({ id, userId, pathname, purpose: valid.purpose, contentType: valid.contentType, size: valid.size, expiresAt });
  const token = await issueSignedToken({ pathname, operations: ['put'], validUntil, allowedContentTypes: [valid.contentType], maximumSizeInBytes: valid.size });
  const signed = await presignUrl(token, { access: 'private', operation: 'put', pathname, validUntil, allowedContentTypes: [valid.contentType], maximumSizeInBytes: valid.size,
    addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 60 });
  // Only this scoped, short-lived PUT URL leaves the server; never return store credentials.
  return { id, upload: { url: signed.presignedUrl, method: 'PUT' as const, contentType: valid.contentType,
    headers: { 'content-type': valid.contentType, 'x-content-type': valid.contentType }, validUntil }, expiresAt: expiresAt.toISOString() };
}
export async function completeUpload(userId: string, id: string) {
  requireStorage();
  const record = await ownedFile(userId, id, ['request', 'image', 'audio'], true);
  if (record.status === 'ready') return { id, ready: true, expiresAt: record.expiresAt };
  const actual = await head(checkedPath(record), { abortSignal: AbortSignal.timeout(15000) });
  if (actual.pathname !== record.pathname || actual.size !== record.size || actual.contentType.split(';')[0] !== record.contentType) throw new HttpError(400, 'UPLOAD_MISMATCH', '上传文件的大小或类型与申请不符。');
  const result = await database().db.update(blobs).set({ status: 'ready' }).where(and(eq(blobs.id, id), eq(blobs.userId, userId), eq(blobs.status, 'pending'))).returning({ id: blobs.id });
  if (!result.length) await ownedFile(userId, id);
  return { id, ready: true, expiresAt: record.expiresAt };
}
export async function readOwnedFile(userId: string, id: string, allowedPurposes?: readonly string[]) {
  requireStorage();
  const record = await ownedFile(userId, id, allowedPurposes);
  const result = await get(checkedPath(record), { access: 'private', useCache: false, abortSignal: AbortSignal.timeout(30000) });
  if (!result || result.statusCode !== 200) throw new HttpError(404, 'FILE_NOT_FOUND', '文件不存在。');
  if (result.blob.contentType.split(';')[0] !== record.contentType) { await result.stream.cancel(); throw new HttpError(503, 'FILE_TYPE_MISMATCH', '文件类型需要核验。'); }
  // CDN compression or chunked delivery can omit/change Content-Length. Check decoded bytes instead.
  const reader = result.stream.getReader(); let size = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) {
          if (size !== record.size) throw new HttpError(503, 'FILE_SIZE_MISMATCH', '文件内容需要核验。');
          controller.close(); return;
        }
        size += item.value.byteLength;
        if (size > record.size) throw new HttpError(503, 'FILE_SIZE_MISMATCH', '文件内容需要核验。');
        controller.enqueue(item.value);
      } catch (error) { await reader.cancel().catch(() => {}); controller.error(error); }
    },
    async cancel(reason) { await reader.cancel(reason); },
  });
  return { record, stream };
}
export async function deleteOwnedFile(userId: string, id: string) {
  requireStorage();
  const [record] = await database().db.select().from(blobs).where(and(eq(blobs.id, id), eq(blobs.userId, userId))).limit(1);
  if (!record) throw new HttpError(404, 'FILE_NOT_FOUND', '文件不存在。');
  if (record.status === 'purged') return;
  await del(checkedPath(record), { abortSignal: AbortSignal.timeout(15000) });
  await database().db.update(blobs).set({ status: 'deleted' }).where(eq(blobs.id, id));
}
export async function savePrivateResult(userId: string, body: Uint8Array | string, contentType: string, purpose: 'result' | 'voice-result' = 'result') {
  requireStorage();
  const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
  if (!bytes.length || bytes.length > 64 * 1024 * 1024 || !suffix[contentType]) throw new HttpError(400, 'INVALID_RESULT', '结果文件超出允许范围。');
  const id = randomUUID(), pathname = `${ownerPrefix(userId)}${purpose}/${id}.${suffix[contentType]}`, expiresAt = new Date(Date.now() + lifetimeMs);
  // Persist metadata first so interrupted uploads are still discoverable by expiry cleanup.
  await database().db.insert(blobs).values({ id, userId, pathname, purpose, contentType, size: bytes.length, expiresAt });
  const result = await put(pathname, bytes, { access: 'private', contentType, addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 60, abortSignal: AbortSignal.timeout(30000) });
  if (result.pathname !== pathname) throw new HttpError(503, 'FILE_PATH_MISMATCH', '结果文件保存需要核验。');
  await database().db.update(blobs).set({ status: 'ready' }).where(eq(blobs.id, id));
  return { id, expiresAt };
}
export async function cleanupExpiredFiles(limit = 100, deadline = Infinity) {
  requireStorage();
  const expired = await database().db.select().from(blobs).where(and(lte(blobs.expiresAt, new Date()), ne(blobs.status, 'purged'))).orderBy(blobs.expiresAt).limit(Math.min(Math.max(limit, 1), 100));
  let deleted = 0, deferred = 0;
  for (const record of expired) {
    if (Date.now() >= deadline) { deferred += expired.length - deleted - deferred; break; }
    try {
      await del(checkedPath(record), { abortSignal: AbortSignal.timeout(10000) });
      await database().db.update(blobs).set({ status: 'purged' }).where(eq(blobs.id, record.id));
      deleted++;
    } catch { deferred++; }
  }
  return { examined: expired.length, deleted, deferred };
}
