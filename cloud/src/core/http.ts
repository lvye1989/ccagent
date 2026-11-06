import { ZodError } from 'zod';
import { authEnvironment } from './env';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item),
    { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ code: error.code, message: error.message }, error.status);
  if (error instanceof ZodError) return json({ code: 'INVALID_INPUT', message: '请检查提交内容。', fields: [...new Set(error.issues.map(item => item.path.join('.')))] }, 400);
  console.error('PLATFORM_REQUEST_FAILED');
  return json({ code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用，请稍后重试。' }, 503);
}
export function requireSameOrigin(request: Request): void {
  if (request.headers.get('origin') !== authEnvironment().origin || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new HttpError(403, 'INVALID_ORIGIN', '请求来源无效。');
  }
}
export async function readJson(request: Request, limit = 65536): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) throw new HttpError(415, 'JSON_REQUIRED', '请使用 JSON 请求。');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'BODY_REQUIRED', '请求内容为空。');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, 'BODY_TOO_LARGE', '请求内容过大。'); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new HttpError(400, 'INVALID_JSON', '请求格式无效。'); }
}
export function pagination(url: URL) {
  const parsed = (key: string, fallback: number, max: number) => {
    const value = url.searchParams.get(key);
    if (value === null) return fallback;
    if (!/^[1-9]\d{0,6}$/.test(value) || Number(value) > max) throw new HttpError(400, 'INVALID_PAGINATION', '分页参数无效。');
    return Number(value);
  };
  const page = parsed('page', 1, 1000000), pageSize = parsed('pageSize', 20, 100);
  return { page, pageSize, offset: (page - 1) * pageSize };
}
