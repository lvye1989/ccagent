import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { hashPassword } from 'better-auth/crypto';
import { isolatedDatabase } from './database-fixture';

test('isolated gateway administration: encrypted credentials, public pinned hosts and editable FX', { timeout: 300000 }, async t => {
  const fixture = await isolatedDatabase();
  const originalEnv = Object.fromEntries(['SETTLEMENT_USD_CNY', 'BLOB_READ_WRITE_TOKEN', 'BLOB_STORE_ID', 'CCAGENT_PROVIDER_MANAGED'].map(key => [key, process.env[key]]));
  process.env.AUTH_URL = 'http://127.0.0.1:4310'; process.env.AUTH_SECRET = randomBytes(48).toString('base64');
  process.env.SETTLEMENT_USD_CNY = '7.5'; process.env.BLOB_READ_WRITE_TOKEN = ''; process.env.BLOB_STORE_ID = ''; delete process.env.CCAGENT_PROVIDER_MANAGED;
  const { database, closeDatabase } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  const { authentication } = await import('../src/core/auth');
  const routeApi = await import('../src/app/api/admin/routes/route');
  const configApi = await import('../src/app/api/admin/routes/config/route');
  const { routeInput, saveRoute, createPriceVersion, priceDefinition, publishedRoute } = await import('../src/core/catalog');
  const { resolveRouteCredential } = await import('../src/core/provider-credentials');
  const { configurationValues } = await import('../src/core/configuration');
  const hosts = await import('../src/core/upstream-hosts');
  const { createGateway } = await import('../src/core/gateway');
  const { createRouteTests } = await import('../src/core/route-tests');
  const { createKey } = await import('../src/core/keys');
  const { postLedger, walletFor } = await import('../src/core/wallet');
  const admin = randomUUID(), ordinary = randomUUID(), password = randomBytes(24).toString('base64url');
  const secret = 'synthetic-managed-' + randomBytes(30).toString('hex');
  const origin = process.env.AUTH_URL;
  const request = (url: string, method = 'GET', body?: unknown, cookie = '', source = origin) => new Request(origin + url, {
    method, headers: { origin: source, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const route = routeInput.parse({ id: 'managed-admin', name: 'Managed fixture', provider: 'fixture', service: 'chat', protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com/v1', upstreamModel: 'synthetic-model', enabled: false, options: { contextWindow: 4096, maxOutputTokens: 64 } });
  const definition = priceDefinition.parse({ rates: [{ metric: 'input_tokens', price: '1', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '1', unitQuantity: '1000000' }], tariff: { kind: 'constant' } });
  let adminCookie = '', userCookie = '';
  const getConfig = async () => { const response = await configApi.GET(request('/api/admin/routes/config', 'GET', undefined, adminCookie)); assert.equal(response.status, 200); return await response.json() as any; };
  const save = (value: unknown, cookie = adminCookie) => routeApi.PUT(request('/api/admin/routes', 'PUT', value, cookie));
  const noSecret = (value: unknown) => assert.ok(!JSON.stringify(value).includes(secret));
  const price = (id: string) => createPriceVersion(admin, { routeId: id, currency: 'CNY', definition, sourceUrl: 'https://example.invalid/pricing', effectiveAt: new Date(Date.now() - 1000).toISOString() });
  let calls = 0;
  const supplier: typeof fetch = async (_url, init) => {
    calls++; assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + secret); assert.equal(init?.redirect, 'error');
    return Response.json({ choices: [{ message: { content: secret + ' synthetic response' } }], usage: { prompt_tokens: 10, completion_tokens: 4 } });
  };
  const dnsMock = t.mock.method(dns, 'lookup', (async (name: string) => name.startsWith('mixed.') ? [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]
    : name.startsWith('private.') ? [{ address: '10.1.2.3', family: 4 }] : [{ address: '8.8.8.8', family: 4 }]) as unknown as typeof dns.lookup);
  try {
    await database().db.insert(tables.user).values([admin, ordinary].map(id => ({ id, email: `${id}@example.invalid`, name: 'Gateway configuration fixture', emailVerified: true })));
    await database().db.insert(tables.userRoles).values({ userId: admin, roleId: 'admin' });
    await database().db.insert(tables.account).values(await Promise.all([admin, ordinary].map(async id => ({ id: randomUUID(), userId: id, accountId: id, providerId: 'credential', password: await hashPassword(password) }))));
    for (const id of [admin, ordinary]) {
      const response = await authentication().handler(request('/api/auth/sign-in/email', 'POST', { email: `${id}@example.invalid`, password }));
      assert.equal(response.status, 200); const cookie = response.headers.getSetCookie().find(value => value.startsWith('ccagent.session_token='))!.split(';')[0];
      if (id === admin) adminCookie = cookie; else userCookie = cookie;
    }
    await t.test('gateway configuration and credentials require administrator permission and same origin', async () => {
      assert.equal((await configApi.GET(request('/api/admin/routes/config'))).status, 401);
      assert.equal((await configApi.GET(request('/api/admin/routes/config', 'GET', undefined, userCookie))).status, 403);
      assert.equal((await configApi.PUT(request('/api/admin/routes/config', 'PUT', { version: 0, allowedHosts: [] }, userCookie))).status, 403);
      assert.equal((await configApi.PUT(request('/api/admin/routes/config', 'PUT', { version: 0, allowedHosts: [] }, adminCookie, 'https://evil.invalid'))).status, 403);
      assert.equal((await save({ ...route, apiKey: secret }, userCookie)).status, 403);
    });
    await t.test('backend FX overrides the old environment immediately with optimistic versions', async () => {
      const before = await getConfig(); assert.equal(before.usdCny, '7.5'); assert.equal(before.fxSource, 'environment'); assert.equal(before.fxReadonly, false);
      const response = await configApi.PUT(request('/api/admin/routes/config', 'PUT', { version: before.version, allowedHosts: [], usdCny: '7.25', fxVersion: before.fxVersion }, adminCookie));
      assert.equal(response.status, 200); const current = await response.json() as any; assert.equal(current.usdCny, '7.25'); assert.equal(current.fxSource, 'database');
      assert.equal((await configurationValues()).settlement_usd_cny, '7.25');
      assert.equal((await configApi.PUT(request('/api/admin/routes/config', 'PUT', { version: before.version, allowedHosts: [], usdCny: '7.3', fxVersion: 0 }, adminCookie))).status, 409);
      assert.equal((await getConfig()).usdCny, '7.25');
    });
    await t.test('route API saves a managed Key with no env, supports price then enable and never returns plaintext', async () => {
      const { credentialEnv: _reference, ...withoutEnvironment } = route;
      const created = await save({ ...withoutEnvironment, apiKey: secret }); assert.equal(created.status, 200); noSecret(await created.json());
      await price(route.id);
      assert.equal((await save({ ...withoutEnvironment, enabled: true })).status, 200);
      const response = await routeApi.GET(request('/api/admin/routes?id=' + route.id, 'GET', undefined, adminCookie));
      const value = await response.json() as any; assert.equal(response.status, 200); noSecret(value);
      assert.deepEqual(value.credentialStatus, { configured: true, source: 'managed' }); assert.equal(value.credentialConfigured, true); assert.equal(value.ready, true);
      assert.equal(await resolveRouteCredential(value.route), secret);
      noSecret(await database().db.select().from(tables.settings)); noSecret(await database().db.select().from(tables.audit));
    });
    await t.test('actual gateway resolves the managed Key and redacts provider echoes while preserving real billing', async () => {
      const key = await createKey(ordinary, 'managed gateway fixture');
      await database().db.transaction(tx => postLedger(tx, ordinary, 'fixture-credit', 'recharge', 1000000n, 0n));
      const gateway = createGateway({ fetch: supplier });
      const call = new Request(origin + '/v1/chat/completions', { method: 'POST', headers: { cookie: userCookie, authorization: `Bearer ${key.secret}`,
        'content-type': 'application/json', 'idempotency-key': randomUUID(), 'x-ccagent-task-id': 'managed-gateway-fixture' },
      body: JSON.stringify({ model: route.id, messages: [{ role: 'user', content: 'Synthetic managed credential check' }], max_tokens: 8 }) });
      const before = await walletFor(ordinary); const response = await gateway.execute(call, 'chat');
      assert.equal(response.status, 200); assert.ok(!(await response.text()).includes(secret));
      assert.ok((await walletFor(ordinary)).balance < before.balance); assert.equal(calls, 1);
      noSecret(await database().db.select().from(tables.audit));
    });
    await t.test('administrator connection test also resolves managed Key and keeps output out of audit/JSON', async () => {
      const jobs: Promise<void>[] = [], tester = createRouteTests({ fetch: supplier, keepAlive: work => jobs.push(work) });
      const ready = await tester.get(request('/api/admin/routes/test?routeId=' + route.id, 'GET', undefined, adminCookie));
      assert.equal(ready.status, 200); const quote = (await ready.json()).quote;
      const id = randomUUID(), response = await tester.post(request('/api/admin/routes/test', 'POST', { routeId: route.id, testId: id, confirmationFingerprint: quote.confirmationFingerprint, confirmPlatformCost: true }, adminCookie));
      assert.equal(response.status, 202); noSecret(await response.json()); await Promise.all(jobs);
      const status = await tester.get(request('/api/admin/routes/test?routeId=' + route.id + '&testId=' + id, 'GET', undefined, adminCookie));
      const result = await status.json(); assert.equal(result.test.status, 'succeeded'); noSecret(result); noSecret(await database().db.select().from(tables.audit)); assert.equal(calls, 2);
    });
    await t.test('remove Key pauses service and never falls back to an old environment value', async () => {
      process.env.CCAGENT_PROVIDER_MANAGED = 'synthetic-old-env';
      const response = await save({ ...route, enabled: true, removeApiKey: true }); assert.equal(response.status, 200); assert.equal((await response.json()).enabled, false);
      const stored = (await database().db.select().from(tables.routes).where(eq(tables.routes.id, route.id)))[0];
      await assert.rejects(() => resolveRouteCredential(stored), { code: 'PROVIDER_CREDENTIAL_DISABLED' });
      assert.equal((await routeApi.GET(request('/api/admin/routes?id=' + route.id, 'GET', undefined, adminCookie))).status, 200);
      await assert.rejects(() => publishedRoute(route.id), { status: 404 });
    });
    await t.test('changing upstream destination pauses and invalidates old Key without sending it to the new address', async () => {
      const changed = { ...route, baseUrl: 'https://openrouter.ai/api/v1', provider: 'different' };
      assert.equal((await save({ ...route, apiKey: secret })).status, 200);
      const response = await save({ ...changed, enabled: true }); assert.equal(response.status, 200); assert.equal((await response.json()).enabled, false);
      await assert.rejects(() => resolveRouteCredential(changed), { code: 'PROVIDER_CREDENTIAL_DISABLED' });
      assert.equal(calls, 2);
    });
    await t.test('private, IP, metadata and mixed public/private DNS approvals are rejected without config writes', async () => {
      const current = await getConfig();
      for (const value of ['127.0.0.1', '169.254.169.254', 'localhost', 'api.internal', 'metadata.google.internal', '*.example.com', 'https://example.com', 'example.com:443', 'private.cjai.pro', 'mixed.cjai.pro']) {
        const response = await configApi.PUT(request('/api/admin/routes/config', 'PUT', { version: current.version, allowedHosts: [value] }, adminCookie));
        assert.equal(response.status, 400);
      }
      assert.equal((await getConfig()).version, current.version);
      for (const address of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '100.64.1.1', '169.254.169.254', '172.16.1.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:8.8.8.8', '2001:db8::1', '2002:7f00:1::1']) assert.equal(hosts.isPublicUpstreamAddress(address), false);
      assert.equal(hosts.isPublicUpstreamAddress('8.8.8.8'), true); assert.equal(hosts.isPublicUpstreamAddress('2606:4700:4700::1111'), true);
    });
    await t.test('custom hosts pin validated DNS addresses, reject redirects/invalid status and leave trusted fetch compatible', async () => {
      const current = await getConfig();
      const response = await configApi.PUT(request('/api/admin/routes/config', 'PUT', { version: current.version, allowedHosts: ['gateway-fixture.cjai.pro'] }, adminCookie));
      assert.equal(response.status, 200); const view = await response.json(); assert.deepEqual(view.allowedHosts, ['gateway-fixture.cjai.pro']); assert.ok(view.trustedHosts.includes('api.deepseek.com'));
      // A new ID must not smuggle an existing server environment Key to an
      // administrator-approved custom host. Only a freshly supplied managed Key is eligible.
      const reference = 'CCAGENT_PROVIDER_CLONE_FIXTURE'; process.env[reference] = secret;
      const clone = routeInput.parse({ ...route, id: 'custom-env-clone', baseUrl: 'https://gateway-fixture.cjai.pro/v1', credentialEnv: reference });
      try {
        await saveRoute(admin, clone); await price(clone.id);
        await assert.rejects(() => saveRoute(admin, { ...clone, enabled: true }), { status: 409 });
        await assert.rejects(() => resolveRouteCredential(clone), { status: 503 });
        await saveRoute(admin, { ...clone, enabled: true }, { apiKey: secret });
        assert.equal((await publishedRoute(clone.id)).route.enabled, true);
      } finally { delete process.env[reference]; }
      let status = 200, pinnedCalls = 0, legacyCalls = 0;
      const transport = t.mock.method(https, 'request', ((_url: URL, options: any, callback: (response: any) => void) => {
        pinnedCalls++; assert.equal(options.servername, 'gateway-fixture.cjai.pro'); assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
        options.lookup('gateway-fixture.cjai.pro', {}, (error: unknown, address: string, family: number) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
        const outgoing = new EventEmitter() as any;
        outgoing.end = () => { queueMicrotask(() => { const incoming = new PassThrough() as any; incoming.statusCode = status; incoming.headers = { 'content-type': 'application/json', ...(status === 302 ? { location: 'http://127.0.0.1/private' } : {}) }; callback(incoming); if (!incoming.destroyed) incoming.end('{"ok":true}'); }); };
        return outgoing;
      }) as typeof https.request);
      try {
        const legacy: typeof fetch = async () => { legacyCalls++; return Response.json({ legacy: true }); };
        assert.deepEqual(await (await hosts.requestUpstream('https://gateway-fixture.cjai.pro/v1', { method: 'POST', body: '{}' }, legacy)).json(), { ok: true });
        assert.equal(legacyCalls, 0); assert.equal(pinnedCalls, 1);
        status = 302; await assert.rejects(() => hosts.requestUpstream('https://gateway-fixture.cjai.pro/v1', {}, legacy), { code: 'UPSTREAM_REDIRECT_NOT_ALLOWED' });
        status = 700; await assert.rejects(() => hosts.requestUpstream('https://gateway-fixture.cjai.pro/v1', {}, legacy), { code: 'UPSTREAM_RESPONSE_INVALID' });
        status = 204; assert.equal((await hosts.requestUpstream('https://gateway-fixture.cjai.pro/v1', {}, legacy)).body, null);
        assert.equal((await hosts.requestUpstream('https://api.deepseek.com/v1', {}, legacy)).status, 200); assert.equal(legacyCalls, 1);
        const controller = new AbortController(); controller.abort(); await assert.rejects(() => hosts.requestUpstream('https://gateway-fixture.cjai.pro/v1', { signal: controller.signal }, legacy));
        assert.equal(pinnedCalls, 4);
        dnsMock.mock.mockImplementation((async () => [{ address: '127.0.0.1', family: 4 }]) as unknown as typeof dns.lookup);
        await assert.rejects(() => hosts.requestUpstream('https://gateway-fixture.cjai.pro/v1', {}, legacy), { code: 'UPSTREAM_HOST_NOT_ALLOWED' }); assert.equal(pinnedCalls, 4);
      } finally { transport.mock.restore(); }
    });
  } finally {
    dnsMock.mock.restore();
    for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await closeDatabase(); await fixture.cleanup();
  }
});
