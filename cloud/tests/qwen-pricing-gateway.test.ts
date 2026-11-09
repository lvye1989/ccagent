import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { del } from '@vercel/blob';
import { hashPassword } from 'better-auth/crypto';
import { isolatedDatabase } from './database-fixture';
import { databaseSchema } from '../src/core/env';
import { definition } from './qwen-pricing-fixture';
import type { PriceDefinition } from '../../src/platform/pricingDefinition';

test('Qwen tiered gateway persists exact charges streams fallback snapshots and platform tests', { timeout: 600000 }, async t => {
  const originalSchema = databaseSchema(), fixture = await isolatedDatabase();
  process.env.AUTH_URL = 'http://127.0.0.1:4310'; process.env.AUTH_SECRET = randomBytes(48).toString('base64url');
  const credentialEnv = 'CCAGENT_PROVIDER_QWEN_PRICE_FIXTURE'; process.env[credentialEnv] = randomBytes(32).toString('hex');
  const { database, closeDatabase } = await import('../src/core/db'), tables = await import('../src/core/db/schema');
  const { serviceRouteSchema } = await import('../../src/platform/serviceState');
  const { authentication } = await import('../src/core/auth'), { createKey } = await import('../src/core/keys');
  const { postLedger, walletFor } = await import('../src/core/wallet');
  const { saveRoute, createPriceVersion, publishedRoute, publicPricing, routeInput } = await import('../src/core/catalog');
  const { createGateway, maximumQuantities, availableModels } = await import('../src/core/gateway');
  const { createRouteTests } = await import('../src/core/route-tests');
  const userId = randomUUID(), email = `${userId}@example.invalid`, password = randomBytes(24).toString('base64url');
  const jobs: Promise<void>[] = [], sent: Record<string, unknown>[] = [], queue: (() => Promise<Response> | Response)[] = [];
  const fetcher: typeof fetch = async (_url, init) => { sent.push(JSON.parse(String(init?.body))); assert(queue.length, 'Unexpected provider dispatch'); return queue.shift()!(); };
  const gateway = createGateway({ fetch: fetcher, keepAlive: work => jobs.push(work) });
  const tester = createRouteTests({ fetch: fetcher, keepAlive: work => jobs.push(work) });
  const drain = async () => { while (jobs.length) await Promise.all(jobs.splice(0)); };
  const response = (total = 129, cached = 28, output = 10) => Response.json({ choices: [{ message: { role: 'assistant', content: 'OK' } }], usage: { prompt_tokens: total, prompt_tokens_details: { cached_tokens: cached }, completion_tokens: output, completion_tokens_details: { reasoning_tokens: 4 } } });
  let cookie = '', key = '';
  const request = (id: string, input: Record<string, unknown> = {}, headers: Record<string, string> = {}) => new Request(process.env.AUTH_URL + '/v1/chat/completions', { method: 'POST', headers: { cookie, authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': id, ...headers }, body: JSON.stringify({ model: 'qwen-tiers', messages: [{ role: 'user', content: 'Synthetic pricing check.' }], max_tokens: 16, ...input }) });
  const record = async (id: string) => (await database().db.select().from(tables.reservations).where(eq(tables.reservations.idempotencyKey, id)))[0]!;
  const route = routeInput.parse({ id: 'qwen-tiers', name: 'Synthetic Qwen tiers', provider: 'qwen', protocol: 'openai-chat', service: 'chat', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', upstreamModel: 'synthetic-qwen-fixture', credentialEnv, options: { contextWindow: 1024, maxOutputTokens: 64 } });
  const publish = async (id: string, price: PriceDefinition) => createPriceVersion(userId, { routeId: id, currency: 'CNY', definition: price, sourceUrl: 'https://example.invalid/synthetic-prices', effectiveAt: new Date(Date.now() - 1000).toISOString() });
  let baselineAuditIds: string[] = [];
  const fingerprint = async () => {
    const result: Record<string, string> = {};
    for (const table of [tables.user, tables.session, tables.account, tables.userRoles, tables.wallets, tables.ledger, tables.apiKeys, tables.routes, tables.prices, tables.orders, tables.reservations, tables.audit, tables.blobs]) {
      const name = getTableConfig(table).name;
      const [row] = await fixture.owner.unsafe<{ digest: string }[]>(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as digest from "${originalSchema}"."${name}" t${name === 'audit' ? ' where t.id = ANY($1::text[])' : ''}`,
        name === 'audit' ? [baselineAuditIds] : []);
      result[name] = row!.digest;
    }
    return result;
  };
  let originalFingerprint: Record<string, string> | undefined;
  try {
    assert.match(originalSchema, /^[a-z_][a-z0-9_]{0,62}$/);
    assert.equal(tables.namespace.schemaName, fixture.schema, 'Application tables must bind to the exact disposable schema');
    baselineAuditIds = (await fixture.owner.unsafe<{ id: string }[]>(`select id from "${originalSchema}"."audit"`)).map(row => row.id);
    originalFingerprint = await fingerprint();
    const [identity] = await database().db.execute(sql`select current_user as role`); assert.equal(identity.role, 'ccagent_runtime');
    console.log(JSON.stringify({ fixtureSchema: fixture.schema, tableSchema: tables.namespace.schemaName, actualProviders: false, actualMoney: false }));
    await database().db.insert(tables.user).values({ id: userId, name: 'Synthetic Qwen pricing', email, emailVerified: true });
    await database().db.insert(tables.account).values({ id: randomUUID(), userId, providerId: 'credential', accountId: userId, password: await hashPassword(password) });
    await database().db.insert(tables.userRoles).values({ userId, roleId: 'admin' });
    const login = await authentication().handler(new Request(process.env.AUTH_URL + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: process.env.AUTH_URL!, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }));
    assert.equal(login.status, 200); cookie = login.headers.getSetCookie().find(value => value.startsWith('ccagent.session_token='))!.split(';')[0]!;
    key = (await createKey(userId, 'Synthetic tiers')).secret;
    await database().db.transaction(tx => postLedger(tx, userId, 'synthetic-price-credit', 'adjustment', 1000000000n, 0n, { realMoney: false }));
    await saveRoute(userId, route); await publish(route.id, definition()); await saveRoute(userId, { ...route, enabled: true });
    await t.test('catalogue preserves tiered costs and reservations include full reasoning allowance', async () => {
      const models = await availableModels(new Request(process.env.AUTH_URL + '/v1/models', { headers: { cookie, authorization: `Bearer ${key}` } }));
      assert.deepEqual(serviceRouteSchema.parse(models.data[0]).pricing.definition, definition());
      const selection = await publishedRoute(route.id), body = { max_tokens: 16, enable_thinking: true };
      assert.equal(maximumQuantities(selection, {}, body).output_tokens, 48n);
    });
    await t.test('invalid mode or oversized thinking budget rejects before any wallet or supplier action', async () => {
      const before = await walletFor(userId), count = sent.length;
      assert.equal((await gateway.execute(request('invalid-mode', { enable_thinking: 'false' }), 'chat')).status, 400);
      assert.equal((await gateway.execute(request('invalid-thinking-budget', { enable_thinking: true, thinking_budget: 33 }), 'chat')).status, 400);
      assert.equal(sent.length, count); assert.deepEqual(await walletFor(userId), before);
    });
    await t.test('non-thinking and thinking exact charges use actual total input and keep mode snapshots', async () => {
      for (const [id, mode, charge] of [['measured-plain', false, 9656400n], ['measured-thinking', true, 11216400n]] as const) {
        queue.push(() => response()); assert.equal((await gateway.execute(request(id, { enable_thinking: mode }), 'chat')).status, 200);
        const row = await record(id), usage = row.usage as any;
        assert.equal(row.status, 'settled'); assert.equal(row.charged, charge); assert.equal(sent.at(-1)!.enable_thinking, mode);
        assert.deepEqual(usage.priceTier, { inputTokens: '129', upToInputTokens: 256, thinking: mode });
        assert.equal((row.priceSnapshot as any).thinking, mode);
      }
    });
    await t.test('streaming usage chooses the same inclusive tier and settles once', async () => {
      queue.push(() => new Response('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 256, prompt_tokens_details: { cached_tokens: 128 }, completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
      const result = await gateway.execute(request('stream-tier', { stream: true }), 'chat'); assert.equal(result.status, 200); await result.text(); await drain();
      assert.equal((await record('stream-tier')).charged, 12542400n);
    });
    await t.test('a price update during supplier work cannot alter the accepted snapshot', async () => {
      const changed = definition(true); for (const rate of changed.rates) if ('tiers' in rate) for (const tier of rate.tiers) { tier.price = '99'; if (tier.thinkingPrice !== undefined) tier.thinkingPrice = '199'; }
      queue.push(async () => { await publish(route.id, changed); return response(); });
      assert.equal((await gateway.execute(request('old-snapshot'), 'chat')).status, 200);
      assert.equal((await record('old-snapshot')).charged, 9656400n); assert.equal((await record('old-snapshot')).priceSnapshot && ((await record('old-snapshot')).priceSnapshot as any).thinking, false);
      await publish(route.id, definition());
    });
    await t.test('one fallback keeps the requested mode and charges only the actual backup price', async () => {
      const backup = { ...route, id: 'qwen-tier-backup' }; const cost = definition(true);
      for (const rate of cost.rates) if ('tiers' in rate) for (const tier of rate.tiers) { tier.price = String(Number(tier.price) * 2); if (tier.thinkingPrice !== undefined) tier.thinkingPrice = String(Number(tier.thinkingPrice) * 2); }
      await saveRoute(userId, backup); await publish(backup.id, cost); await saveRoute(userId, { ...backup, enabled: true });
      await saveRoute(userId, { ...route, enabled: true, options: { ...route.options, fallbackEnabled: true, fallbackRouteId: backup.id } });
      const primary = publicPricing(await publishedRoute(route.id)), secondary = publicPricing(await publishedRoute(backup.id));
      queue.push(() => new Response('', { status: 503 }), () => response());
      const result = await gateway.execute(request('fallback-tier', { enable_thinking: true }, { 'x-ccagent-price-version': String(primary.version), 'x-ccagent-price-fingerprint': primary.fingerprint,
        'x-ccagent-fallback-route': backup.id, 'x-ccagent-fallback-price-version': String(secondary.version), 'x-ccagent-fallback-price-fingerprint': secondary.fingerprint }), 'chat');
      assert.equal(result.status, 200); assert.equal(result.headers.get('x-ccagent-route-id'), backup.id);
      const row = await record('fallback-tier'); assert.equal(row.charged, 22432800n); assert.equal((row.usage as any).attempts, 2); assert.equal((row.usage as any).priceTier.thinking, true);
      assert(sent.slice(-2).every(body => body.enable_thinking === true));
    });
    await t.test('unknown cached usage stays pending instead of using an assumed free cache count', async () => {
      queue.push(() => Response.json({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 129, completion_tokens: 10 } }));
      assert.equal((await gateway.execute(request('missing-cache'), 'chat')).status, 200);
      const row = await record('missing-cache'); assert.equal(row.status, 'pending'); assert.equal(row.charged, 0n);
    });
    await t.test('administrator probe uses the default priced mode and never modifies the customer wallet', async () => {
      await publish(route.id, definition(true));
      const headers = { cookie, origin: process.env.AUTH_URL!, 'content-type': 'application/json' }, url = process.env.AUTH_URL + '/api/admin/routes/test';
      const quoteResponse = await tester.get(new Request(url + '?routeId=' + route.id, { headers })); assert.equal(quoteResponse.status, 200); const { quote } = await quoteResponse.json();
      const before = await walletFor(userId), testId = randomUUID(); queue.push(() => response());
      const posted = await tester.post(new Request(url, { method: 'POST', headers, body: JSON.stringify({ routeId: route.id, testId, confirmationFingerprint: quote.confirmationFingerprint, confirmPlatformCost: true }) }));
      assert.equal(posted.status, 202); await drain();
      const status = await tester.get(new Request(url + '?' + new URLSearchParams({ routeId: route.id, testId }), { headers })); const { test: result } = await status.json();
      assert.equal(result.status, 'succeeded'); assert.equal(result.publicCostMicro, '8628000'); assert.equal(result.userChargeMicro, '0'); assert.equal(result.priceTier.thinking, true);
      assert.equal(sent.at(-1)!.enable_thinking, true); assert.deepEqual(await walletFor(userId), before);
    });
    assert.equal(queue.length, 0);
  } finally {
    try {
      await drain();
      if (tables.namespace.schemaName === fixture.schema) for (const file of await database().db.select({ pathname: tables.blobs.pathname }).from(tables.blobs).where(eq(tables.blobs.userId, userId))) await del(file.pathname);
      if (originalFingerprint) {
        assert.deepEqual(await fingerprint(), originalFingerprint, 'The complete development rows must remain unchanged');
        const [added] = await fixture.owner.unsafe<{ total: string; scheduled: string; unexpected: string }[]>(`select count(*)::text as total,
          count(*) filter (where action='system.maintenance' and object_id='scheduled' and result='success')::text as scheduled,
          count(*) filter (where not (action='system.maintenance' and object_id='scheduled' and result='success'))::text as unexpected
          from "${originalSchema}"."audit" where not (id = ANY($1::text[]))`, [baselineAuditIds]);
        assert.equal(added!.unexpected, '0', 'Only successful scheduled maintenance may append development audit rows during this isolated test');
        console.log(JSON.stringify({ developmentTablesChecked: Object.keys(originalFingerprint).length, developmentRowsUnchanged: true,
          baselineAuditRows: baselineAuditIds.length, newAuditRows: Number(added!.total), newScheduledMaintenanceRows: Number(added!.scheduled), unexpectedNewAuditRows: Number(added!.unexpected) }));
      }
    } finally { await closeDatabase(); await fixture.cleanup(); delete process.env[credentialEnv]; }
  }
});
