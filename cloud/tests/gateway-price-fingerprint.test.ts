import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { hashPassword } from 'better-auth/crypto';
import { isolatedDatabase } from './database-fixture';

test('price saves bind the administrator snapshot to the locked current route', { timeout: 120000 }, async t => {
  const fixture = await isolatedDatabase();
  const originalEnv = { AUTH_URL: process.env.AUTH_URL, AUTH_SECRET: process.env.AUTH_SECRET };
  process.env.AUTH_URL = 'http://127.0.0.1:4310'; process.env.AUTH_SECRET = randomBytes(48).toString('base64');
  const { database, closeDatabase } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  const { authentication } = await import('../src/core/auth');
  const { routeInput, priceInput, saveRoute, routeFingerprint } = await import('../src/core/catalog');
  const routeApi = await import('../src/app/api/admin/routes/route');
  const priceApi = await import('../src/app/api/admin/prices/route');
  const actor = randomUUID(), password = randomBytes(24).toString('base64url');
  const route = routeInput.parse({ id: 'price-fingerprint-fixture', name: 'Price concurrency fixture', provider: 'fixture', service: 'chat', protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com/v1', upstreamModel: 'loaded-model', enabled: false, options: {} });
  const value = { routeId: route.id, currency: 'CNY', definition: { rates: [
    { metric: 'input_tokens', price: '1', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '1', unitQuantity: '1000000' },
  ], tariff: { kind: 'constant' } }, sourceUrl: 'https://example.invalid/pricing', effectiveAt: new Date(Date.now() - 1000).toISOString() };
  let cookie = '';
  const request = (path: string, method = 'GET', body?: unknown) => new Request(process.env.AUTH_URL + path, { method,
    headers: { origin: process.env.AUTH_URL!, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    await database().db.insert(tables.user).values({ id: actor, name: 'Price concurrency fixture', email: `${actor}@example.invalid`, emailVerified: true });
    await database().db.insert(tables.userRoles).values({ userId: actor, roleId: 'admin' });
    await database().db.insert(tables.account).values({ id: randomUUID(), userId: actor, accountId: actor, providerId: 'credential', password: await hashPassword(password) });
    const login = await authentication().handler(request('/api/auth/sign-in/email', 'POST', { email: `${actor}@example.invalid`, password }));
    assert.equal(login.status, 200); cookie = login.headers.getSetCookie().find(value => value.startsWith('ccagent.session_token='))!.split(';')[0];
    await saveRoute(actor, route);

    await t.test('GET exposes only the public route hash and price input validates the optional hash', async () => {
      const response = await routeApi.GET(request('/api/admin/routes?id=' + route.id));
      assert.equal(response.status, 200); const loaded = await response.json();
      assert.equal(loaded.routeFingerprint, routeFingerprint(route)); assert.match(loaded.routeFingerprint, /^[a-f0-9]{64}$/);
      assert.equal(priceInput.safeParse(value).success, true);
      assert.equal(priceInput.safeParse({ ...value, expectedRouteFingerprint: loaded.routeFingerprint }).success, true);
      for (const invalid of ['', 'a'.repeat(63), 'g'.repeat(64), 'A'.repeat(64)]) {
        assert.equal(priceInput.safeParse({ ...value, expectedRouteFingerprint: invalid }).success, false);
      }
      const created = await priceApi.POST(request('/api/admin/prices', 'POST', { ...value, expectedRouteFingerprint: loaded.routeFingerprint }));
      assert.equal(created.status, 201); assert.equal((await created.json()).version, 1);
    });
    await t.test('a stale page cannot append a price or audit record after another administrator changes the model', async () => {
      const oldFingerprint = routeFingerprint(route), changed = { ...route, upstreamModel: 'another-admin-model' };
      await saveRoute(actor, changed);
      const before = await database().db.select().from(tables.prices).where(eq(tables.prices.routeId, route.id));
      const beforeAudit = await database().db.select().from(tables.audit).where(eq(tables.audit.action, 'prices.create_version'));
      const rejected = await priceApi.POST(request('/api/admin/prices', 'POST', { ...value, expectedRouteFingerprint: oldFingerprint }));
      assert.equal(rejected.status, 409); assert.equal((await rejected.json()).code, 'ROUTE_CONFIGURATION_CHANGED');
      assert.deepEqual(await database().db.select().from(tables.prices).where(eq(tables.prices.routeId, route.id)), before);
      assert.deepEqual(await database().db.select().from(tables.audit).where(eq(tables.audit.action, 'prices.create_version')), beforeAudit);
      const current = await priceApi.POST(request('/api/admin/prices', 'POST', { ...value, expectedRouteFingerprint: routeFingerprint(changed) }));
      assert.equal(current.status, 201); assert.equal((await current.json()).version, 2);
    });
    await t.test('older clients may still append without the optional snapshot field', async () => {
      const legacy = await priceApi.POST(request('/api/admin/prices', 'POST', value));
      assert.equal(legacy.status, 201); assert.equal((await legacy.json()).version, 3);
    });
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await closeDatabase(); await fixture.cleanup();
  }
});
