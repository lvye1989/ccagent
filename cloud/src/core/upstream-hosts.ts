import dns from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { database, type DatabaseReader } from './db';
import { settings } from './db/schema';
import { HttpError } from './http';

export const upstreamHostsKey = 'gateway.allowed_upstream_hosts';
const builtins = ['api.deepseek.com', 'openrouter.ai', 'api.tavily.com', 'api.bochaai.com', 'dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com', 'api.kie.ai'];
const denied = () => new HttpError(400, 'UPSTREAM_HOST_NOT_ALLOWED', '请使用已批准的公开 HTTPS 上游域名。');
export function normalizeUpstreamHost(value: string): string {
  const host = value.trim().toLowerCase();
  if (host.length > 253 || isIP(host) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
    || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|arpa)$/.test(host) || /(?:^|\.)metadata(?:\.|$)/.test(host)) throw denied();
  return host;
}
function upstreamUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw denied(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || (url.port && url.port !== '443')) throw denied();
  if (normalizeUpstreamHost(url.hostname) !== url.hostname) throw denied();
  return url;
}
export function trustedUpstreamHosts(): string[] {
  const names = (process.env.CCAGENT_ALLOWED_UPSTREAM_HOSTS || '').split(',').filter(Boolean).flatMap(value => {
    try { return [normalizeUpstreamHost(value)]; } catch { return []; }
  });
  return [...new Set([...builtins, ...names])].sort();
}
// Kept synchronous for existing callers that validate the legacy trusted list.
export function validateTrustedUpstreamHost(value: string): void {
  if (!trustedUpstreamHosts().includes(upstreamUrl(value).hostname)) throw denied();
}
export function isPublicUpstreamAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127
      || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) === 6) {
    const [first, second = '0'] = address.toLowerCase().split(':');
    const a = parseInt(first, 16), b = parseInt(second || '0', 16);
    // Global unicast only; exclude transition, special-purpose and documentation ranges.
    return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) && !(a === 0x3fff && b < 0x1000);
  }
  return false;
}
export async function publicUpstreamAddresses(host: string) {
  normalizeUpstreamHost(host);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([dns.lookup(host, { all: true, verbatim: true }), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(denied()), 5000);
    })]);
    if (!records.length || records.some(record => !isPublicUpstreamAddress(record.address))) throw denied();
    return records;
  } catch { throw denied(); }
  finally { if (timer) clearTimeout(timer); }
}
export async function readApprovedUpstreamHosts(reader: DatabaseReader = database().db) {
  const [row] = await reader.select().from(settings).where(eq(settings.key, upstreamHostsKey)).limit(1);
  if (!row) return { allowedHosts: [] as string[], version: 0 };
  const parsed = z.object({ allowedHosts: z.array(z.string()).max(50) }).strict().safeParse(row.value);
  if (!parsed.success) throw new HttpError(503, 'INVALID_UPSTREAM_HOST_CONFIGURATION', '上游域名配置需要管理员核对。');
  return { allowedHosts: [...new Set(parsed.data.allowedHosts.map(normalizeUpstreamHost))].sort(), version: row.version };
}
export async function assertUpstreamHost(value: string, reader: DatabaseReader = database().db): Promise<'trusted' | 'custom'> {
  const url = upstreamUrl(value);
  if (trustedUpstreamHosts().includes(url.hostname)) return 'trusted';
  if (!(await readApprovedUpstreamHosts(reader)).allowedHosts.includes(url.hostname)) throw denied();
  await publicUpstreamAddresses(url.hostname);
  return 'custom';
}

