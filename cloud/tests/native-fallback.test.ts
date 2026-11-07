import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { del } from '@vercel/blob';
import { hashPassword } from 'better-auth/crypto';
import { isolatedDatabase } from './database-fixture';

test('native consent crosses the real HTTP authentication catalog ledger and private replay boundary', { timeout: 300000 }, async t => {
  const fixture = await isolatedDatabase();
  const temporary = await realpath(os.tmpdir()), directory = await mkdtemp(path.join(temporary, 'ccagent-native-fallback-'));
  const home = path.join(directory, 'home'); await mkdir(home);
  const names = ['CCAGENT_HOME','CCAGENT_PLATFORM_HOME','CCAGENT_ACCOUNT_ID','CCAGENT_AUTH_SESSION_FILE','CCAGENT_CLOUD_URL','CCAGENT_ENV_FILE','AUTH_URL','AUTH_SECRET'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.CCAGENT_HOME = home; process.env.CCAGENT_PLATFORM_HOME = home;
  for (const name of names.slice(2, 6)) delete process.env[name];
  process.env.AUTH_SECRET = randomBytes(48).toString('base64url');
  const credentialEnv = 'CCAGENT_PROVIDER_NATIVE_FALLBACK'; process.env[credentialEnv] = randomBytes(32).toString('base64url');
  const { database, closeDatabase } = await import('../src/core/db'), tables = await import('../src/core/db/schema');
  const { nativeHttpFixture } = await import('./native-http-fixture');
  const { authentication } = await import('../src/core/auth');
  const { createKey } = await import('../src/core/keys');
  const { postLedger, walletFor } = await import('../src/core/wallet');
  const { routeInput, priceDefinition, saveRoute, createPriceVersion } = await import('../src/core/catalog');
  const { configurePlatform, enterPlatformAccount, getPlatformAccountClient } = await import('../../src/platform/account');
  const { saveOfficialServices, officialServicesView, getPlatformGatewayClient } = await import('../../src/platform/gatewayClient');
  const { servicePaths, readServiceBinding } = await import('../../src/platform/serviceState');
  const userId = randomUUID(), email = `${userId}@example.invalid`, password = randomBytes(24).toString('base64url');
  const primary = routeInput.parse({ id: 'native-primary', name: 'Synthetic native primary', service: 'chat', protocol: 'openai-responses', provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1', upstreamModel: 'synthetic-primary', credentialEnv, options: { contextWindow: 4096, maxOutputTokens: 64 } });
  const backup = routeInput.parse({ ...primary, id: 'native-backup', name: 'Synthetic native backup', upstreamModel: 'synthetic-backup' });
  const definition = (value: string) => priceDefinition.parse({ rates: [{ metric: 'input_tokens', price: value, unitQuantity: '1000000' }, { metric: 'cached_input_tokens', price: '0', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '0', unitQuantity: '1000000' }], tariff: { kind: 'constant' } });
  const publish = (routeId: string, value: string) => createPriceVersion(userId, { routeId, currency: 'CNY', definition: definition(value), sourceUrl: 'https://example.invalid/synthetic-price', effectiveAt: new Date(Date.now() - 1000).toISOString() });
  const sent: string[] = [];
  const server = await nativeHttpFixture({ schema: fixture.schema, fetch: async (_url, init) => {
    const model = JSON.parse(String(init?.body)).model; sent.push(model);
    assert.equal(new Headers(init?.headers).get('authorization') === `Bearer ${process.env[credentialEnv]}`, true);
    if (model === primary.upstreamModel) return new Response('Synthetic unavailable', { status: 503 });
    assert.equal(model, backup.upstreamModel);
    return Response.json({ object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'NATIVE_FALLBACK_OK' }] }], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0 } });
  } });
  process.env.AUTH_URL = server.origin; server.setAuthentication(authentication());
  let firstRequest = '', key = '', firstSnapshot: unknown;
  try {
    await database().db.insert(tables.user).values({ id: userId, name: 'Native fallback fixture', email, emailVerified: true });
    await database().db.insert(tables.account).values({ id: randomUUID(), userId, providerId: 'credential', accountId: userId, password: await hashPassword(password) });
    key = (await createKey(userId, 'Synthetic native fallback')).secret;
    await database().db.transaction(tx => postLedger(tx, userId, 'native-fallback-credit', 'recharge', 10000000n, 0n));
    for (const route of [primary, backup]) { await saveRoute(userId, route); await publish(route.id, route.id === primary.id ? '1' : '10'); await saveRoute(userId, { ...route, enabled: true }); }
    await saveRoute(userId, { ...primary, enabled: true, options: { ...primary.options, fallbackEnabled: true, fallbackRouteId: backup.id } });
    await configurePlatform(server.origin); const account = await getPlatformAccountClient(); await account.signIn(email, password); await enterPlatformAccount();
    await t.test('real key verification opt-in and paid HTTP request settle only the backup under one call', async () => {
      await saveOfficialServices({ apiKey: key, roles: { main: primary.id } });
      const view = await officialServicesView(); assert.equal(view.fallbackEnabled, false);
      assert.match(view.routes.find(route => route.id === backup.id)!.pricing.fingerprint!, /^[a-f0-9]{64}$/);
      await saveOfficialServices({ fallbackEnabled: true, catalogRevision: view.catalogRevision });
      const client = await getPlatformGatewayClient(); firstRequest = randomUUID();
      const response = await client.call('responses', { model: primary.id, input: 'Synthetic native fallback one.', max_output_tokens: 8 }, { requestId: firstRequest });
      assert.equal(response.headers.get('x-ccagent-fallback'), 'true'); assert.equal(response.headers.get('x-ccagent-route-id'), backup.id);
      assert.ok((await response.text()).includes('NATIVE_FALLBACK_OK')); assert.deepEqual(sent, [primary.upstreamModel, backup.upstreamModel]);
      const status = await client.callStatus(firstRequest); assert.equal(status!.status, 'settled'); assert.equal(status!.charged, '1300'); assert.equal(status!.executedRouteId, backup.id); assert.equal(status!.fallbackUsed, true);
      assert.equal((await walletFor(userId)).frozen, 0n); firstSnapshot = status!.priceSnapshot;
      assert.equal((await readFile(servicePaths().key, 'utf8')).includes(key), false); assert.equal((await readFile(servicePaths().state, 'utf8')).includes(key), false);
    });
    await t.test('a real backend price change rejects cached consent without any supplier or ledger operation then requires fresh review', async () => {
      const old = await officialServicesView(); await publish(backup.id, '20'); const before = sent.length, funds = await walletFor(userId);
      const client = await getPlatformGatewayClient();
      await assert.rejects(client.call('responses', { model: primary.id, input: 'Synthetic stale consent.', max_output_tokens: 8 }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FALLBACK_PRICE_CHANGED');
      assert.equal(sent.length, before); assert.deepEqual(await walletFor(userId), funds);
      await assert.rejects(saveOfficialServices({ fallbackEnabled: true, catalogRevision: old.catalogRevision }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'FALLBACK_CONFIRMATION_REQUIRED');
      await saveOfficialServices({}); assert.equal((await readServiceBinding())!.configuration.fallbackEnabled, false);
      const reviewed = await officialServicesView(); await saveOfficialServices({ fallbackEnabled: true, catalogRevision: reviewed.catalogRevision });
      const active = await getPlatformGatewayClient(), id = randomUUID();
      await (await active.call('responses', { model: primary.id, input: 'Synthetic reviewed consent.', max_output_tokens: 8 }, { requestId: id })).text();
      assert.equal((await active.callStatus(id))!.charged, '2600'); assert.equal(sent.length - before, 2);
    });
    await t.test('new client configuration replays the original call with its original price approval and no supplier execution', async () => {
      const client = await getPlatformGatewayClient(), before = sent.length;
      const replay = await client.call('responses', { model: primary.id, input: 'Synthetic native fallback one.', max_output_tokens: 8 }, { requestId: firstRequest });
      assert.equal(replay.headers.get('x-ccagent-replay'), 'true'); await replay.text(); assert.equal(sent.length, before);
      const status = await client.callStatus(firstRequest); assert.deepEqual(status!.priceSnapshot, firstSnapshot); assert.equal(status!.charged, '1300');
      assert.equal((await database().db.select().from(tables.reservations).where(eq(tables.reservations.idempotencyKey, firstRequest))).length, 1);
    });
  } finally {
    await server.close();
    try { for (const file of await database().db.select({ pathname: tables.blobs.pathname }).from(tables.blobs)) await del(file.pathname); }
    finally {
      await closeDatabase(); await fixture.cleanup(); delete process.env[credentialEnv];
      for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      if (path.dirname(directory) !== temporary || !path.basename(directory).startsWith('ccagent-native-fallback-')) throw new Error('REFUSE_NONISOLATED_LOCAL_CLEANUP');
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});
