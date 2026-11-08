import './load-env';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// Anonymous public smoke checks only. Never create a production user or issue a real ticket.
async function main() {
  const origin = 'https://ccagent-cloud.vercel.app';
  const query = new URLSearchParams({ clientOrigin: 'http://127.0.0.1:4174', target: '/account/keys', channel: randomBytes(32).toString('base64url') });
  const send = (route: string, options?: RequestInit) => fetch(origin + route, { ...options, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  const opened = await send('/account/bridge?' + query);
  assert.equal(opened.status, 200); assert.equal(opened.headers.get('cache-control'), 'no-store');
  assert.equal(opened.headers.get('referrer-policy'), 'no-referrer');
  const cookies = opened.headers.getSetCookie();
  assert.ok(cookies.length >= 1 && cookies.every(cookie => /HttpOnly; Secure; SameSite=Lax/.test(cookie)));
  const cookie = cookies.map(value => value.split(';', 1)[0]).join('; ');
  const html = await opened.text(); const config = /const config=(.*?);const status=/s.exec(html); assert.ok(config);
  const state = (JSON.parse(config[1]) as { state: string }).state;
  const post = (route: string, body: unknown, source = origin, browserCookie?: string) => send(route, { method: 'POST',
    headers: { origin: source, 'content-type': 'application/json', ...(browserCookie ? { cookie: browserCookie } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post('/api/account/bridge/issue', { state })).status, 401);
  assert.equal((await post('/api/account/bridge/issue', { state }, 'https://untrusted.example.invalid')).status, 403);
  const consumed = await post('/api/account/bridge/consume', { state, ticket: randomBytes(32).toString('base64url') }, origin, cookie);
  assert.equal(consumed.status, 401); assert.equal(consumed.headers.get('set-cookie'), null);
  assert.equal((await post('/api/auth/account-bridge/session', { sessionId: 'invalid', userId: 'invalid' })).status, 404);
  query.set('target', 'https://untrusted.example.invalid'); assert.equal((await send('/account/bridge?' + query)).status, 400);
  query.set('target', '/account'); query.set('clientOrigin', 'https://untrusted.example.invalid');
  assert.equal((await send('/account/bridge?' + query)).status, 400);
  console.log(JSON.stringify({ passed: true, checks: 7, target: origin, secureBridgePage: true, anonymousTicketDenied: true,
    wrongOriginDenied: true, fabricatedTicketDenied: true, internalSignerHidden: true, openRedirectDenied: true,
    productionUserCreated: false, realTicketIssued: false, realEmailSent: false }));
}
main().catch(() => { console.error('PUBLIC_ACCOUNT_BRIDGE_CHECK_FAILED'); process.exitCode = 1; });
