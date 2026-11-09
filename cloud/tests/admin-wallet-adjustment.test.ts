import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { hashPassword } from 'better-auth/crypto';
import { isolatedDatabase } from './database-fixture';

test('restricted runtime administrator balance adjustments are ledgered, frozen-safe and idempotent', { timeout: 300000 }, async t => {
  const fixture = await isolatedDatabase();
  process.env.AUTH_URL = 'http://127.0.0.1:4310'; process.env.AUTH_SECRET = randomBytes(48).toString('base64url');
  const { database, closeDatabase } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  const { authentication } = await import('../src/core/auth');
  const { POST } = await import('../src/app/api/admin/wallets/adjust/route');
  const { postLedger, walletFor } = await import('../src/core/wallet');
  const { adminRows, csvResponse } = await import('../src/core/admin-data');
  const admin = randomUUID(), secondAdmin = randomUUID(), ordinary = randomUUID(), other = randomUUID();
  const origin = process.env.AUTH_URL, reason = 'Synthetic balance adjustment fixture';
  const password = randomBytes(24).toString('base64url'), cookies = new Map<string, string>();
  const request = (body: unknown, cookie = cookies.get(admin) || '', source = origin) => new Request(origin + '/api/admin/wallets/adjust', {
    method: 'POST', headers: { origin: source, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const invoke = (body: unknown, cookie?: string, source?: string) => POST(request(body, cookie, source));
  const deltaBody = (delta = '1000000', userId = ordinary) => ({ userId, delta, reason, idempotencyKey: randomUUID() });
  const targetBody = (targetBalance = '0', userId = ordinary) => ({ userId, targetBalance, reason, idempotencyKey: randomUUID() });
  const entry = async (id: string) => (await database().db.select().from(tables.ledger).where(eq(tables.ledger.reference, 'adjustment:' + id)))[0];
  const auditEntry = async (id: string) => (await database().db.select().from(tables.audit).where(eq(tables.audit.id, id)))[0];
  const apply = async (body: unknown) => { const response = await invoke(body); assert.equal(response.status, 200); return response.json(); };
  try {
    await database().db.insert(tables.user).values([admin, secondAdmin, ordinary, other].map(id => ({ id, name: 'Balance fixture', email: `${id}@example.invalid`, emailVerified: true })));
    await database().db.insert(tables.userRoles).values([admin, secondAdmin].map(userId => ({ userId, roleId: 'admin' })));
    const hashed = await hashPassword(password);
    await database().db.insert(tables.account).values([admin, secondAdmin, ordinary].map(id => ({ id: randomUUID(), userId: id, accountId: id, providerId: 'credential', password: hashed })));
    for (const id of [admin, secondAdmin, ordinary]) {
      const response = await authentication().handler(new Request(origin + '/api/auth/sign-in/email', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email: `${id}@example.invalid`, password }) }));
      assert.equal(response.status, 200);
      const cookie = response.headers.getSetCookie().find(value => value.startsWith('ccagent.session_token='))?.split(';')[0]; assert.ok(cookie); cookies.set(id, cookie);
    }
    await t.test('the real runtime has no direct financial write privilege; auth, origin and strict amount validation fail closed', async () => {
      const [access] = await database().db.execute<{ role: string; can_update: boolean; can_insert_ledger: boolean }>(sql`select current_user as role,
        has_table_privilege(current_user, ${fixture.schema + '.wallets'}, 'UPDATE') as can_update,
        has_table_privilege(current_user, ${fixture.schema + '.ledger'}, 'INSERT') as can_insert_ledger`);
      assert.equal(access.role, 'ccagent_runtime'); assert.equal(access.can_update, false); assert.equal(access.can_insert_ledger, false);
      assert.equal((await invoke(deltaBody(), '')).status, 401);
      assert.equal((await invoke(deltaBody(), cookies.get(ordinary))).status, 403);
      assert.equal((await invoke(deltaBody(), undefined, 'https://evil.invalid')).status, 403);
      for (const value of ['0', '-0', '01', '1.1', '1e6', '9000000000000001']) assert.equal((await invoke(deltaBody(value))).status, 400);
      for (const value of ['-1', '00', '1.1', '9000000000000001']) assert.equal((await invoke(targetBody(value))).status, 400);
      assert.equal((await invoke({ ...deltaBody(), targetBalance: '0' })).status, 400);
      assert.equal((await invoke({ ...deltaBody(), reason: 'bad' })).status, 400);
      assert.equal((await walletFor(ordinary)).balance, 0n);
    });
    await t.test('legacy micro-yuan delta credits and debits post once with an attributable audit', async () => {
      const body = deltaBody('2123456'), first = await apply(body), replay = await apply(body);
      assert.equal(first.balance, '2123456'); assert.equal(first.delta, '2123456'); assert.equal(first.replayed, false); assert.equal(replay.replayed, true);
      const posted = await entry(body.idempotencyKey), recorded = await auditEntry(body.idempotencyKey);
      assert.equal(posted.kind, 'adjustment'); assert.equal(posted.balanceDelta, 2123456n); assert.equal(posted.frozenDelta, 0n);
      assert.equal(recorded.actorId, admin); assert.equal(recorded.objectId, ordinary); assert.equal(recorded.action, 'wallets.adjustment');
      assert.deepEqual(recorded.metadata, { actorId: admin, reason, delta: '2123456' });
      await apply(deltaBody('-1')); assert.equal((await walletFor(ordinary)).balance, 2123455n);
      assert.equal((await apply(body)).balance, '2123456', 'retry reports the original operation and never changes a later balance');
      assert.equal((await walletFor(ordinary)).balance, 2123455n);
    });
    await t.test('target zero is supported; unchanged targets are audited without a zero ledger row and are replay-safe', async () => {
      const body = targetBody('0'), cleared = await apply(body); assert.equal(cleared.delta, '-2123455'); assert.equal(cleared.balance, '0');
      const unchanged = targetBody('0'), noop = await apply(unchanged); assert.equal(noop.changed, false); assert.equal(noop.delta, '0');
      assert.equal(await entry(unchanged.idempotencyKey), undefined); assert.ok(await auditEntry(unchanged.idempotencyKey));
      await apply(deltaBody('7'));
      assert.equal((await apply(unchanged)).replayed, true); assert.equal((await apply(body)).replayed, true);
      assert.equal((await walletFor(ordinary)).balance, 7n, 'neither a target retry nor an unchanged retry resets subsequent funds');
    });
    await t.test('an idempotency key binds actor, account, reason, amount and adjustment mode', async () => {
      const body = targetBody('1000000'); await apply(body);
      const mismatches = [{ ...body, targetBalance: '1000001' }, { ...body, userId: other }, { ...body, reason: 'A different adjustment reason' },
        { userId: body.userId, delta: '999993', reason, idempotencyKey: body.idempotencyKey }];
      for (const payload of mismatches) { const response = await invoke(payload); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'IDEMPOTENCY_CONFLICT'); }
      assert.equal((await invoke(body, cookies.get(secondAdmin))).status, 409);
      assert.equal((await walletFor(ordinary)).balance, 1000000n); assert.equal((await walletFor(other)).balance, 0n);
    });
    await t.test('frozen funds cannot be removed and a rejected request reserves neither funds nor its idempotency key', async () => {
      await database().db.transaction(tx => postLedger(tx, ordinary, 'fixture-balance-hold', 'authorization', 0n, 400000n));
      const below = targetBody('399999'), debit = deltaBody('-600001');
      for (const body of [below, debit]) {
        const response = await invoke(body); assert.equal(response.status, 402); assert.equal((await response.json()).code, 'INSUFFICIENT_BALANCE');
        assert.equal(await auditEntry(body.idempotencyKey), undefined); assert.equal(await entry(body.idempotencyKey), undefined);
      }
      const exact = await apply(targetBody('400000')); assert.equal(exact.balance, '400000'); assert.equal(exact.frozen, '400000');
      const held = await walletFor(ordinary); assert.equal(held.available, 0n); assert.equal(held.frozen, 400000n);
      await database().db.transaction(tx => postLedger(tx, ordinary, 'fixture-balance-release', 'release', 0n, -400000n));
      assert.equal((await apply(below)).balance, '399999', 'the same request can succeed after the blocking frozen funds are released');
    });
    await t.test('parallel retries apply once and concurrent target/credit use the same account lock', async () => {
      const body = deltaBody('1'), responses = await Promise.all(Array.from({ length: 4 }, () => invoke(body)));
      assert.deepEqual(responses.map(response => response.status), [200, 200, 200, 200]);
      const results = await Promise.all(responses.map(response => response.json())); assert.equal(results.filter(result => !result.replayed).length, 1);
      assert.equal((await walletFor(ordinary)).balance, 400000n);
      const target = targetBody('500000'), credit = deltaBody('3');
      const concurrent = await Promise.all([invoke(target), invoke(credit)]); assert.deepEqual(concurrent.map(response => response.status), [200, 200]);
      const final = await walletFor(ordinary); assert.ok([500000n, 500003n].includes(final.balance)); assert.equal(final.frozen, 0n);
      const allEntries = await database().db.select().from(tables.ledger).where(eq(tables.ledger.userId, ordinary));
      assert.equal(allEntries.reduce((sum, row) => sum + row.balanceDelta, 0n), final.balance);
      assert.equal(allEntries.filter(row => row.reference === 'adjustment:' + body.idempotencyKey).length, 1);
    });
    await t.test('a cross-account concurrent UUID collision leaves one audited ledger entry and no partial write', async () => {
      const idempotencyKey = randomUUID(), first = { ...deltaBody('11'), idempotencyKey }, second = { ...deltaBody('11', other), idempotencyKey };
      const before = new Map(await Promise.all([ordinary, other].map(async id => [id, (await walletFor(id)).balance] as const)));
      const responses = await Promise.all([invoke(first), invoke(second)]); assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
      const posted = await entry(idempotencyKey), recorded = await auditEntry(idempotencyKey); assert.equal(recorded.objectId, posted.userId);
      for (const id of [ordinary, other]) assert.equal((await walletFor(id)).balance, before.get(id)! + (posted.userId === id ? 11n : 0n));
    });
    await t.test('users expose raw total balance after roles; filtered CSV shows yuan and retains formula injection protection', async () => {
      const rows = await adminRows('users', new URL(origin + '/admin/users?user=' + ordinary + '&status=active'));
      assert.equal(rows.total, 1); const row = rows.rows[0]; assert.equal(row.id, ordinary);
      assert.equal(row.user_balance, (await walletFor(ordinary)).balance.toString());
      const columns = Object.keys(row); assert.equal(columns[columns.indexOf('roles') + 1], 'user_balance');
      const snapshot = JSON.stringify(rows.rows), csv = await csvResponse(rows.rows, 'users').text(); assert.ok(csv.includes('用户余额（元）')); assert.equal(JSON.stringify(rows.rows), snapshot);
      const sample = [{ name: '=SUM(A1:A2)', user_balance: '2123456', balance_delta: '-1', metadata: { delta: '1000000', reason: '=unsafe' } }];
      const exported = await csvResponse(sample, 'users').text(); assert.ok(exported.includes('"2.123456"')); assert.ok(exported.includes('"\'-0.000001"'));
      assert.ok(exported.includes('"\'=SUM(A1:A2)"')); assert.ok(exported.includes('余额调整（元）')); assert.equal(sample[0].user_balance, '2123456');
    });
    t.diagnostic('Only synthetic users/funds in an isolated schema; restricted runtime, auth/origin, target zero, frozen protection, parameter-bound idempotency, concurrency, ledger totals and CSV checked.');
  } finally { await closeDatabase(); await fixture.cleanup(); }
});