/** Custom DB-approved hosts always use validated DNS answers for the actual TLS connection. */
export async function requestUpstream(value: string, init: RequestInit, legacyFetch: typeof fetch = fetch): Promise<Response> {
  init.signal?.throwIfAborted();
  if (await assertUpstreamHost(value) === 'trusted') return legacyFetch(value, init);
  const url = upstreamUrl(value), records = await publicUpstreamAddresses(url.hostname);
  const pinned = records.find(record => record.family === 4) || records[0];
  init.signal?.throwIfAborted();
  const headers = Object.fromEntries(new Headers(init.headers));
  if (Object.keys(headers).some(name => ['host', 'connection', 'transfer-encoding'].includes(name))) throw denied();
  if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') throw new HttpError(400, 'INVALID_UPSTREAM_BODY', '上游请求格式无效。');
  return new Promise<Response>((resolve, reject) => {
    const request = https.request(url, { method: init.method || 'GET', headers, rejectUnauthorized: true, agent: false,
      servername: url.hostname, family: pinned.family, signal: init.signal || undefined,
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family) }, incoming => {
      try {
        const status = incoming.statusCode || 502;
        if (status >= 300 && status < 400) { incoming.destroy(); reject(new HttpError(502, 'UPSTREAM_REDIRECT_NOT_ALLOWED', '上游不允许重定向。')); return; }
        if (status < 200 || status > 599) throw new Error('INVALID_STATUS');
        const responseHeaders = new Headers();
        for (const [name, values] of Object.entries(incoming.headers)) if (values !== undefined && name !== 'set-cookie') {
          for (const item of Array.isArray(values) ? values : [values]) responseHeaders.append(name, item);
        }
        const body = [204, 205].includes(status) ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        if (body === null) incoming.resume();
        resolve(new Response(body, { status, headers: responseHeaders }));
      } catch {
        incoming.destroy(); reject(new HttpError(502, 'UPSTREAM_RESPONSE_INVALID', '上游响应格式无效。'));
      }
    });
    request.on('error', () => reject(new HttpError(502, 'UPSTREAM_TRANSPORT_FAILED', '上游连接未完成。')));
    request.end(init.body || undefined);
  });
}

/** Supplier task queries and image downloads: validate and pin every DNS answer, including known hosts. */
export async function requestPublicHttps(value: string, init: RequestInit, options: { allowedHosts?: readonly string[]; allowQuery?: boolean } = {}): Promise<Response> {
  init.signal?.throwIfAborted();
  let url: URL; try { url = new URL(value); } catch { throw denied(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443' || !options.allowQuery && url.search) throw denied();
  const host = normalizeUpstreamHost(url.hostname);
  if (options.allowedHosts && !options.allowedHosts.includes(host)) throw denied();
  const records = await publicUpstreamAddresses(host), pinned = records.find(item => item.family === 4) || records[0]!;
  const headers = Object.fromEntries(new Headers(init.headers));
  if (Object.keys(headers).some(name => ['host', 'connection', 'transfer-encoding', 'cookie'].includes(name))) throw denied();
  if (init.body !== undefined && init.body !== null && typeof init.body !== 'string' && !(init.body instanceof Uint8Array)) throw new HttpError(400, 'INVALID_UPSTREAM_BODY', '上游请求格式无效。');
  init.signal?.throwIfAborted();
  return new Promise<Response>((resolve, reject) => {
    const request = https.request(url, { method: init.method || 'GET', headers, rejectUnauthorized: true, agent: false,
      servername: host, family: pinned.family, signal: init.signal || undefined,
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family) }, incoming => {
      try {
      const status = incoming.statusCode || 502;
      if (status >= 300 && status < 400) { incoming.destroy(); reject(new HttpError(502, 'UPSTREAM_REDIRECT_NOT_ALLOWED', '上游不允许重定向。')); return; }
      if (status < 200 || status > 599) throw new Error('INVALID_STATUS');
      const responseHeaders = new Headers();
      for (const [name, values] of Object.entries(incoming.headers)) if (values !== undefined && name !== 'set-cookie') for (const item of Array.isArray(values) ? values : [values]) responseHeaders.append(name, item);
      const body = [204, 205].includes(status) ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      if (!body) incoming.resume();
      resolve(new Response(body, { status, headers: responseHeaders }));
      } catch { incoming.destroy(); reject(new HttpError(502, 'UPSTREAM_RESPONSE_INVALID', '上游响应格式无效。')); }
    });
    request.on('error', () => reject(new HttpError(502, 'UPSTREAM_TRANSPORT_FAILED', '上游连接未完成。')));
    request.end(init.body || undefined);
  });
}
