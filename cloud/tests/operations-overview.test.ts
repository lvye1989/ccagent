import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { hashPassword } from 'better-auth/crypto';
import { isolatedDatabase } from './database-fixture';
import { seedAdminFilterData } from './admin-filter-data';

test('operational overview counts, bounded pending queues, overdue filters and server-side permission projection', { timeout: 240000 }, async t => {
  const fixture = await isolatedDatabase();
  process.env.AUTH_URL = 'http://127.0.0.1:4310'; process.env.AUTH_SECRET = randomBytes(48).toString('base64url');
  const { database, closeDatabase } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  const { databaseOverview, adminRows } = await import('../src/core/admin-data');
  const { authentication } = await import('../src/core/auth');
  const { GET } = await import('../src/app/api/admin/overview/route');
  try {
    const data = await seedAdminFilterData(), now = Date.now(), past = new Date(now - 1000), future = new Date(now + 86400000);
    await database().db.update(tables.reservations).set({ reconcileAt: past }).where(eq(tables.reservations.id, data.callIds[6]!));
    // Completed/released historical rows with an old deadline must stay out of the pending queue.
    await database().db.update(tables.reservations).set({ reconcileAt: past }).where(eq(tables.reservations.id, data.callIds[7]!));
    const extraCalls = [past, future].map((deadline, index) => ({ id: randomUUID(), userId: data.users[0]!.id, keyId: data.keyIds[0]!, routeId: data.routes[0]!.id,
      taskId: `extra-task-${index}`, idempotencyKey: randomUUID(), requestHash: 'a'.repeat(64), authorized: 1000n, priceSnapshot: {}, status: 'held', reconcileAt: deadline }));
    await database().db.insert(tables.reservations).values(extraCalls);
    const extraOrders = Array.from({ length: 7 }, (_, index) => ({ id: `20261108${String(index).padStart(12, '0')}`, userId: data.users[0]!.id, amountFen: 100n, merchantId: 'fixture',
      createdAt: new Date(now - (10 - index) * 86400000) }));
    await database().db.insert(tables.orders).values(extraOrders);
    for (const [index, status] of ['held', 'submitting', 'success', 'rejected'].entries()) {
      const id = `20261109${String(index).padStart(12, '0')}`;
      await database().db.insert(tables.orders).values({ id, userId: data.users[0]!.id, amountFen: 100n, merchantId: 'fixture', status: 'refunding' });
      await database().db.insert(tables.refunds).values({ id: randomUUID(), orderId: id, userId: data.users[0]!.id, amount: 1000000n, status, initiatedBy: data.users[1]!.id, reason: 'Synthetic read-only operational history' });
    }
    const privateMetadata = randomBytes(32).toString('base64url');
    await database().db.insert(tables.audit).values([
      { id: randomUUID(), action: 'system.maintenance', objectId: 'scheduled', result: 'success', createdAt: new Date(now - 2000), metadata: { privateMetadata } },
      { id: randomUUID(), action: 'system.maintenance', objectId: 'scheduled', result: 'partial', createdAt: new Date(now - 1000), metadata: { privateMetadata } },
    ]);
    await t.test('business quantities and latest maintenance are real exact values without raw audit metadata', async () => {
      const overview = await databaseOverview(); assert.equal(overview.structure.ready, true); assert.ok(overview.counts);
      assert.equal(overview.counts.users, '2'); assert.equal(overview.counts.keys, '2'); assert.equal(overview.counts.orders, '14'); assert.equal(overview.counts.refunds, '5');
      assert.equal(overview.counts.calls, '11'); assert.equal(overview.counts.tasks, '6'); assert.equal(overview.counts.routes, '2'); assert.equal(overview.counts.prices, '2');
      assert.equal(overview.counts.pending_orders, '8'); assert.equal(overview.counts.pending_refunds, '3'); assert.equal(overview.counts.pending_calls, '3'); assert.equal(overview.counts.overdue_calls, '2');
      assert.equal(overview.lastMaintenance?.result, 'partial'); assert.deepEqual(overview.pending, {}); assert(!JSON.stringify(overview).includes(privateMetadata));
    });
    await t.test('pending projections are capped oldest first and contain held submitting and pending refunds', async () => {
      const overview = await databaseOverview(['orders.read', 'refunds.write', 'usage.read']);
      assert.equal(overview.pending.orders?.length, 5);
      assert.deepEqual(overview.pending.orders?.map(row => row.id), extraOrders.slice(0, 5).map(row => row.id));
      assert.equal(overview.pending.refunds?.length, 3); assert.deepEqual(new Set(overview.pending.refunds?.map(row => row.status)), new Set(['held', 'submitting', 'pending']));
      assert.deepEqual(new Set(overview.pending.usage?.map(row => row.id)), new Set([data.callIds[6], extraCalls[0]!.id]));
      const limited = await databaseOverview(['orders.read']); assert.deepEqual(Object.keys(limited.pending), ['orders']);
    });
    await t.test('overdue filters match the queue and combine with existing user service task and export filters', async () => {
      const url = new URL('http://local/?overdue=true');
      const selected = await adminRows('usage', url), exported = await adminRows('usage', url, true);
      assert.deepEqual(new Set(selected.rows.map(row => row.id)), new Set([data.callIds[6], extraCalls[0]!.id])); assert.equal(exported.total, 2);
      const tasks = await adminRows('tasks', new URL(`http://local/?overdue=true&user=${data.users[0]!.id}&service=chat`)); assert.equal(tasks.total, 1); assert.equal(tasks.rows[0]!.task_id, extraCalls[0]!.taskId);
      await assert.rejects(() => adminRows('usage', new URL('http://local/?overdue=false')), { status: 400 });
      await assert.rejects(() => adminRows('orders', url), { status: 400 });
      assert.equal((await database().db.select().from(tables.ledger)).length, 0);
    });
    const password = randomBytes(24).toString('base64url'), hashed = await hashPassword(password);
    await database().db.insert(tables.account).values(data.users.map(user => ({ id: randomUUID(), accountId: user.id, providerId: 'credential', userId: user.id, password: hashed })));
    await database().db.insert(tables.userRoles).values({ userId: data.users[1]!.id, roleId: 'admin' });
    const cookies: string[] = [];
    for (const user of data.users) {
      const response = await authentication().handler(new Request(process.env.AUTH_URL + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: process.env.AUTH_URL, 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) }));
      assert.equal(response.status, 200); const cookie = response.headers.getSetCookie().find(value => value.startsWith('ccagent.session_token='))?.split(';')[0]; assert.ok(cookie); cookies.push(cookie);
    }
    const invoke = (cookie = '') => GET(new Request(process.env.AUTH_URL + '/api/admin/overview?permissions=orders.read,refunds.write,usage.read', { headers: { cookie } }));
    await t.test('real API authorization rejects ordinary users and never trusts requested permission names', async () => {
      assert.equal((await invoke()).status, 401); assert.equal((await invoke(cookies[0])).status, 403);
      const full = await invoke(cookies[1]); assert.equal(full.status, 200); assert.deepEqual(Object.keys((await full.json()).pending).sort(), ['orders', 'refunds', 'usage']);
      await fixture.owner.unsafe(`insert into "${fixture.schema}".roles(id,name) values ('health-reader','Health reader')`);
      await fixture.owner.unsafe(`insert into "${fixture.schema}".role_permissions(role_id,permission_id) values ('health-reader','data.read')`);
      await database().db.delete(tables.userRoles).where(eq(tables.userRoles.userId, data.users[1]!.id));
      await database().db.insert(tables.userRoles).values({ userId: data.users[1]!.id, roleId: 'health-reader' });
      const restricted = await invoke(cookies[1]); assert.equal(restricted.status, 200); const body = await restricted.json(); assert.deepEqual(body.pending, {}); assert.equal(body.counts.orders, '14');
    });
  } finally { await closeDatabase(); await fixture.cleanup(); }
});
