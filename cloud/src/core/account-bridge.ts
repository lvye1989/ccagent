import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { database } from './db';
import * as tables from './db/schema';
import { authEnvironment } from './env';
import { HttpError } from './http';

const nonceCookie = '__Host-ccagent.account_bridge';
const fallbackCookie = (channel: string) => nonceCookie + '.' + channel;
const randomValue = /^[A-Za-z0-9_-]{43}$/;
const targets = ['/account', '/account/billing', '/account/keys', '/account/usage', '/admin'] as const;
const stateSchema = z.object({ v: z.literal(1), clientOrigin: z.string().max(100), target: z.enum(targets),
  channel: z.string().regex(randomValue), browserHash: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.number().int(), expiresAt: z.number().int() }).strict();
type BridgeState = z.infer<typeof stateSchema>;
type SourceSession = { user: { id: string }; session: { id: string; expiresAt: Date } };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const invalid = () => new HttpError(400, 'ACCOUNT_BRIDGE_INVALID', '账户连接无效或已过期，请从应用重新打开。');
const sourceInvalid = () => new HttpError(401, 'ACCOUNT_BRIDGE_SESSION_EXPIRED', '应用登录已失效，请重新登录后打开账户中心。');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function accountBridgeClientOrigin(value: string): string {
  const match = /^http:\/\/(127\.0\.0\.1|localhost):([1-9][0-9]{0,4})$/.exec(value);
  if (!match || Number(match[2]) > 65535) throw invalid();
  try { if (new URL(value).origin !== value) throw invalid(); } catch { throw invalid(); }
  return value;
}
function signState(payload: string): string {
  return createHmac('sha256', authEnvironment().secret).update('ccagent-account-bridge:v1\0').update(payload).digest('base64url');
}
export function readAccountBridgeState(value: unknown): BridgeState {
  if (typeof value !== 'string' || value.length > 8192) throw invalid();
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match || !same(signState(match[1]), match[2])) throw invalid();
  try {
    const state = stateSchema.parse(JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')));
    accountBridgeClientOrigin(state.clientOrigin);
    const now = Date.now();
    if (state.expiresAt <= now || state.issuedAt > now + 5000 || state.expiresAt <= state.issuedAt || state.expiresAt - state.issuedAt > 120000) throw invalid();
    return state;
  } catch { throw invalid(); }
}
function cookieNonce(headers: Headers, name: string): string | undefined {
  const matches = (headers.get('cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) throw invalid();
  const value = matches[0].slice(name.length + 1);
  if (!randomValue.test(value)) throw invalid();
  return value;
}

export function accountBridgePage(request: Request): Response {
  const url = new URL(request.url);
  const configuredOrigin = new URL(authEnvironment().origin);
  // Next may use an internal hostname in Request.url. Never derive a destination
  // from forwarded headers; require the browser-facing Host to match configuration.
  const host = request.headers.get('host');
  if (host ? host !== configuredOrigin.host : url.origin !== configuredOrigin.origin) throw invalid();
  const allowed = new Set(['clientOrigin', 'target', 'channel']);
  if ([...url.searchParams.keys()].some(key => !allowed.has(key) || url.searchParams.getAll(key).length !== 1)) throw invalid();
  const clientOrigin = accountBridgeClientOrigin(url.searchParams.get('clientOrigin') || '');
  const target = z.enum(targets).safeParse(url.searchParams.get('target'));
  const channel = url.searchParams.get('channel') || '';
  if (!target.success || !randomValue.test(channel)) throw invalid();
  const sharedNonce = cookieNonce(request.headers, nonceCookie);
  const nonce = sharedNonce || randomBytes(32).toString('base64url');
  const now = Date.now();
  const data: BridgeState = { v: 1, clientOrigin, target: target.data, channel, browserHash: hash(nonce), issuedAt: now, expiresAt: now + 120000 };
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const state = payload + '.' + signState(payload);
  const cspNonce = randomBytes(24).toString('base64');
  const config = JSON.stringify({ clientOrigin, channel, state }).replaceAll('<', '\\u003c');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>正在连接账户中心 · CCAGENT</title>
<style nonce="${cspNonce}">body{font:16px system-ui,sans-serif;background:#f5f7fb;color:#213656;margin:0;display:grid;min-height:100vh;place-items:center}main{max-width:28rem;padding:32px}h1{font-size:24px}p{line-height:1.7;color:#56647b}</style>
<main><h1>正在连接账户中心</h1><p id="status" role="status">正在验证应用登录，请保持此窗口打开。</p></main>
<script nonce="${cspNonce}">(()=>{'use strict';const config=${config};const status=document.getElementById('status');const opener=window.opener;let pending=false;let complete=false;
if(!opener){status.textContent='请从 CCAGENT 应用中的账户入口打开此页面。';return;}
function ready(){if(!pending&&!complete)opener.postMessage({type:'ccagent:account-bridge-ready',channel:config.channel,state:config.state},config.clientOrigin);}
const repeat=setInterval(ready,700);const timeout=setTimeout(()=>{clearInterval(repeat);if(!complete)status.textContent='连接已过期，请从应用重新打开账户中心。';},120000);
window.addEventListener('message',async event=>{const data=event.data;if(event.source!==opener||event.origin!==config.clientOrigin||!data||data.type!=='ccagent:account-bridge-ticket'||data.channel!==config.channel||data.state!==config.state||typeof data.ticket!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.ticket)||pending||complete)return;pending=true;clearInterval(repeat);
try{const response=await fetch('/api/account/bridge/consume',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({state:config.state,ticket:data.ticket})});const result=await response.json();if(!response.ok||!['/account','/account/billing','/account/keys','/account/usage','/admin'].includes(result.target))throw new Error('BRIDGE_FAILED');complete=true;clearTimeout(timeout);opener.postMessage({type:'ccagent:account-bridge-complete',channel:config.channel},config.clientOrigin);window.opener=null;window.location.replace(result.target);}catch{status.textContent='账户连接未完成，请检查应用登录状态并重新打开账户中心。';}});ready();})();</script></html>`;
  const response = new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${cspNonce}'; style-src 'nonce-${cspNonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'unsafe-none',
    'set-cookie': `${nonceCookie}=${nonce}; Path=/; Max-Age=120; HttpOnly; Secure; SameSite=Lax` } });
  // Two initial requests can both arrive before the first shared Set-Cookie is
  // installed. Only these first requests need a channel-scoped fallback.
  if (!sharedNonce) response.headers.append('set-cookie', `${fallbackCookie(channel)}=${nonce}; Path=/; Max-Age=120; HttpOnly; Secure; SameSite=Lax`);
  return response;
}

export async function issueAccountBridge(stateInput: unknown, source: SourceSession) {
  const state = readAccountBridgeState(stateInput);
  const ticket = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Math.min(Date.now() + 60000, state.expiresAt, source.session.expiresAt.getTime()));
  if (expiresAt.getTime() <= Date.now()) throw sourceInvalid();
  const stateHash = hash(stateInput as string);
  await database().db.insert(tables.verification).values({ id: `account-bridge:${stateHash}:${hash(ticket)}`,
    identifier: 'account-bridge:' + stateHash, value: JSON.stringify({ stateHash, sessionId: source.session.id, userId: source.user.id }), expiresAt });
  return { ticket, expiresAt: expiresAt.toISOString() };
}

export async function consumeAccountBridge(stateInput: unknown, ticket: unknown, headers: Headers) {
  const state = readAccountBridgeState(stateInput);
  const sharedNonce = cookieNonce(headers, nonceCookie);
  const fallback = cookieNonce(headers, fallbackCookie(state.channel));
  const bound = (sharedNonce && same(hash(sharedNonce), state.browserHash)) || (fallback && same(hash(fallback), state.browserHash));
  if (!bound || typeof ticket !== 'string' || !randomValue.test(ticket)) throw invalid();
  const stateHash = hash(stateInput as string);
  const result = await database().db.transaction(async tx => {
    const [record] = await tx.delete(tables.verification).where(and(
      eq(tables.verification.id, `account-bridge:${stateHash}:${hash(ticket)}`),
      eq(tables.verification.identifier, 'account-bridge:' + stateHash), gt(tables.verification.expiresAt, new Date()))).returning();
    if (!record) return null;
    const saved = z.object({ stateHash: z.string(), sessionId: z.string(), userId: z.string() }).strict().safeParse(JSON.parse(record.value));
    if (!saved.success || !same(saved.data.stateHash, stateHash)) return null;
    const [live] = await tx.select({ session: tables.session, user: tables.user }).from(tables.session)
      .innerJoin(tables.user, eq(tables.session.userId, tables.user.id)).where(and(
        eq(tables.session.id, saved.data.sessionId), eq(tables.session.userId, saved.data.userId),
        gt(tables.session.expiresAt, new Date()), eq(tables.user.emailVerified, true), eq(tables.user.banned, false))).for('share');
    return live ? { sessionId: live.session.id, userId: live.user.id, target: state.target,
      clearFallbackCookie: `${fallbackCookie(state.channel)}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } : null;
  });
  if (!result) throw sourceInvalid();
  return result;
}

