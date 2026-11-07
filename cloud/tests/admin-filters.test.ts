import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { hashPassword } from 'better-auth/crypto';
import { isolatedDatabase } from './database-fixture';
import { seedAdminFilterData } from './admin-filter-data';

test('real restricted database admin filters, complete totals, task grouping and protected exports', { timeout: 240000 }, async t => {
  const fixture = await isolatedDatabase();
  process.env.AUTH_URL = 'http://127.0.0.1:4310';
  process.env.AUTH_SECRET = randomBytes(48).toString('base64url');
  const { database, closeDatabase } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  const { adminRows } = await import('../src/core/admin-data');
  const { GET } = await import('../src/app/api/admin/data/[section]/route');
  const { authentication } = await import('../src/core/auth');
  try {
    const seeded = await seedAdminFilterData();
    const selected = { user: seeded.users[0]!.id, from: seeded.day, to: seeded.day, service: 'chat', status: 'settled', route: 'filter-chat', task: 'task-main' };
    const url = (values: Record<string, string> = {}) => new URL('http://local/?' + new URLSearchParams(values));
    await t.test('all filters combine, total money covers both pages and export ignores pagination only', async () => {
      const first = await adminRows('usage', url({ ...selected, pageSize: '1' }));
      const second = await adminRows('usage', url({ ...selected, pageSize: '1', page: '2' }));
      const exported = await adminRows('usage', url({ ...selected, pageSize: '1', page: '2' }), true);
      assert.equal(first.total, 2); assert.equal(second.total, 2); assert.equal(first.rows.length, 1);
      assert.deepEqual(first.summary, { charged: '300', authorized: '2000' }); assert.deepEqual(first.summary, second.summary);
      assert.deepEqual(new Set([...first.rows, ...second.rows].map(row => row.id)), new Set(seeded.callIds.slice(1, 3)));
      assert.deepEqual(new Set(exported.rows.map(row => row.id)), new Set(seeded.callIds.slice(1, 3)));
      assert.deepEqual(exported.filters, first.filters); assert.equal(exported.rows.length, 2);
    });
    await t.test('Beijing date range includes its first instant and last microsecond, excludes next midnight', async () => {
      const filtered = await adminRows('usage', url({ user: seeded.users[0]!.id, from: seeded.day, to: seeded.day, task: 'task-main', status: 'settled' }));
      assert.deepEqual(new Set(filtered.rows.map(row => row.id)), new Set(seeded.callIds.slice(1, 4)));
      assert.deepEqual(filtered.summary, { charged: '600', authorized: '3000' });
    });
    await t.test('task sums filter source calls before grouping and never merge users sharing a task id', async () => {
      const filtered = await adminRows('tasks', url(selected));
      assert.equal(filtered.total, 1); assert.equal(filtered.rows[0]!.charged, '300'); assert.equal(filtered.rows[0]!.calls, '2');
      assert.deepEqual(filtered.summary, { calls: '2', charged: '300' });
      const both = await adminRows('tasks', url({ task: 'task-main', from: seeded.day, to: seeded.day, status: 'settled', service: 'chat' }));
      assert.equal(both.total, 2); assert.deepEqual(both.summary, { calls: '3', charged: '700' });
      assert.deepEqual(new Set(both.rows.map(row => row.user_id)), new Set(seeded.users.map(user => user.id)));
    });
    await t.test('email fragments are case insensitive, wildcard characters stay literal and identifiers are bound', async () => {
      assert.equal((await adminRows('usage', url({ ...selected, user: 'ALPHA_OPS@FILTERS' }))).total, 2);
      assert.equal((await adminRows('usage', url({ user: '%' }))).total, 0);
      assert.equal((await adminRows('usage', url({ q: '%' }))).total, 1);
      assert.equal((await adminRows('usage', url({ task: "task-main' OR 1=1--" }))).total, 0);
      assert.equal((await adminRows('usage', url({ user: "' OR 1=1--" }))).total, 0);
    });
    await t.test('orders refunds routes and prices have matching type specific filters and totals', async () => {
      const orders = await adminRows('orders', url({ user: 'alpha', status: 'credited', from: seeded.day, to: seeded.day }));
      assert.equal(orders.total, 1); assert.equal(orders.rows[0]!.id, seeded.orders[0]!.id); assert.deepEqual(orders.summary, { amount_fen: '100' });
      const refunds = await adminRows('refunds', url({ user: 'alpha', status: 'pending' }));
      assert.equal(refunds.total, 1); assert.deepEqual(refunds.summary, { amount: '1000000' });
      assert.equal((await adminRows('routes', url({ service: 'search', status: 'disabled' }))).rows[0]!.id, 'filter-search');
      assert.equal((await adminRows('prices', url({ service: 'search', route: 'filter-search', from: seeded.day, to: seeded.day }))).total, 1);
      assert.equal((await adminRows('users', url({ user: 'alpha', status: 'active' }))).total, 1);
      assert.equal((await adminRows('keys', url({ user: 'alpha', status: 'active' }))).total, 1);
    });
    await t.test('invalid impossible duplicate unknown and unsupported filters fail closed instead of exporting all rows', async () => {
      for (const query of ['from=2026-02-29', 'from=0000-01-01', 'from=2026-11-08&to=2026-11-07', 'status=anything', 'service=anything', 'from=2026-11-07&from=2026-11-08', 'state=settled', 'pageSize=10&pageSize=20']) {
        await assert.rejects(() => adminRows('usage', new URL('http://local/?' + query), true), { status: 400 });
      }
      await assert.rejects(() => adminRows('orders', url({ service: 'chat' }), true), { status: 400 });
      assert.equal((await adminRows('usage', url({ from: '2028-02-29', to: '2028-02-29' }))).total, 0);
    });
    const password = randomBytes(24).toString('base64url'), hashed = await hashPassword(password);
    await database().db.insert(tables.account).values(seeded.users.map(user => ({ id: randomUUID(), accountId: user.id, providerId: 'credential', userId: user.id, password: hashed })));
    await database().db.insert(tables.userRoles).values({ userId: seeded.users[1]!.id, roleId: 'admin' });
    const cookies: string[] = [];
    for (const user of seeded.users) {
      const response = await authentication().handler(new Request(process.env.AUTH_URL + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: process.env.AUTH_URL, 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) }));
      assert.equal(response.status, 200);
      const cookie = response.headers.getSetCookie().find(value => value.startsWith('ccagent.session_token='))?.split(';')[0]; assert.ok(cookie); cookies.push(cookie);
    }
    await t.test('real endpoint rejects anonymous and ordinary users; CSV keeps all selected filters and records safe audit metadata', async () => {
      const query = new URLSearchParams({ ...selected, format: 'csv', page: '2', pageSize: '1' });
      const invoke = (cookie = '', suffix = query.toString()) => GET(new Request(`${process.env.AUTH_URL}/api/admin/data/usage?${suffix}`, { headers: { cookie } }), { params: Promise.resolve({ section: 'usage' }) });
      assert.equal((await invoke()).status, 401); assert.equal((await invoke(cookies[0])).status, 403);
      assert.equal((await invoke(cookies[1], 'format=csv&from=2026-02-29')).status, 400);
      const exported = await invoke(cookies[1]); assert.equal(exported.status, 200);
      const csv = await exported.text();
      assert.equal(seeded.callIds.filter(id => csv.includes(id)).length, 2);
      assert(csv.includes(seeded.callIds[1]!)); assert(csv.includes(seeded.callIds[2]!));
      assert(!/password|secret|hash/i.test(csv));
      const audit = (await database().db.select().from(tables.audit)).filter(row => row.action === 'data.export');
      assert.equal(audit.length, 1); const metadata = audit[0]!.metadata as { rows: number; total: number; filterFields: string[]; filterSha256: string };
      assert.equal(metadata.rows, 2); assert.equal(metadata.total, 2); assert(metadata.filterFields.includes('user')); assert.match(metadata.filterSha256, /^[a-f0-9]{64}$/);
      assert(!JSON.stringify(metadata).includes(seeded.users[0]!.id));
    });
  } finally { await closeDatabase(); await fixture.cleanup(); }
});
