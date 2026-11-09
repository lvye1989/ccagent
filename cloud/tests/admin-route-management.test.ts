import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { hashPassword } from 'better-auth/crypto';
import { isolatedDatabase } from './database-fixture';

test('administrator route CRUD retires secrets and references while preserving financial history', { timeout: 480000 }, async t => {
  const fixture = await isolatedDatabase();
  process.env.AUTH_URL = 'http://127.0.0.1:4310'; process.env.AUTH_SECRET = randomBytes(48).toString('base64');
  const { database, closeDatabase } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  const { authentication } = await import('../src/core/auth');
  const api = await import('../src/app/api/admin/routes/route');
  const priceApi = await import('../src/app/api/admin/prices/route');
  const { routeInput, createPriceVersion, publishedRoute, testableRoute } = await import('../src/core/catalog');
  const { resolveRouteCredential } = await import('../src/core/provider-credentials');
  const { adminRows } = await import('../src/core/admin-data');
  const { adminServiceDefaults, readServiceDefaults, saveServiceDefaults } = await import('../src/core/service-defaults');
  const { availableModels, createGateway } = await import('../src/core/gateway');
  const { createRouteTests } = await import('../src/core/route-tests');
  const { createKey } = await import('../src/core/keys');
  const { authorizeUsage, finishUsage, postLedger, walletFor } = await import('../src/core/wallet');
  const admin = randomUUID(), ordinary = randomUUID(), readOnly = randomUUID(), origin = process.env.AUTH_URL;
  const secret = 'synthetic-route-management-' + randomBytes(24).toString('hex'), password = randomBytes(24).toString('base64url');
  const cookies = new Map<string, string>();
  const route = routeInput.parse({ id: 'admin-route-main', name: '管理员主路由', service: 'chat', protocol: 'openai-chat', provider: 'fixture',
    baseUrl: 'https://api.deepseek.com/v1', upstreamModel: 'synthetic-model', options: {} });
  const request = (path: string, method = 'GET', body?: unknown, cookie = cookies.get(admin) || '', source = origin) => new Request(origin + path, {
    method, headers: { origin: source, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const get = (id = route.id, cookie = cookies.get(admin) || '') => api.GET(request('/api/admin/routes?id=' + id, 'GET', undefined, cookie));
  const read = async (id = route.id) => { const response = await get(id); assert.equal(response.status, 200); return await response.json(); };
  const save = (body: unknown, cookie = cookies.get(admin) || '') => api.PUT(request('/api/admin/routes', 'PUT', body, cookie));
  const price = (id: string) => ({ routeId: id, currency: 'CNY' as const, definition: { rates: [
    { metric: 'input_tokens' as const, price: '1', unitQuantity: '1000000' }, { metric: 'output_tokens' as const, price: '1', unitQuantity: '1000000' },
  ], tariff: { kind: 'constant' as const } }, sourceUrl: 'https://example.invalid/pricing', effectiveAt: new Date(Date.now() - 1000).toISOString() });
  const noSecret = (value: unknown) => { const text = JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item); assert.ok(!text.includes(secret)); assert.ok(!text.includes('ciphertext')); };
  let calls = 0, key: Awaited<ReturnType<typeof createKey>>, reservationId = '', pricesBefore: unknown;
  try {
    await database().db.insert(tables.user).values([admin, ordinary, readOnly].map(id => ({ id, name: 'Route management fixture', email: `${id}@example.invalid`, emailVerified: true })));
    await database().db.insert(tables.roles).values({ id: 'route-reader-fixture', name: 'Route reader fixture' });
    await database().db.insert(tables.rolePermissions).values({ roleId: 'route-reader-fixture', permissionId: 'admin.read' });
    await database().db.insert(tables.userRoles).values([{ userId: admin, roleId: 'admin' }, { userId: readOnly, roleId: 'route-reader-fixture' }]);
    await database().db.insert(tables.account).values(await Promise.all([admin, ordinary, readOnly].map(async id => ({ id: randomUUID(), userId: id, accountId: id, providerId: 'credential', password: await hashPassword(password) }))));
    for (const id of [admin, ordinary, readOnly]) {
      const response = await authentication().handler(request('/api/auth/sign-in/email', 'POST', { email: `${id}@example.invalid`, password }));
      assert.equal(response.status, 200); cookies.set(id, response.headers.getSetCookie().find(value => value.startsWith('ccagent.session_token='))!.split(';')[0]);
    }
    await t.test('anonymous/ordinary users are denied; read-only permission never permits writes; mutations require same origin', async () => {
      assert.equal((await api.GET(request('/api/admin/routes', 'GET', undefined, ''))).status, 401);
      assert.equal((await api.GET(request('/api/admin/routes', 'GET', undefined, cookies.get(ordinary)))).status, 403);
      assert.equal((await api.GET(request('/api/admin/routes', 'GET', undefined, cookies.get(readOnly)))).status, 200);
      for (const method of ['POST', 'PUT', 'DELETE'] as const) {
        const invoke = api[method];
        assert.equal((await invoke(request('/api/admin/routes', method, method === 'DELETE' ? { id: route.id } : route, cookies.get(ordinary)))).status, 403);
        assert.equal((await invoke(request('/api/admin/routes', method, method === 'DELETE' ? { id: route.id } : route, cookies.get(readOnly)))).status, 403);
        assert.equal((await invoke(request('/api/admin/routes', method, method === 'DELETE' ? { id: route.id } : route, cookies.get(admin), 'https://evil.invalid'))).status, 403);
      }
    });
    await t.test('POST creates once, GET exposes only safe fields/status and list filters never expose managed records', async () => {
      const response = await api.POST(request('/api/admin/routes', 'POST', { ...route, apiKey: secret }));
      assert.equal(response.status, 201); noSecret(await response.json());
      const loaded = await read(); assert.equal(loaded.route.id, route.id); assert.equal(loaded.credentialStatus.configured, true); assert.equal(loaded.ready, false); noSecret(loaded);
      assert.match(loaded.route.updatedAt, /^\d{4}-\d{2}-\d{2}T/); assert.equal(await resolveRouteCredential(loaded.route), secret);
      assert.equal((await get(route.id, cookies.get(readOnly))).status, 200);
      const duplicate = await api.POST(request('/api/admin/routes', 'POST', { ...route, name: 'must-not-overwrite', apiKey: 'synthetic-different-secret' }));
      assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).code, 'ROUTE_ALREADY_EXISTS');
      assert.equal((await read()).route.name, route.name); assert.equal(await resolveRouteCredential(loaded.route), secret);
      const listed = await api.GET(request('/api/admin/routes?service=chat&status=disabled&pageSize=1'));
      const body = await listed.json(); assert.equal(listed.status, 200); assert.equal(body.total, 1); assert.equal(body.rows[0].credential_configured, true); noSecret(body);
      assert.equal((await api.GET(request('/api/admin/routes?id=' + route.id + '&q=other'))).status, 400);
    });
    await t.test('optimistic updates are atomic, including same-tick saves, while old PUT clients remain compatible', async () => {
      const loaded = await read(), { createdAt: _created, updatedAt, ...editable } = loaded.route;
      const results = await Promise.all(['first editor', 'second editor'].map(name => save({ ...editable, name, expectedUpdatedAt: updatedAt })));
      assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
      const current = await read(); assert.ok(new Date(current.route.updatedAt).getTime() > new Date(updatedAt).getTime());
      const before = await database().db.select().from(tables.audit);
      const stale = await save({ ...editable, name: 'stale editor', apiKey: 'synthetic-stale-secret', expectedUpdatedAt: updatedAt });
      assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'ROUTE_CONFIGURATION_CHANGED');
      assert.equal((await database().db.select().from(tables.audit)).length, before.length); assert.equal(await resolveRouteCredential(current.route), secret);
      assert.equal((await api.DELETE(request('/api/admin/routes', 'DELETE', { id: route.id, expectedUpdatedAt: updatedAt }))).status, 409);
      assert.equal((await save({ ...route, id: 'legacy-admin-draft' })).status, 200);
      assert.equal((await save({ ...route, id: 'legacy-admin-draft', name: 'legacy update' })).status, 200);
    });
    await t.test('image protocols support paused configuration but cannot be enabled, tested or publicly advertised', async () => {
      const tester = createRouteTests({ fetch: async () => { calls++; throw new Error('MUST_NOT_CALL_SUPPLIER'); } });
      for (const protocol of ['openai-images', 'dashscope-images'] as const) {
        const draft = routeInput.parse({ ...route, id: protocol + '-draft', service: 'image', protocol });
        assert.equal((await api.POST(request('/api/admin/routes', 'POST', { ...draft, apiKey: secret }))).status, 201);
        const loaded = await read(draft.id); assert.deepEqual(loaded.capabilities, { executionSupported: false, configurationOnly: true }); assert.equal(loaded.ready, false);
        await createPriceVersion(admin, price(draft.id));
        const enable = await save({ ...draft, enabled: true }); assert.equal(enable.status, 409); assert.equal((await enable.json()).code, 'PROTOCOL_NOT_READY');
        await assert.rejects(() => testableRoute(draft.id), { code: 'PROTOCOL_NOT_READY' });
        const testPlan = await tester.get(request('/api/admin/routes/test?routeId=' + draft.id)); assert.equal(testPlan.status, 409);
      }
      assert.equal(calls, 0); assert.equal(routeInput.safeParse({ ...route, service: 'image' }).success, false);
    });
    await t.test('retiring a historical route removes defaults/fallbacks and credentials without touching prices or current holds', async () => {
      const loaded = await read(), { createdAt: _created, updatedAt, ...editable } = loaded.route;
      await createPriceVersion(admin, price(route.id));
      assert.equal((await save({ ...editable, enabled: true, expectedUpdatedAt: updatedAt })).status, 200);
      const dependent = routeInput.parse({ ...route, id: 'admin-route-dependent', options: { ...route.options, fallbackEnabled: true, fallbackRouteId: route.id } });
      assert.equal((await api.POST(request('/api/admin/routes', 'POST', { ...dependent, apiKey: secret }))).status, 201);
      await createPriceVersion(admin, price(dependent.id)); assert.equal((await save({ ...dependent, enabled: true })).status, 200);
      await saveServiceDefaults(admin, { version: 0, routes: { chat: route.id, vision: null, decision: null, search: null, voice: null, image: null } });
      key = await createKey(ordinary, 'route history fixture');
      await database().db.transaction(tx => postLedger(tx, ordinary, 'route-admin-fixture-credit', 'recharge', 1000000n, 0n));
      const held = await authorizeUsage({ userId: ordinary, keyId: key.key.id, routeId: route.id, taskId: 'historical-route-hold',
        idempotencyKey: randomUUID(), requestHash: randomBytes(32).toString('hex'), authorized: 1000n, priceSnapshot: { priceVersion: 1, fixture: true } });
      reservationId = held.reservation.id; pricesBefore = await database().db.select().from(tables.prices).where(eq(tables.prices.routeId, route.id));
      const beforeWallet = await walletFor(ordinary), latest = await read();
      const response = await api.DELETE(request('/api/admin/routes', 'DELETE', { id: route.id, expectedUpdatedAt: latest.route.updatedAt }));
      const deleted = await response.json(); assert.equal(response.status, 200); assert.equal(deleted.deleted, true); assert.equal(deleted.mode, 'archived');
      assert.deepEqual(await walletFor(ordinary), beforeWallet); assert.deepEqual(await database().db.select().from(tables.prices).where(eq(tables.prices.routeId, route.id)), pricesBefore);
      const [parent] = await database().db.select().from(tables.routes).where(eq(tables.routes.id, dependent.id));
      assert.equal(parent.enabled, true); assert.equal((parent.options as any).fallbackEnabled, false); assert.equal((parent.options as any).fallbackRouteId, null);
      assert.equal((await readServiceDefaults()).routes.chat, null); assert.equal((await readServiceDefaults()).version, 2);
      assert.ok(!(await adminServiceDefaults()).choices.some(choice => choice.id === route.id));
      await assert.rejects(() => resolveRouteCredential(latest.route), { code: 'PROVIDER_CREDENTIAL_DISABLED' });
      assert.equal((await get()).status, 410); await assert.rejects(() => publishedRoute(route.id), { status: 404 }); await assert.rejects(() => testableRoute(route.id), { status: 404 });
      assert.ok(!(await adminRows('routes', new URL(origin))).rows.some(row => row.id === route.id));
      const catalog = await availableModels(new Request(origin + '/v1/models', { headers: { cookie: cookies.get(ordinary)!, authorization: 'Bearer ' + key.secret } }));
      assert.ok(!catalog.data.some(item => item.id === route.id || item.service === 'image')); assert.equal(catalog.defaults.chat, null);
      const blocked = await createGateway({ fetch: async () => { calls++; throw new Error('MUST_NOT_CALL_SUPPLIER'); } }).execute(new Request(origin + '/v1/chat/completions', {
        method: 'POST', headers: { cookie: cookies.get(ordinary)!, authorization: 'Bearer ' + key.secret, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify({ model: route.id, messages: [{ role: 'user', content: 'Synthetic retired route check' }], max_tokens: 8 }),
      }), 'chat');
      assert.equal(blocked.status, 404); assert.deepEqual(await walletFor(ordinary), beforeWallet); assert.equal(calls, 0);
      await assert.rejects(() => saveServiceDefaults(admin, { version: 2, routes: { chat: route.id, vision: null, decision: null, search: null, voice: null, image: null } }), { code: 'DEFAULT_SERVICE_NOT_READY' });
    });
    await t.test('retired identifiers cannot be resurrected or re-priced, and historical settlement still releases the original hold', async () => {
      for (const method of ['PUT', 'POST'] as const) { const response = await api[method](request('/api/admin/routes', method, { ...route, apiKey: secret })); assert.equal(response.status, 410); assert.equal((await response.json()).code, 'ROUTE_DELETED'); }
      assert.equal((await priceApi.POST(request('/api/admin/prices', 'POST', price(route.id)))).status, 410);
      assert.equal((await save({ ...route, id: 'legacy-admin-draft', options: { ...route.options, fallbackRouteId: route.id } })).status, 410);
      const beforeAudit = (await database().db.select().from(tables.audit)).length;
      const replay = await api.DELETE(request('/api/admin/routes', 'DELETE', { id: route.id })); assert.equal(replay.status, 200); assert.equal((await replay.json()).replayed, true);
      assert.equal((await database().db.select().from(tables.audit)).length, beforeAudit);
      await finishUsage({ userId: ordinary, reservationId, charged: 234n, usage: { fixture: true } });
      assert.equal((await walletFor(ordinary)).balance, 999766n); assert.equal((await walletFor(ordinary)).frozen, 0n);
      const [history] = await database().db.select().from(tables.reservations).where(eq(tables.reservations.id, reservationId));
      assert.equal(history.status, 'settled'); assert.equal(history.routeId, route.id); assert.deepEqual(history.priceSnapshot, { priceVersion: 1, fixture: true });
      assert.deepEqual(await database().db.select().from(tables.prices).where(eq(tables.prices.routeId, route.id)), pricesBefore);
      // A tombstone, rather than only enabled=false, excludes every catalog path.
      await database().db.update(tables.routes).set({ enabled: true }).where(eq(tables.routes.id, route.id));
      await assert.rejects(() => publishedRoute(route.id), { status: 404 });
      assert.ok(!(await adminRows('routes', new URL(origin))).rows.some(row => row.id === route.id));
      noSecret(await database().db.select().from(tables.audit)); assert.equal(calls, 0);
    });
  } finally { await closeDatabase(); await fixture.cleanup(); }
});
