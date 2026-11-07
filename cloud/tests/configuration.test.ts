import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { isolatedDatabase } from './database-fixture';

test('real database configuration persistence, concurrency, safe admin projections and audit', { timeout: 150000 }, async t => {
  const fixture = await isolatedDatabase();
  const { database, closeDatabase } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  const { configuration, configurationUpdate, configurationValues, saveConfiguration, credentialStatuses } = await import('../src/core/configuration');
  const { adminRows, csvResponse, databaseOverview } = await import('../src/core/admin-data');
  const actor = randomUUID();
  try {
    await database().db.insert(tables.user).values({ id: actor, email: `${actor}@example.invalid`, name: '=2+2', emailVerified: true });
    await t.test('numeric-looking FX strings, booleans and numbers retain their exact types after commit', async () => {
      const saved = await saveConfiguration(actor, { changes: [{ key: 'settlement_usd_cny', value: '7.200000', version: 0 },
        { key: 'payment_enabled', value: true, version: 0 }, { key: 'recharge_min_fen', value: 200, version: 0 }] });
      assert.equal(saved.find(item => item.key === 'settlement_usd_cny')?.value, '7.200000');
      const reloaded = await configurationValues();
      assert.equal(reloaded.settlement_usd_cny, '7.200000'); assert.equal(reloaded.payment_enabled, true); assert.equal(reloaded.recharge_min_fen, 200);
      await saveConfiguration(actor, { changes: [{ key: 'payment_enabled', value: false, version: 1 }] });
      assert.equal((await configurationValues()).payment_enabled, false);
    });
    await t.test('old scalar FX format is read safely and new writes use typed JSON envelopes', async () => {
      await database().db.update(tables.settings).set({ value: '7.100000' }).where(eq(tables.settings.key, 'settlement_usd_cny'));
      assert.equal((await configurationValues()).settlement_usd_cny, '7.1');
      await saveConfiguration(actor, { changes: [{ key: 'settlement_usd_cny', value: '7.200000', version: 1 }] });
      assert.equal((await configurationValues()).settlement_usd_cny, '7.200000');
    });
    await t.test('environment overrides are read-only and never copied back into database settings', async () => {
      const original = process.env.SETTLEMENT_USD_CNY;
      process.env.SETTLEMENT_USD_CNY = '7.3';
      try {
        const entry = (await configuration()).find(item => item.key === 'settlement_usd_cny');
        assert.equal(entry?.source, 'environment'); assert.equal(entry?.readonly, true); assert.equal(entry.value, '7.3');
        await assert.rejects(() => saveConfiguration(actor, { changes: [{ key: 'settlement_usd_cny', value: '7.4', version: 2 }] }), { status: 409 });
      } finally { if (original === undefined) delete process.env.SETTLEMENT_USD_CNY; else process.env.SETTLEMENT_USD_CNY = original; }
      assert.equal((await configurationValues()).settlement_usd_cny, '7.200000');
    });
    await t.test('strict whitelist and optimistic version checks reject secret fields and stale edits', async () => {
      assert.equal(configurationUpdate.safeParse({ changes: [{ key: 'AUTH_SECRET', value: 'x', version: 0 }] }).success, false);
      assert.equal(configurationUpdate.safeParse({ changes: [{ key: 'support_email', value: '', version: 0, secret: 'x' }] }).success, false);
      await assert.rejects(() => saveConfiguration(actor, { changes: [{ key: 'settlement_usd_cny', value: '7.5', version: 0 }] }), { status: 409 });
      assert.equal((await configurationValues()).settlement_usd_cny, '7.200000');
    });
    await t.test('competing edits cannot create a minimum recharge greater than maximum recharge', async () => {
      const results = await Promise.allSettled([
        saveConfiguration(actor, { changes: [{ key: 'recharge_min_fen', value: 600, version: 1 }] }),
        saveConfiguration(actor, { changes: [{ key: 'recharge_max_fen', value: 500, version: 0 }] }),
      ]);
      assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
      assert.equal(results.filter(item => item.status === 'rejected').length, 1);
      const config = await configurationValues(); assert.ok(config.recharge_min_fen <= config.recharge_max_fen);
    });
    await t.test('admin list joins, filtering and database health use real rows without exposing credentials', async () => {
      for (const section of ['users', 'keys', 'wallets', 'orders', 'refunds', 'usage', 'tasks', 'ledger', 'audit', 'routes', 'prices', 'roles', 'permissions']) {
        const result = await adminRows(section, new URL('http://local/?pageSize=10'));
        assert.ok(Array.isArray(result.rows));
        for (const row of result.rows) assert.equal(['hash', 'password', 'token', 'access_token', 'refresh_token'].some(key => Object.hasOwn(row, key)), false);
      }
      assert.equal((await adminRows('users', new URL('http://local/?q=not-a-user'))).total, 0);
      const overview = await databaseOverview(); assert.equal(overview.connected, true); assert.equal(overview.schema, fixture.schema); assert.equal(overview.counts?.users, '1');
      const status = JSON.stringify(credentialStatuses());
      assert.equal(status.includes(process.env.AUTH_SECRET || 'never-present-placeholder'), false);
    });
    await t.test('CSV formula cells are neutralized and saved configuration actions are immutable audit records', async () => {
      const response = csvResponse([{ name: '=HYPERLINK("https://example.invalid")' }], 'users');
      assert.match(await response.text(), /"'=HYPERLINK/);
      const records = await database().db.select().from(tables.audit).where(eq(tables.audit.actorId, actor));
      assert.ok(records.length >= 4); assert.ok(records.every(row => row.action === 'settings.update'));
      await assert.rejects(() => database().db.update(tables.audit).set({ result: 'changed' }));
    });
    await t.test('grouped credential statuses validate nonsecret endpoints without echoing secrets or malformed URLs', () => {
      const names = ['AUTH_SECRET', 'AUTH_URL', 'AUTH_EMAIL_FROM', 'ZPAY_KEY', 'ZPAY_PID', 'ZPAY_API_BASE_URL', 'ZPAY_CHANNEL_ID', 'CCAGENT_PROVIDER_STATUS_FIXTURE'];
      const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
      const secret = 'fixture-secret-that-must-never-be-returned';
      try {
        Object.assign(process.env, { AUTH_SECRET: secret, AUTH_URL: 'https://platform.example.invalid', AUTH_EMAIL_FROM: 'CCAGENT <account@notify.cjai.pro>', ZPAY_KEY: secret, ZPAY_PID: 'fixture', ZPAY_API_BASE_URL: 'https://zpayz.cn', ZPAY_CHANNEL_ID: '1,2', CCAGENT_PROVIDER_STATUS_FIXTURE: secret });
        const valid = credentialStatuses(); assert.equal(valid.payment.notifyUrl, 'https://platform.example.invalid/api/payments/zpay/notify'); assert.equal(valid.payment.returnUrl, 'https://platform.example.invalid/payment/return');
        assert.equal(valid.payment.callbackHttps, true); assert.equal(valid.payment.baseUrlValid, true); assert.equal(valid.payment.channelIdValid, true); assert.equal(valid.emailDomain, 'notify.cjai.pro');
        assert.equal(valid.authentication.emailPasswordRequired, true); assert.equal(valid.storage.access, 'private'); assert(valid.providers.configuredCount >= 1); assert(!JSON.stringify(valid).includes(secret));
        process.env.ZPAY_API_BASE_URL = `https://user:${secret}@gateway.example.invalid/?key=${secret}`; process.env.AUTH_URL = `https://user:${secret}@platform.example.invalid/`; process.env.ZPAY_CHANNEL_ID = 'not-an-id'; process.env.AUTH_EMAIL_FROM = `invalid-${secret}`;
        const invalid = credentialStatuses(); assert.equal(invalid.payment.baseUrl, null); assert.equal(invalid.payment.baseUrlValid, false); assert.equal(invalid.payment.notifyUrl, null); assert.equal(invalid.payment.channelIdValid, false); assert.equal(invalid.emailDomain, null); assert(!JSON.stringify(invalid).includes(secret));
      } finally { for (const name of names) { const value = original[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
    });
  } finally { await closeDatabase(); await fixture.cleanup(); }
});
