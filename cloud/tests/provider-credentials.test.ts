import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { isolatedDatabase } from './database-fixture';

test('isolated database provider credentials: authenticated encryption, binding, lifecycle and safe projections', { timeout: 150000 }, async t => {
  const fixture = await isolatedDatabase();
  const original = { AUTH_SECRET: process.env.AUTH_SECRET, AUTH_URL: process.env.AUTH_URL, CCAGENT_PROVIDER_CREDENTIAL_FIXTURE: process.env.CCAGENT_PROVIDER_CREDENTIAL_FIXTURE };
  const rootSecret = 'synthetic-auth-root-' + randomBytes(32).toString('base64url');
  const legacySecret = 'synthetic-legacy-' + randomBytes(24).toString('base64url');
  const firstSecret = 'synthetic-managed-' + randomBytes(24).toString('base64url');
  const replacementSecret = 'synthetic-replacement-' + randomBytes(24).toString('base64url');
  Object.assign(process.env, { AUTH_SECRET: rootSecret, AUTH_URL: 'https://credential-fixture.example.invalid', CCAGENT_PROVIDER_CREDENTIAL_FIXTURE: legacySecret });
  const { database, closeDatabase } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  const { routeCredentialStatus, resolveRouteCredential, saveRouteCredential } = await import('../src/core/provider-credentials');
  const { configuration, configurationUpdate, credentialStatuses } = await import('../src/core/configuration');
  const { adminRows, csvResponse } = await import('../src/core/admin-data');
  const actor = randomUUID();
  const baseRoute = { id: 'managed-fixture', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', credentialEnv: 'CCAGENT_PROVIDER_CREDENTIAL_FIXTURE' };
  const keyFor = (route: typeof baseRoute) => 'gateway.credential.' + route.id;
  const save = (route: typeof baseRoute, action: { apiKey?: string; remove?: boolean }) => database().db.transaction(tx => saveRouteCredential(actor, route, action, tx));
  const read = async (route: typeof baseRoute) => (await database().db.select().from(tables.settings).where(eq(tables.settings.key, keyFor(route))))[0]!;
  const assertSafe = (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    for (const secret of [rootSecret, legacySecret, firstSecret, replacementSecret]) assert(!text.includes(secret), 'secrets must not appear in errors, status, audit or exports');
  };
  try {
    await database().db.insert(tables.user).values({ id: actor, email: `${actor}@example.invalid`, name: 'Credential Fixture', emailVerified: true });
    await t.test('legacy environment credentials work only while the reserved record is absent', async () => {
      assert.deepEqual(await routeCredentialStatus(baseRoute), { configured: true, source: 'environment' });
      assert.equal(await resolveRouteCredential(baseRoute), legacySecret);
      assert.deepEqual(await routeCredentialStatus({ ...baseRoute, credentialEnv: '' }), { configured: false, source: 'none' });
      await assert.rejects(() => resolveRouteCredential({ ...baseRoute, credentialEnv: '' }), { status: 503, code: 'UPSTREAM_NOT_CONFIGURED' });
    });
    await t.test('a new route on a DB-approved custom host cannot clone a legacy environment Key', async () => {
      const previousHosts = process.env.CCAGENT_ALLOWED_UPSTREAM_HOSTS;
      process.env.CCAGENT_ALLOWED_UPSTREAM_HOSTS = '';
      const custom = { ...baseRoute, id: 'custom-environment-clone-fixture', provider: 'openai', baseUrl: 'https://api.openai.com/v1' };
      const customHostsKey = 'gateway.allowed_upstream_hosts';
      await database().db.insert(tables.settings).values({ key: customHostsKey, value: { allowedHosts: ['api.openai.com'] }, updatedBy: actor });
      try {
        assert.deepEqual(await routeCredentialStatus(custom), { configured: false, source: 'none' });
        await assert.rejects(() => resolveRouteCredential(custom), { status: 503, code: 'UPSTREAM_NOT_CONFIGURED' });
        await save(custom, { apiKey: replacementSecret });
        assert.deepEqual(await routeCredentialStatus(custom), { configured: true, source: 'managed' });
        assert.equal(await resolveRouteCredential(custom), replacementSecret);
        // Compatibility remains available only when a server operator explicitly trusted the host in the old environment list.
        process.env.CCAGENT_ALLOWED_UPSTREAM_HOSTS = 'api.openai.com';
        const serverTrusted = { ...custom, id: 'server-trusted-legacy-fixture' };
        assert.deepEqual(await routeCredentialStatus(serverTrusted), { configured: true, source: 'environment' });
        assert.equal(await resolveRouteCredential(serverTrusted), legacySecret);
      } finally {
        if (previousHosts === undefined) delete process.env.CCAGENT_ALLOWED_UPSTREAM_HOSTS; else process.env.CCAGENT_ALLOWED_UPSTREAM_HOSTS = previousHosts;
        await database().db.delete(tables.settings).where(eq(tables.settings.key, customHostsKey));
      }
    });
    await t.test('managed credentials persist only AES-GCM envelopes and safe metadata', async () => {
      await save(baseRoute, { apiKey: firstSecret });
      const stored = await read(baseRoute); assertSafe(stored);
      const value = stored.value as Record<string, unknown>;
      assert.deepEqual(Object.keys(value).sort(), ['algorithm', 'ciphertext', 'iv', 'kind', 'tag', 'version']);
      assert.equal(value.algorithm, 'aes-256-gcm'); assert.equal(value.kind, 'encrypted');
      assert.equal(Buffer.from(String(value.iv), 'base64url').length, 12); assert.equal(Buffer.from(String(value.tag), 'base64url').length, 16);
      assert.equal(await resolveRouteCredential(baseRoute), firstSecret);
      assert.deepEqual(await routeCredentialStatus(baseRoute), { configured: true, source: 'managed' });
      assertSafe(await routeCredentialStatus(baseRoute));
      const audit = await database().db.select().from(tables.audit).where(eq(tables.audit.objectId, baseRoute.id)); assertSafe(audit);
      assert.equal(audit[0]!.action, 'routes.credential.save');
      assert.deepEqual(audit[0]!.metadata, { source: 'managed', operation: 'create', version: 1 });
    });
    await t.test('equivalent canonical API base URLs keep the binding while provider or endpoint changes fail closed', async () => {
      assert.equal(await resolveRouteCredential({ ...baseRoute, baseUrl: 'https://API.DEEPSEEK.COM:443/v1/' }), firstSecret);
      for (const changed of [{ ...baseRoute, provider: 'openai' }, { ...baseRoute, baseUrl: 'https://api.deepseek.com/other' }, { ...baseRoute, baseUrl: 'https://different.example.invalid/v1' }]) {
        assert.deepEqual(await routeCredentialStatus(changed), { configured: false, source: 'managed' });
        await assert.rejects(() => resolveRouteCredential(changed), { status: 503, code: 'PROVIDER_CREDENTIAL_INVALID' });
      }
      const copied = { ...baseRoute, id: 'copied-fixture' };
      await database().db.insert(tables.settings).values({ key: keyFor(copied), value: (await read(baseRoute)).value, updatedBy: actor });
      assert.deepEqual(await routeCredentialStatus(copied), { configured: false, source: 'managed' });
      await assert.rejects(() => resolveRouteCredential(copied), { status: 503, code: 'PROVIDER_CREDENTIAL_INVALID' });
    });
    await t.test('ciphertext, tag, IV, schema and algorithm tampering never fall back to the legacy Key', async () => {
      const originalValue = structuredClone((await read(baseRoute)).value) as Record<string, unknown>;
      const mutated = (field: string) => { const value = structuredClone(originalValue); const encoded = String(value[field]); value[field] = (encoded[0] === 'A' ? 'B' : 'A') + encoded.slice(1); return value; };
      try {
        for (const value of [mutated('ciphertext'), mutated('tag'), mutated('iv'), { ...originalValue, version: 2 }, { ...originalValue, algorithm: 'aes-128-gcm' }, { ...originalValue, tag: 'AAAA' }, { ...originalValue, extra: true }, { invalid: true }]) {
          await database().db.update(tables.settings).set({ value }).where(eq(tables.settings.key, keyFor(baseRoute)));
          assert.deepEqual(await routeCredentialStatus(baseRoute), { configured: false, source: 'managed' });
          await assert.rejects(() => resolveRouteCredential(baseRoute), error => { assertSafe(String(error)); return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'PROVIDER_CREDENTIAL_INVALID'); });
        }
      } finally { await database().db.update(tables.settings).set({ value: originalValue }).where(eq(tables.settings.key, keyFor(baseRoute))); }
    });
    await t.test('blank input preserves the exact envelope and version; replacement uses fresh nonces and audit metadata', async () => {
      const before = await read(baseRoute);
      await save(baseRoute, {}); await save(baseRoute, { apiKey: '' }); await save(baseRoute, { apiKey: '   ' });
      assert.deepEqual(await read(baseRoute), before);
      await save(baseRoute, { apiKey: firstSecret }); const randomized = await read(baseRoute);
      assert.notDeepEqual(randomized.value, before.value); assert.equal(randomized.version, before.version + 1);
      assert.equal(await resolveRouteCredential(baseRoute), firstSecret);
      await save(baseRoute, { apiKey: replacementSecret });
      assert.equal(await resolveRouteCredential(baseRoute), replacementSecret);
      assertSafe(await read(baseRoute));
      const records = await database().db.select().from(tables.audit).where(eq(tables.audit.objectId, baseRoute.id)); assertSafe(records);
      assert.deepEqual(records.map(record => (record.metadata as { operation: string }).operation).sort(), ['create', 'replace', 'replace']);
    });
    await t.test('removal creates a durable tombstone, suppresses environment fallback and can be replaced explicitly', async () => {
      await save(baseRoute, { remove: true });
      assert.deepEqual((await read(baseRoute)).value, { version: 1, kind: 'disabled' });
      assert.deepEqual(await routeCredentialStatus(baseRoute), { configured: false, source: 'managed' });
      await assert.rejects(() => resolveRouteCredential(baseRoute), { status: 503, code: 'PROVIDER_CREDENTIAL_DISABLED' });
      await save(baseRoute, { apiKey: '' });
      await assert.rejects(() => resolveRouteCredential(baseRoute), { code: 'PROVIDER_CREDENTIAL_DISABLED' });
      await save(baseRoute, { apiKey: firstSecret }); assert.equal(await resolveRouteCredential(baseRoute), firstSecret);
      const legacyOnly = { ...baseRoute, id: 'removed-legacy-fixture' }; await save(legacyOnly, { remove: true });
      assert.deepEqual(await routeCredentialStatus(legacyOnly), { configured: false, source: 'managed' });
      await assert.rejects(() => resolveRouteCredential(legacyOnly), { code: 'PROVIDER_CREDENTIAL_DISABLED' });
    });
    await t.test('missing or changed AUTH_SECRET fails safely without overwriting managed state or using environment fallback', async () => {
      const before = await read(baseRoute);
      try {
        delete process.env.AUTH_SECRET;
        assert.deepEqual(await routeCredentialStatus(baseRoute), { configured: false, source: 'managed' });
        await assert.rejects(() => resolveRouteCredential(baseRoute), { status: 503, code: 'PROVIDER_CREDENTIAL_ENCRYPTION_NOT_READY' });
        await assert.rejects(() => save(baseRoute, { apiKey: replacementSecret }), { code: 'PROVIDER_CREDENTIAL_ENCRYPTION_NOT_READY' });
        assert.deepEqual(await read(baseRoute), before);
        process.env.AUTH_SECRET = 'synthetic-rotated-auth-root-' + randomBytes(32).toString('base64url');
        assert.deepEqual(await routeCredentialStatus(baseRoute), { configured: false, source: 'managed' });
        await assert.rejects(() => resolveRouteCredential(baseRoute), { status: 503, code: 'PROVIDER_CREDENTIAL_INVALID' });
      } finally { process.env.AUTH_SECRET = rootSecret; }
      assert.equal(await resolveRouteCredential(baseRoute), firstSecret);
    });
    await t.test('secret validation rejects controls, internal whitespace, Unicode, oversized values and conflicting actions', async () => {
      const before = await read(baseRoute);
      for (const apiKey of ['key\r\nvalue', 'key\u0000value', 'key\tvalue', 'key\u0085value', 'key\u202evalue', 'key with spaces', '密钥value', 'x'.repeat(8193), '€'.repeat(3000)]) {
        await assert.rejects(() => save(baseRoute, { apiKey }), { status: 400, code: 'INVALID_PROVIDER_CREDENTIAL' });
      }
      await assert.rejects(() => save(baseRoute, { apiKey: replacementSecret, remove: true }), { status: 400, code: 'INVALID_PROVIDER_CREDENTIAL' });
      assert.deepEqual(await read(baseRoute), before);
      const invalidEnvironment = { ...baseRoute, id: 'invalid-legacy-fixture' };
      process.env.CCAGENT_PROVIDER_CREDENTIAL_FIXTURE = 'invalid legacy value';
      try {
        assert.deepEqual(await routeCredentialStatus(invalidEnvironment), { configured: false, source: 'environment' });
        await assert.rejects(() => resolveRouteCredential(invalidEnvironment), { status: 503, code: 'PROVIDER_CREDENTIAL_INVALID' });
      } finally { process.env.CCAGENT_PROVIDER_CREDENTIAL_FIXTURE = legacySecret; }
    });
    await t.test('transaction rollback preserves old credential and audit when its surrounding route save fails', async () => {
      const before = await read(baseRoute), records = await database().db.select().from(tables.audit).where(eq(tables.audit.objectId, baseRoute.id));
      await assert.rejects(() => database().db.transaction(async tx => { await saveRouteCredential(actor, baseRoute, { apiKey: replacementSecret }, tx); throw new Error('SYNTHETIC_ROUTE_SAVE_FAILED'); }), /SYNTHETIC_ROUTE_SAVE_FAILED/);
      assert.deepEqual(await read(baseRoute), before);
      assert.deepEqual(await database().db.select().from(tables.audit).where(eq(tables.audit.objectId, baseRoute.id)), records);
    });
    await t.test('general settings, status, admin lists and CSV exports cannot expose managed envelopes or secrets', async () => {
      const config = await configuration(); assert.equal(config.length, 5); assertSafe(config);
      assert(!JSON.stringify(config).includes('gateway.credential.')); assertSafe(credentialStatuses());
      assert.equal(configurationUpdate.safeParse({ changes: [{ key: keyFor(baseRoute), value: 'replacement', version: 1 }] }).success, false);
      await assert.rejects(() => adminRows('settings', new URL('https://fixture.invalid/')), { status: 404 });
      const storedValue = (await read(baseRoute)).value as { ciphertext: string };
      for (const section of ['routes', 'prices', 'audit']) {
        const result = await adminRows(section, new URL('https://fixture.invalid/?pageSize=100')); assertSafe(result);
        assert(!JSON.stringify(result).includes(storedValue.ciphertext));
        const exported = await csvResponse(result.rows, section).text(); assertSafe(exported); assert(!exported.includes(storedValue.ciphertext));
      }
    });
  } finally {
    for (const [name, value] of Object.entries(original)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await closeDatabase(); await fixture.cleanup();
  }
});
