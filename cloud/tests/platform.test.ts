import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { isolatedDatabase } from './database-fixture';

test('real Supabase: migrations, email auth, permissions, keys and transactional wallet', { timeout: 300000 }, async t => {
  const fixture = await isolatedDatabase();
  process.env.AUTH_URL = 'http://127.0.0.1:4310';
  process.env.AUTH_SECRET = randomBytes(48).toString('base64');
  const { database, closeDatabase } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  const { createAuthentication, requireSession, requirePermission } = await import('../src/core/auth');
  const { createKey, listKeys, revokeKey, requireServiceIdentity } = await import('../src/core/keys');
  const { postLedger, walletFor, authorizeUsage, finishUsage } = await import('../src/core/wallet');
  const { GET: authGet, POST: authPost } = await import('../src/app/api/auth/[...all]/route');
  const sent: { to: string; url: string; kind: string }[] = [];
  const auth = createAuthentication({ db: database().db, origin: process.env.AUTH_URL, secret: process.env.AUTH_SECRET, deliverMail: async message => { sent.push(message); } });
  const origin = process.env.AUTH_URL;
  const request = (route: string, body?: unknown, cookie?: string) => new Request(`${origin}/api/auth${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin, ...(cookie ? { cookie } : {}),
      'x-vercel-forwarded-for': '127.0.0.1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const password = randomBytes(24).toString('base64url');
  let a = '', b = '', cookieA = '', cookieB = '';
  async function register(label: string) {
    const email = `${label.toLowerCase()}-${randomUUID()}@example.invalid`;
    const response = await auth.handler(request('/sign-up/email', { name: label, email, password }));
    assert.equal(response.status, 200, `sign up failed: ${response.status}`);
    const body = await response.json() as { user: { id: string }; token: null };
    assert.equal(body.token, null);
    const before = await auth.handler(request('/sign-in/email', { email, password }));
    assert.equal(before.status, 403);
    const verify = sent.findLast(item => item.to === email && item.kind === 'verification');
    assert.ok(verify);
    const verified = await auth.handler(new Request(verify.url));
    assert.equal(verified.status, 302);
    assert.equal(new URL(verified.headers.get('location')!, origin).origin, origin);
    const [verifiedUser] = await database().db.select().from(tables.user).where(eq(tables.user.id, body.user.id));
    assert.equal(verifiedUser.emailVerified, true);
    const login = await auth.handler(request('/sign-in/email', { email, password }));
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().find(item => item.startsWith('ccagent.session_token='))?.split(';')[0];
    assert.ok(cookie);
    return { id: body.user.id, email, cookie };
  }
  try {
    await t.test('applies versioned migrations twice without duplicating tables', async () => {
      await fixture.apply();
      const [versions] = await fixture.owner.unsafe(`SELECT count(*)::integer as count FROM "${fixture.schema}".__drizzle_migrations`);
      assert.equal(versions.count, 3);
    });
    const accountA = await register('Alice'), accountB = await register('Bob');
    a = accountA.id; b = accountB.id; cookieA = accountA.cookie; cookieB = accountB.cookie;
    await t.test('verification required; native signed cookie backed by real stored sessions', async () => {
      const current = await requireSession(new Headers({ cookie: cookieA }));
      assert.equal(current.user.id, a);
      assert.equal((await walletFor(a)).balance, 0n);
      assert.equal((await database().db.select().from(tables.userRoles).where(eq(tables.userRoles.userId, a)))[0].roleId, 'user');
      const [credential] = await database().db.select().from(tables.account).where(eq(tables.account.userId, a));
      assert.ok(credential.password && !credential.password.includes(password));
      assert.equal((await authGet(request('/get-session', undefined, cookieA))).status, 200);
      assert.equal((await authGet(request('/get-session'))).status, 401);
    });
    await t.test('ordinary users cannot enter admin or invoke Better Auth admin mutation endpoints', async () => {
      await assert.rejects(() => requirePermission(new Headers({ cookie: cookieA }), 'admin.read'), { status: 403 });
      assert.equal((await authPost(request('/admin/set-role', { userId: a, role: 'admin' }, cookieA))).status, 404);
      const forged = new Request(`${origin}/api/auth/sign-in/email`, { method: 'POST', headers: { origin: 'https://attacker.invalid', 'content-type': 'application/json' }, body: '{}' });
      assert.equal((await authPost(forged)).status, 403);
    });
    await t.test('disabled accounts invalidate a previously valid cookie immediately', async () => {
      await database().db.update(tables.user).set({ banned: true }).where(eq(tables.user.id, a));
      await assert.rejects(() => requireSession(new Headers({ cookie: cookieA })), { status: 403 });
      assert.equal((await authGet(request('/get-session', undefined, cookieA))).status, 403);
      await database().db.update(tables.user).set({ banned: false }).where(eq(tables.user.id, a));
    });
    let keyA: Awaited<ReturnType<typeof createKey>>;
    await t.test('keys stored as hashes; ownership, app login and revocation enforced', async () => {
      keyA = await createKey(a, 'test', '1000');
      const keyB = await createKey(b, 'test');
      const [stored] = await database().db.select().from(tables.apiKeys).where(eq(tables.apiKeys.id, keyA.key.id));
      assert.notEqual(stored.hash, keyA.secret);
      assert.equal(stored.hash.length, 64);
      assert.equal(JSON.stringify(await listKeys(a), (_k, v) => typeof v === 'bigint' ? String(v) : v).includes('hash'), false);
      const paidRequest = (cookie: string | undefined, key: string) => new Request(`${origin}/v1/models`, { headers: { ...(cookie ? { cookie } : {}), authorization: `Bearer ${key}` } });
      await assert.rejects(() => requireServiceIdentity(paidRequest(undefined, keyA.secret)), { status: 401 });
      await assert.rejects(() => requireServiceIdentity(paidRequest(cookieA, keyB.secret)), { status: 403 });
      await assert.rejects(() => revokeKey(a, keyB.key.id), { status: 404 });
      assert.equal((await requireServiceIdentity(paidRequest(cookieA, keyA.secret))).keyId, keyA.key.id);
      await revokeKey(b, keyB.key.id);
      await assert.rejects(() => requireServiceIdentity(paidRequest(cookieB, keyB.secret)), { status: 403 });
    });
    const routeId = randomUUID();
    await database().db.insert(tables.routes).values({ id: routeId, name: 'test route', service: 'chat', protocol: 'openai', provider: 'fixture',
      baseUrl: 'https://provider.example.invalid', upstreamModel: 'fixture', credentialEnv: 'TEST_ONLY', enabled: false });
    await t.test('concurrent recharge retries credit the wallet exactly once', async () => {
      await Promise.all(Array.from({ length: 8 }, () => database().db.transaction(tx => postLedger(tx, a, 'test-credit', 'recharge', 1000n, 0n))));
      assert.equal((await walletFor(a)).balance, 1000n);
      await assert.rejects(() => database().db.transaction(tx => postLedger(tx, a, 'test-credit', 'recharge', 2000n, 0n)));
      assert.equal((await walletFor(a)).balance, 1000n);
    });
    const call = (idempotencyKey: string) => ({ userId: a, keyId: keyA.key.id, routeId, taskId: 'test-task', idempotencyKey,
      requestHash: 'a'.repeat(64), authorized: 200n, priceSnapshot: { version: 1, source: 'test' } });
    let calls: Awaited<ReturnType<typeof authorizeUsage>>[] = [];
    await t.test('parallel calls cannot overdraw wallet or key limit', async () => {
      const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => authorizeUsage(call(`parallel-${i}`))));
      const unexpected = results.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
        .map(item => item.reason as Error & { status?: number; cause?: Error }).filter(error => error.status !== 402);
      assert.deepEqual(unexpected.map(error => error.cause?.message ?? error.message), []);
      calls = results.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof authorizeUsage>>> => item.status === 'fulfilled').map(item => item.value);
      assert.equal(calls.length, 5);
      assert.equal((await walletFor(a)).frozen, 1000n);
      assert.equal((await walletFor(a)).available, 0n);
    });
    await t.test('identical retry reuses authorization, altered payload or account cannot reuse it', async () => {
      const original = calls[0].reservation;
      const duplicate = await authorizeUsage(call(original.idempotencyKey));
      assert.equal(duplicate.replay, true);
      assert.equal(duplicate.reservation.id, original.id);
      await assert.rejects(() => authorizeUsage({ ...call(original.idempotencyKey), requestHash: 'b'.repeat(64) }), { status: 409 });
      await assert.rejects(() => finishUsage({ userId: b, reservationId: original.id, charged: 100n, usage: {} }), { status: 404 });
      assert.equal((await walletFor(a)).frozen, 1000n);
    });
    await t.test('settlement and cancellation release unused funds; duplicate settlement never charges again', async () => {
      const original = calls[0].reservation;
      const settlement = { userId: a, reservationId: original.id, charged: 130n, usage: { tokens: 100 } };
      await Promise.all([finishUsage(settlement), finishUsage(settlement)]);
      for (const item of calls.slice(1)) await finishUsage({ userId: a, reservationId: item.reservation.id, charged: 0n, usage: {}, release: true });
      const balance = await walletFor(a);
      assert.equal(balance.balance, 870n); assert.equal(balance.frozen, 0n);
      const [key] = await database().db.select().from(tables.apiKeys).where(eq(tables.apiKeys.id, keyA.key.id));
      assert.equal(key.spent, 130n); assert.equal(key.frozen, 0n);
      await assert.rejects(() => finishUsage({ ...settlement, charged: 140n }), { status: 409 });
      await assert.rejects(() => database().db.update(tables.ledger).set({ kind: 'changed' }));
      await assert.rejects(() => database().db.delete(tables.ledger));
    });
    await t.test('password reset revokes old database sessions and changes credential', async () => {
      assert.equal((await auth.handler(request('/request-password-reset', { email: accountB.email, redirectTo: `${origin}/reset-password` }))).status, 200);
      const reset = sent.findLast(item => item.kind === 'reset' && item.to === accountB.email);
      assert.ok(reset);
      const token = new URL(reset.url).pathname.split('/').pop();
      const next = randomBytes(24).toString('base64url');
      const response = await auth.handler(request('/reset-password', { token, newPassword: next }));
      assert.equal(response.status, 200);
      await assert.rejects(() => requireSession(new Headers({ cookie: cookieB })), { status: 401 });
      assert.equal((await auth.handler(request('/sign-in/email', { email: accountB.email, password }))).status, 401);
      assert.equal((await auth.handler(request('/sign-in/email', { email: accountB.email, password: next }))).status, 200);
    });
    await t.test('sign out removes session; malformed session never authenticates', async () => {
      assert.equal((await auth.handler(request('/sign-out', {}, cookieA))).status, 200);
      await assert.rejects(() => requireSession(new Headers({ cookie: cookieA })), { status: 401 });
      await assert.rejects(() => requireSession(new Headers({ cookie: 'ccagent.session_token=forged' })), { status: 401 });
    });
    await t.test('runtime role cannot directly write financial balances or delete ledger', async () => {
      const grants = `"${fixture.schema}"`;
      await fixture.owner.unsafe(`GRANT USAGE ON SCHEMA ${grants} TO ccagent_runtime`);
      await fixture.owner.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA ${grants} TO ccagent_runtime`);
      await assert.rejects(() => fixture.owner.begin(async tx => {
        await tx.unsafe('SET LOCAL ROLE ccagent_runtime');
        await tx.unsafe(`UPDATE ${grants}.wallets SET balance = 100000000`);
      }));
      await assert.rejects(() => fixture.owner.begin(async tx => {
        await tx.unsafe('SET LOCAL ROLE ccagent_runtime');
        await tx.unsafe(`DELETE FROM ${grants}.ledger`);
      }));
      const [{ count }] = await database().db.select({ count: sql<number>`count(*)::integer` }).from(tables.user);
      assert.equal(count, 2);
    });
  } finally { await closeDatabase(); await fixture.cleanup(); }
});