// Only the Next.js consume route calls this server API. Its HTTP path is also
// excluded by the auth route allowlist, and the SDK handler rejects HTTP calls.
export function accountBridgePlugin() {
  return { id: 'ccagent-account-bridge', endpoints: {
    setAccountBridgeSession: createAuthEndpoint('/account-bridge/session', { method: 'POST',
      body: z.object({ sessionId: z.string().min(1).max(200), userId: z.string().min(1).max(200) }).strict() }, async context => {
      if (context.request) throw context.error('FORBIDDEN', { code: 'ACCOUNT_BRIDGE_INTERNAL_ONLY', message: '账户连接请求无效。' });
      const [live] = await database().db.select({ session: tables.session, user: tables.user }).from(tables.session)
        .innerJoin(tables.user, eq(tables.session.userId, tables.user.id)).where(and(
          eq(tables.session.id, context.body.sessionId), eq(tables.session.userId, context.body.userId),
          gt(tables.session.expiresAt, new Date()), eq(tables.user.emailVerified, true), eq(tables.user.banned, false))).limit(1);
      if (!live) throw context.error('UNAUTHORIZED', { code: 'ACCOUNT_BRIDGE_SESSION_EXPIRED', message: '应用登录已失效，请重新登录。' });
      await setSessionCookie(context, live, false, { maxAge: Math.max(1, Math.floor((live.session.expiresAt.getTime() - Date.now()) / 1000)) });
      return context.json({ ok: true });
    }),
  } };
}
