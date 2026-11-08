import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { isolatedDatabase } from './database-fixture';

test('isolated database and real Better Auth: browser-bound account bridge and shared-session revocation', { timeout: 300000 }, async t => {
  const fixture = await isolatedDatabase();
  const origin = 'https://ccagent-bridge-test.example.invalid';
  process.env.AUTH_URL = origin;
  process.env.AUTH_SECRET = randomBytes(48).toString('base64url');
  const { database, closeDatabase } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  const { createAuthentication, requireSession } = await import('../src/core/auth');
  const bridge = await import('../src/core/account-bridge');
  const { GET: pageGet } = await import('../src/app/account/bridge/route');
  const { POST: issuePost } = await import('../src/app/api/account/bridge/issue/route');
  const { POST: consumePost } = await import('../src/app/api/account/bridge/consume/route');
  const { POST: authPost } = await import('../src/app/api/auth/[...all]/route');
  const sent: { to: string; url: string; kind: string }[] = [];
  const auth = createAuthentication({ db: database().db, origin, secret: process.env.AUTH_SECRET,
    deliverMail: async mail => { sent.push(mail); } });
  let requestNumber = 0;
  const request = (path: string, body?: unknown, cookie?: string, source = origin) => new Request(origin + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin: source,
      'x-vercel-forwarded-for': `192.0.2.${++requestNumber % 250 + 1}`, ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const password = randomBytes(24).toString('base64url');
  async function user(label: string) {
    const email = `${label}-${randomBytes(8).toString('hex')}@example.invalid`;
    const signup = await auth.handler(request('/api/auth/sign-up/email', { name: label, email, password }));
    assert.equal(signup.status, 200);
    const mail = sent.findLast(mail => mail.to === email && mail.kind === 'verification');
    assert.ok(mail);
    assert.equal((await auth.handler(new Request(mail.url))).status, 302);
    return { email, ...(await login(email)) };
  }
  async function login(email: string) {
    const response = await auth.handler(request('/api/auth/sign-in/email', { email, password }));
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().find(cookie => cookie.startsWith('__Secure-ccagent.session_token='))?.split(';')[0];
    assert.ok(cookie);
    const current = await requireSession(new Headers({ cookie }));
    return { cookie, id: current.user.id, sessionId: current.session.id };
  }
  async function page(target = '/account', cookie?: string, clientOrigin = 'http://127.0.0.1:4174') {
    const channel = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({ target, clientOrigin, channel });
    const response = pageGet(request('/account/bridge?' + query, undefined, cookie));
    assert.equal(response.status, 200);
    const cookieValue = response.headers.getSetCookie()[0].split(';')[0];
    const html = await response.text();
    const config = /const config=(.*?);const status=/s.exec(html);
    assert.ok(config);
    return { state: (JSON.parse(config[1]) as { state: string }).state, channel, cookie: cookieValue, response, html };
  }
  async function issue(state: string, cookie: string) {
    const response = await issuePost(request('/api/account/bridge/issue', { state }, cookie));
    assert.equal(response.status, 200);
    const result = await response.json() as { ticket: string; expiresAt: string };
    assert.match(result.ticket, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(Date.parse(result.expiresAt) > Date.now());
    return result.ticket;
  }
  const consume = (state: string, ticket: string, cookie?: string, source = origin) => consumePost(request('/api/account/bridge/consume', { state, ticket }, cookie, source));
  const signedCookie = (response: Response) => response.headers.getSetCookie().find(cookie => cookie.startsWith('__Secure-ccagent.session_token='))?.split(';')[0];
  try {
    const alice = await user('alice'), bob = await user('bob');
    await t.test('only exact loopback origins, allowlisted targets and a random channel are accepted', async () => {
      for (const value of ['https://localhost:4174', 'http://localhost', 'http://localhost:80', 'http://localhost:04174',
        'http://LOCALHOST:4174', 'http://127.1:4174', 'http://127.0.0.2:4174', 'http://[::1]:4174', 'http://evil.invalid:4174',
        'http://user@localhost:4174', 'http://localhost:4174/', 'http://localhost:4174/?x=1', 'http://localhost:4174/#x', 'http://localhost:65536']) {
        assert.throws(() => bridge.accountBridgeClientOrigin(value));
      }
      assert.equal(bridge.accountBridgeClientOrigin('http://localhost:4174'), 'http://localhost:4174');
      assert.equal(bridge.accountBridgeClientOrigin('http://127.0.0.1:4174'), 'http://127.0.0.1:4174');
      for (const target of ['https://evil.invalid', '//evil.invalid', '/account?next=https://evil.invalid', '/account/../admin', '/admin/users']) {
        const query = new URLSearchParams({ target, clientOrigin: 'http://127.0.0.1:4174', channel: randomBytes(32).toString('base64url') });
        assert.equal(pageGet(request('/account/bridge?' + query)).status, 400);
      }
      assert.equal(pageGet(request('/account/bridge?target=/account&clientOrigin=http://localhost:4174&channel=short')).status, 400);
      const internalQuery = new URLSearchParams({ target: '/account', clientOrigin: 'http://localhost:4174', channel: randomBytes(32).toString('base64url') });
      assert.equal(pageGet(new Request('http://internal-next:3000/account/bridge?' + internalQuery, { headers: { host: new URL(origin).host } })).status, 200);
      assert.equal(pageGet(new Request(origin + '/account/bridge?' + internalQuery, { headers: { host: 'evil.invalid' } })).status, 400);
      const opened = await page('/account', undefined, 'http://localhost:4174');
      assert.equal(opened.response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(opened.response.headers.get('cache-control'), 'no-store');
      assert.match(opened.response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
      assert.match(opened.response.headers.getSetCookie()[0], /HttpOnly; Secure; SameSite=Lax/);
      assert.ok(opened.html.includes('event.source!==opener') && opened.html.includes('window.opener=null'));
      assert.ok(!opened.html.includes('<script src='));
      assert.throws(() => bridge.readAccountBridgeState(opened.state.slice(0, -1) + (opened.state.endsWith('A') ? 'B' : 'A')));
      assert.throws(() => bridge.readAccountBridgeState('a'.repeat(8193)));
    });
    await t.test('issue requires a valid source session and same-origin POST', async () => {
      const opened = await page();
      assert.equal((await issuePost(request('/api/account/bridge/issue', { state: opened.state }))).status, 401);
      assert.equal((await issuePost(request('/api/account/bridge/issue', { state: opened.state }, alice.cookie, 'https://evil.invalid'))).status, 403);
      assert.equal((await database().db.select().from(tables.verification).where(eq(tables.verification.identifier, 'account-bridge:' + '0'.repeat(64)))).length, 0);
    });
    await t.test('tickets are stored hashed and cannot be consumed in another browser or without its HttpOnly nonce', async () => {
      const opened = await page('/account/keys');
      const ticket = await issue(opened.state, alice.cookie);
      const records = await database().db.select().from(tables.verification);
      const record = records.find(record => record.id.startsWith('account-bridge:'))!;
      assert.ok(record && !JSON.stringify(record).includes(ticket) && !JSON.stringify(record).includes(opened.state));
      const otherBrowser = await page('/account/keys');
      for (const cookie of [undefined, otherBrowser.cookie]) {
        const denied = await consume(opened.state, ticket, cookie);
        assert.equal(denied.status, 400); assert.equal(denied.headers.get('set-cookie'), null);
      }
      const accepted = await consume(opened.state, ticket, opened.cookie);
      assert.equal(accepted.status, 200); assert.deepEqual(await accepted.json(), { target: '/account/keys' });
      const cookie = signedCookie(accepted); assert.ok(cookie);
      assert.match(accepted.headers.getSetCookie().find(item => item.includes('session_token='))!, /HttpOnly/i);
      assert.match(accepted.headers.getSetCookie().find(item => item.includes('session_token='))!, /Secure/);
      const current = await requireSession(new Headers({ cookie }));
      assert.equal(current.user.id, alice.id); assert.equal(current.session.id, alice.sessionId);
      assert.equal((await consume(opened.state, ticket, opened.cookie)).status, 401);
      const tampered = cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A');
      await assert.rejects(() => requireSession(new Headers({ cookie: tampered })), (error: any) => error.status === 401);
    });
    await t.test('another valid state cannot consume a ticket bound to the original state', async () => {
      const first = await page(), second = await page('/account/billing', first.cookie);
      const ticket = await issue(first.state, alice.cookie);
      assert.equal((await consume(second.state, ticket, second.cookie)).status, 401);
      assert.equal((await consume(first.state, ticket, first.cookie)).status, 200);
    });
    await t.test('concurrent consumption is atomic, and only one response gets a session cookie', async () => {
      const opened = await page();
      const ticket = await issue(opened.state, alice.cookie);
      const responses = await Promise.all([consume(opened.state, ticket, opened.cookie), consume(opened.state, ticket, opened.cookie)]);
      assert.deepEqual(responses.map(response => response.status).sort(), [200, 401]);
      assert.equal(responses.filter(response => signedCookie(response)).length, 1);
    });
    await t.test('same-browser windows reuse the nonce and completing one does not invalidate the other', async () => {
      const first = await page('/account'), second = await page('/account/usage', first.cookie);
      assert.equal(first.cookie, second.cookie);
      assert.equal(second.response.headers.getSetCookie().length, 1);
      const a = await issue(first.state, alice.cookie), b = await issue(second.state, alice.cookie);
      for (const [opened, ticket] of [[first, a], [second, b]] as const) {
        const response = await consume(opened.state, ticket, opened.cookie);
        assert.equal(response.status, 200);
        assert.ok(!response.headers.getSetCookie().some(cookie => cookie.startsWith('__Host-ccagent.account_bridge=')));
      }
    });
    await t.test('fully parallel fresh pages survive the last shared nonce cookie while each fallback stays bound to its channel', async () => {
      // Both GETs were sent before either shared Set-Cookie reached the browser.
      const [first, second] = await Promise.all([page('/account'), page('/account/usage')]);
      assert.notEqual(first.cookie, second.cookie);
      const aFallback = first.response.headers.getSetCookie().find(cookie => cookie.startsWith('__Host-ccagent.account_bridge.'))!;
      const bFallback = second.response.headers.getSetCookie().find(cookie => cookie.startsWith('__Host-ccagent.account_bridge.'))!;
      assert.ok(aFallback && bFallback);
      assert.match(aFallback, /Max-Age=120; HttpOnly; Secure; SameSite=Lax/);
      const jar = [second.cookie, aFallback.split(';')[0], bFallback.split(';')[0]].join('; ');
      const a = await issue(first.state, alice.cookie), b = await issue(second.state, alice.cookie);
      // Invalid/duplicate relevant cookies must fail before consuming the ticket,
      // even when the other binding cookie would have matched.
      for (const invalidCookie of [jar + '; ' + aFallback.split(';')[0],
        jar + '; ' + second.cookie,
        [second.cookie, `__Host-ccagent.account_bridge.${first.channel}=invalid`].join('; '),
        [`__Host-ccagent.account_bridge=invalid`, aFallback.split(';')[0]].join('; ')]) {
        const response = await consume(first.state, a, invalidCookie);
        assert.equal(response.status, 400); assert.equal(response.headers.get('set-cookie'), null);
      }
      const firstDone = await consume(first.state, a, jar);
      assert.equal(firstDone.status, 200);
      assert.ok(firstDone.headers.getSetCookie().some(cookie => cookie.startsWith(`__Host-ccagent.account_bridge.${first.channel}=`) && cookie.includes('Max-Age=0')));
      assert.ok(!firstDone.headers.getSetCookie().some(cookie => cookie.startsWith('__Host-ccagent.account_bridge=')));
      const secondDone = await consume(second.state, b, [second.cookie, bFallback.split(';')[0]].join('; '));
      assert.equal(secondDone.status, 200);
      for (const response of [firstDone, secondDone]) {
        const cookie = signedCookie(response); assert.ok(cookie);
        assert.equal((await requireSession(new Headers({ cookie }))).session.id, alice.sessionId);
      }
    });
    await t.test('an existing browser account changes to source A only after successful browser binding', async () => {
      const opened = await page('/account', bob.cookie);
      const ticket = await issue(opened.state, alice.cookie);
      const bad = await consume(opened.state, ticket, bob.cookie);
      assert.equal(bad.status, 400); assert.equal(bad.headers.get('set-cookie'), null);
      assert.equal((await requireSession(new Headers({ cookie: bob.cookie }))).user.id, bob.id);
      const response = await consume(opened.state, ticket, opened.cookie + '; ' + bob.cookie);
      assert.equal(response.status, 200);
      const cookie = signedCookie(response); assert.ok(cookie);
      assert.equal((await requireSession(new Headers({ cookie }))).user.id, alice.id);
      assert.equal((await requireSession(new Headers({ cookie: bob.cookie }))).user.id, bob.id);
    });
    await t.test('expired tickets and expired signed state are rejected without cookies', async () => {
      const opened = await page();
      const ticket = await issue(opened.state, alice.cookie);
      await database().db.update(tables.verification).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(tables.verification.identifier,
        'account-bridge:' + (await import('node:crypto')).createHash('sha256').update(opened.state).digest('hex')));
      const response = await consume(opened.state, ticket, opened.cookie);
      assert.equal(response.status, 401); assert.equal(response.headers.get('set-cookie'), null);
      const realNow = Date.now;
      Date.now = () => realNow() + 121000;
      try { assert.throws(() => bridge.readAccountBridgeState(opened.state)); } finally { Date.now = realNow; }
    });
    await t.test('cross-site consume does not consume the valid ticket', async () => {
      const opened = await page(); const ticket = await issue(opened.state, alice.cookie);
      assert.equal((await consume(opened.state, ticket, opened.cookie, 'https://evil.invalid')).status, 403);
      assert.equal((await consume(opened.state, ticket, opened.cookie)).status, 200);
    });
    await t.test('banned or newly unverified source users cannot complete the bridge', async () => {
      for (const update of [{ banned: true }, { emailVerified: false }]) {
        const opened = await page(); const ticket = await issue(opened.state, alice.cookie);
        await database().db.update(tables.user).set(update).where(eq(tables.user.id, alice.id));
        try {
          const response = await consume(opened.state, ticket, opened.cookie);
          assert.equal(response.status, 401); assert.equal(response.headers.get('set-cookie'), null);
        } finally { await database().db.update(tables.user).set({ banned: false, emailVerified: true }).where(eq(tables.user.id, alice.id)); }
      }
    });
    await t.test('internal SDK signer is unavailable through HTTP and rechecks source revocation after ticket claim', async () => {
      const body = { sessionId: alice.sessionId, userId: alice.id };
      assert.equal((await auth.handler(request('/api/auth/account-bridge/session', body))).status, 403);
      assert.equal((await authPost(request('/api/auth/account-bridge/session', body))).status, 404);
      const transient = await user('transient'); const opened = await page(); const ticket = await issue(opened.state, transient.cookie);
      const claim = await bridge.consumeAccountBridge(opened.state, ticket, new Headers({ cookie: opened.cookie }));
      await database().db.delete(tables.session).where(eq(tables.session.id, transient.sessionId));
      const response = await auth.api.setAccountBridgeSession({ body: { sessionId: claim.sessionId, userId: claim.userId }, asResponse: true });
      assert.equal(response.status, 401); assert.equal(response.headers.get('set-cookie'), null);
    });
    await t.test('source expiration or revocation before consume rejects tickets without creating another session', async () => {
      const transient = await user('expired'); const opened = await page(); const ticket = await issue(opened.state, transient.cookie);
      await database().db.update(tables.session).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(tables.session.id, transient.sessionId));
      assert.equal((await consume(opened.state, ticket, opened.cookie)).status, 401);
      const another = await user('revoked'); const second = await page(); const otherTicket = await issue(second.state, another.cookie);
      await database().db.delete(tables.session).where(eq(tables.session.id, another.sessionId));
      const response = await consume(second.state, otherTicket, second.cookie);
      assert.equal(response.status, 401); assert.equal(response.headers.get('set-cookie'), null);
    });
    await t.test('logout and password reset revoke the same session in both local and bridged browsers', async () => {
      const transient = await user('sharedlogout'); const opened = await page(); const ticket = await issue(opened.state, transient.cookie);
      const response = await consume(opened.state, ticket, opened.cookie); const cookie = signedCookie(response); assert.ok(cookie);
      assert.equal((await auth.handler(request('/api/auth/sign-out', {}, transient.cookie))).status, 200);
      for (const value of [transient.cookie, cookie]) await assert.rejects(() => requireSession(new Headers({ cookie: value })), (error: any) => error.status === 401);
      const reset = await user('sharedreset'); const second = await page(); const resetTicket = await issue(second.state, reset.cookie);
      const bridged = await consume(second.state, resetTicket, second.cookie); const bridgeCookie = signedCookie(bridged); assert.ok(bridgeCookie);
      assert.equal((await auth.handler(request('/api/auth/request-password-reset', { email: reset.email }))).status, 200);
      const resetMail = sent.findLast(mail => mail.to === reset.email && mail.kind === 'reset'); assert.ok(resetMail);
      const token = new URL(resetMail.url).pathname.split('/').at(-1)!;
      assert.equal((await auth.handler(request('/api/auth/reset-password', { token, newPassword: randomBytes(24).toString('base64url') }))).status, 200);
      for (const value of [reset.cookie, bridgeCookie]) await assert.rejects(() => requireSession(new Headers({ cookie: value })), (error: any) => error.status === 401);
      assert.equal((await database().db.select().from(tables.session).where(and(eq(tables.session.userId, reset.id), eq(tables.session.id, reset.sessionId)))).length, 0);
    });
  } finally { await closeDatabase(); await fixture.cleanup(); }
});
