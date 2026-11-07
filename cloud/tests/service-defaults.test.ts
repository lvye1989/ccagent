import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { hashPassword } from 'better-auth/crypto';
import { isolatedDatabase } from './database-fixture';

test('platform default routes use real authorization, catalog readiness, atomic versioning and no implicit substitution', { timeout: 240000 }, async t => {
  const fixture = await isolatedDatabase();
  process.env.AUTH_URL = 'http://127.0.0.1:4310'; process.env.AUTH_SECRET = randomBytes(48).toString('base64url'); process.env.DB_MAX_CONNECTIONS = '1';
  const credentialEnv = 'CCAGENT_PROVIDER_DEFAULT_FIXTURE', secret = randomBytes(32).toString('hex');
  process.env[credentialEnv] = secret;
  const { database, closeDatabase } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  const { authentication } = await import('../src/core/auth');
  const { GET, PUT } = await import('../src/app/api/admin/routes/defaults/route');
  const { readServiceDefaults, saveServiceDefaults, serviceDefaultsInput } = await import('../src/core/service-defaults');
  const { configuration } = await import('../src/core/configuration');
  const { routeInput, saveRoute, createPriceVersion, priceDefinition } = await import('../src/core/catalog');
  const { availableModels } = await import('../src/core/gateway');
  const { createKey } = await import('../src/core/keys');
  const adminId = randomUUID(), userId = randomUUID(), empty = { chat: null, vision: null, decision: null, search: null, voice: null };
  const users = [adminId, userId].map(id => ({ id, name: 'Defaults fixture', email: `${id}@example.invalid`, emailVerified: true }));
  const password = randomBytes(24).toString('base64url'); let adminCookie = '', userCookie = '';
  const request = (method = 'GET', value?: unknown, cookie = adminCookie, origin = process.env.AUTH_URL!) => new Request(`${process.env.AUTH_URL}/api/admin/routes/defaults`,
    { method, headers: { cookie, origin, 'content-type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const definition = priceDefinition.parse({ rates: [{ metric: 'input_tokens', price: '1', unitQuantity: '1000000' }, { metric: 'cached_input_tokens', price: '0', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '1', unitQuantity: '1000000' }], tariff: { kind: 'constant' } });
  const base = routeInput.parse({ id: 'default-a', name: 'Default A', service: 'chat', protocol: 'openai-responses', provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1', upstreamModel: 'synthetic-default-fixture', credentialEnv, options: {} });
  try {
    await database().db.insert(tables.user).values(users);
    await database().db.insert(tables.account).values(await Promise.all(users.map(async user => ({ id: randomUUID(), userId: user.id, accountId: user.id, providerId: 'credential', password: await hashPassword(password) }))));
    await database().db.insert(tables.userRoles).values({ userId: adminId, roleId: 'admin' });
    for (const [index, user] of users.entries()) {
      const login = await authentication().handler(new Request(`${process.env.AUTH_URL}/api/auth/sign-in/email`, { method: 'POST', headers: { origin: process.env.AUTH_URL!, 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) }));
      assert.equal(login.status, 200);
      const cookie = login.headers.getSetCookie().find(value => value.startsWith('ccagent.session_token='))!.split(';')[0]!;
      if (index === 0) adminCookie = cookie; else userCookie = cookie;
    }
    const personalKey = await createKey(userId, 'Synthetic default discovery');
    const discover = () => availableModels(new Request(`${process.env.AUTH_URL}/v1/models`, { headers: { cookie: userCookie, authorization: `Bearer ${personalKey.secret}` } }));
    await t.test('real sessions and route-write permission protect reads and writes including same-origin enforcement', async () => {
      assert.equal((await GET(request('GET', undefined, ''))).status, 401);
      assert.equal((await GET(request('GET', undefined, userCookie))).status, 403);
      assert.equal((await PUT(request('PUT', { version: 0, routes: empty }, userCookie))).status, 403);
      assert.equal((await PUT(request('PUT', { version: 0, routes: empty }, adminCookie, 'https://attacker.invalid'))).status, 403);
      const response = await GET(request()); assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).routes, empty);
      assert.deepEqual((await discover()).defaults, empty);
    });
    await t.test('field whitelist rejects unknown services credentials invalid ids and missing version', async () => {
      for (const value of [{ routes: empty }, { version: 0, routes: { ...empty, apiKey: secret } }, { version: 0, routes: { ...empty, chat: 'https://attacker.invalid' } }, { version: -1, routes: empty }]) {
        assert.equal(serviceDefaultsInput.safeParse(value).success, false);
        assert.equal((await PUT(request('PUT', value))).status, 400);
      }
      assert.equal((await readServiceDefaults()).version, 0);
    });
    await t.test('disabled unpriced credentialless and type-mismatched choices cannot be saved even with a valid session', async () => {
      await saveRoute(adminId, base);
      assert.equal((await PUT(request('PUT', { version: 0, routes: { ...empty, chat: base.id } }))).status, 409);
      await createPriceVersion(adminId, { routeId: base.id, currency: 'CNY', definition, sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', effectiveAt: new Date(Date.now() - 1000).toISOString() });
      await saveRoute(adminId, { ...base, enabled: true });
      delete process.env[credentialEnv];
      assert.equal((await PUT(request('PUT', { version: 0, routes: { ...empty, chat: base.id } }))).status, 409);
      process.env[credentialEnv] = secret;
      assert.equal((await PUT(request('PUT', { version: 0, routes: { ...empty, vision: base.id } }))).status, 409);
      assert.equal((await readServiceDefaults()).version, 0);
    });
    await t.test('save persists exact selection and version without expanding the original five settings or echoing secrets', async () => {
      const response = await PUT(request('PUT', { version: 0, routes: { ...empty, chat: base.id } }));
      assert.equal(response.status, 200); const value = await response.json();
      assert.equal(value.version, 1); assert.equal(value.routes.chat, base.id); assert.equal(value.available.chat, base.id);
      assert.ok(!JSON.stringify(value).includes(secret)); assert.ok(!JSON.stringify(value).includes(credentialEnv));
      assert.equal((await configuration()).length, 5);
      assert.equal((await discover()).defaults.chat, base.id);
      const same = await saveServiceDefaults(adminId, { version: 1, routes: { ...empty, chat: base.id } }); assert.equal(same.version, 1);
      const entries = await database().db.select().from(tables.audit).where(eq(tables.audit.action, 'routes.defaults.update'));
      assert.equal(entries.length, 1); assert.deepEqual(entries[0]!.metadata, { services: ['chat'], version: 1 });
    });
    await t.test('two admins sharing one version cannot both overwrite a default and failed multi-service validation is atomic', async () => {
      const changed = { ...empty, chat: null }, invalid = { ...empty, chat: base.id, vision: base.id };
      await assert.rejects(saveServiceDefaults(adminId, { version: 1, routes: invalid }), { status: 409 });
      assert.equal((await readServiceDefaults()).version, 1);
      const results = await Promise.allSettled([saveServiceDefaults(adminId, { version: 1, routes: changed }), saveServiceDefaults(adminId, { version: 1, routes: changed })]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'CONFIGURATION_CHANGED').length, 1);
      assert.equal((await readServiceDefaults()).version, 2);
      await saveServiceDefaults(adminId, { version: 2, routes: { ...empty, chat: base.id } });
    });
    await t.test('withdrawn or uncredentialed routes stop being recommended while saved intent remains visible and no other model replaces them', async () => {
      const second = { ...base, id: 'default-b', name: 'Default B' };
      await saveRoute(adminId, second);
      await createPriceVersion(adminId, { routeId: second.id, currency: 'CNY', definition, sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', effectiveAt: new Date(Date.now() - 1000).toISOString() });
      await saveRoute(adminId, { ...second, enabled: true });
      await saveRoute(adminId, { ...base, enabled: false });
      const catalog = await discover(); assert.equal(catalog.defaults.chat, null); assert.ok(catalog.data.some(route => route.id === second.id));
      const view = await (await GET(request())).json(); assert.equal(view.routes.chat, base.id); assert.equal(view.available.chat, null);
      assert.equal(view.choices.find((route: { id: string }) => route.id === base.id).ready, false);
      assert.equal((await readServiceDefaults()).routes.chat, base.id);
      await saveRoute(adminId, { ...base, enabled: true });
      delete process.env[credentialEnv]; assert.equal((await discover()).defaults.chat, null); process.env[credentialEnv] = secret;
    });
    await t.test('malformed stored data returns a safe error and does not leak the invalid value or silently create a default', async () => {
      const previous = await readServiceDefaults();
      await database().db.update(tables.settings).set({ value: { unexpected: secret } }).where(eq(tables.settings.key, 'service_default_routes'));
      const response = await GET(request()); assert.equal(response.status, 503); assert.ok(!(await response.text()).includes(secret));
      await database().db.update(tables.settings).set({ value: previous.routes }).where(eq(tables.settings.key, 'service_default_routes'));
      assert.equal((await readServiceDefaults()).version, previous.version);
    });
  } finally { delete process.env[credentialEnv]; await closeDatabase(); await fixture.cleanup(); }
});
