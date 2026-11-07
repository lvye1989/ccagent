import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

/** Synthetic history only, for the already-created isolated test schema. No gateway or payment calls. */
export async function seedAdminFilterData(existing?: { id: string; email: string }[]) {
  const { database } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  if (!/^ccagent_test_[a-f0-9]{16}$/.test(tables.namespace.schemaName)) throw new Error('TEST_SCHEMA_REQUIRED');
  const users = existing || [
    { id: randomUUID(), email: 'alpha_ops@filters.example.invalid' },
    { id: randomUUID(), email: 'beta@filters.example.invalid' },
  ];
  if (!existing) await database().db.insert(tables.user).values(users.map((user, index) => ({ ...user, name: `Filter user ${index}`, emailVerified: true })));
  const keyIds = users.map(() => randomUUID());
  await database().db.insert(tables.apiKeys).values(users.map((user, index) => ({ id: keyIds[index]!, userId: user.id, name: `Filter key ${index}`, prefix: `fixture-${index}`, hash: randomUUID() })));
  const routes = [{ id: 'filter-chat', service: 'chat' }, { id: 'filter-search', service: 'search' }];
  await database().db.insert(tables.routes).values(routes.map(route => ({ ...route, name: route.id, protocol: route.service === 'chat' ? 'openai-chat' : 'bocha', provider: 'fixture',
    baseUrl: 'https://example.invalid', upstreamModel: 'fixture', credentialEnv: 'CCAGENT_PROVIDER_UNCONFIGURED', enabled: false })));
  await database().db.insert(tables.prices).values(routes.map(route => ({ id: randomUUID(), routeId: route.id, version: 1, currency: 'CNY', components: {}, sourceUrl: 'https://example.invalid/pricing', effectiveAt: new Date('2026-11-06T16:00:00Z') })));
  const rows = [
    { user: 0, route: 0, task: 'task-main', status: 'settled', charged: 900n, at: '2026-11-06T15:59:59.999Z' },
    { user: 0, route: 0, task: 'task-main', status: 'settled', charged: 100n, at: '2026-11-06T16:00:00Z' },
    { user: 0, route: 0, task: 'task-main', status: 'settled', charged: 200n, at: '2026-11-07T04:00:00Z' },
    { user: 0, route: 1, task: 'task-main', status: 'settled', charged: 300n, at: '2026-11-07T15:59:59.999Z' },
    { user: 0, route: 0, task: 'task-main', status: 'settled', charged: 800n, at: '2026-11-07T16:00:00Z' },
    { user: 1, route: 0, task: 'task-main', status: 'settled', charged: 400n, at: '2026-11-07T04:00:00Z' },
    { user: 0, route: 1, task: 'task-other', status: 'pending', charged: 0n, at: '2026-11-07T04:00:00Z' },
    { user: 0, route: 0, task: 'task-main', status: 'released', charged: 0n, at: '2026-11-07T04:00:00Z' },
    { user: 0, route: 0, task: 'task_%literal', status: 'settled', charged: 50n, at: '2026-11-07T04:00:00Z' },
  ];
  const callIds = rows.map(() => randomUUID());
  await database().db.insert(tables.reservations).values(rows.map((row, index) => ({ id: callIds[index]!, userId: users[row.user]!.id, keyId: keyIds[row.user]!, routeId: routes[row.route]!.id,
    taskId: row.task, idempotencyKey: randomUUID(), requestHash: 'f'.repeat(64), status: row.status, authorized: 1000n, charged: row.charged, priceSnapshot: {},
    createdAt: new Date(row.at), reconcileAt: new Date('2026-11-08T00:00:00Z') })));
  await database().db.execute(sql`update ${tables.reservations} set created_at=${'2026-11-07T15:59:59.999999Z'}::timestamptz where id=${callIds[3]}`);
  const orders = [
    { id: '20261107000000000001', userId: users[0]!.id, amountFen: 100n, status: 'credited' },
    { id: '20261107000000000002', userId: users[0]!.id, amountFen: 250n, status: 'pending' },
    { id: '20261107000000000003', userId: users[1]!.id, amountFen: 500n, status: 'credited' },
  ];
  await database().db.insert(tables.orders).values(orders.map(order => ({ ...order, merchantId: 'fixture-not-a-merchant', createdAt: new Date('2026-11-07T04:00:00Z') })));
  await database().db.insert(tables.refunds).values({ id: randomUUID(), orderId: orders[0]!.id, userId: users[0]!.id, amount: 1000000n, status: 'pending', initiatedBy: users[1]!.id,
    reason: 'Synthetic query history; not submitted to any payment provider', createdAt: new Date('2026-11-07T04:00:00Z') });
  return { users, keyIds, routes, callIds, orders, day: '2026-11-07' };
}
