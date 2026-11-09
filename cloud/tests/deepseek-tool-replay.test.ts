import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { hashPassword } from 'better-auth/crypto';
import { isolatedDatabase } from './database-fixture';
import type { z } from 'zod';
import type { routeInput } from '../src/core/catalog';
import { priceDefinition, applyRequestPricing } from '../../src/platform/pricingDefinition';
import { prepareUpstream } from '../src/core/upstream';
import { definition as qwenDefinition } from './qwen-pricing-fixture';

const route: z.infer<typeof routeInput> = { id: 'legacy-qwen-alias', name: 'Synthetic DeepSeek alias', service: 'chat', protocol: 'openai-chat', provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1', upstreamModel: 'synthetic-deepseek-model', credentialEnv: 'CCAGENT_PROVIDER_DEEPSEEK_REPLAY_FIXTURE',
  enabled: false, timeoutMs: 120000, retries: 0,
  options: { contextWindow: 4096, maxOutputTokens: 64, maxImages: 20, fallbackRouteId: null, fallbackEnabled: false } };
const replayMessages = [
  { role: 'user', content: 'Create a synthetic document fixture.' },
  { role: 'assistant', content: null, reasoning_content: 'Synthetic reasoning for the tool selection.',
    tool_calls: [{ id: 'fixture-deliver-call', type: 'function', function: { name: 'WorkfriendDeliver', arguments: '{"format":"word","title":"Fixture"}' } }] },
  { role: 'tool', tool_call_id: 'fixture-deliver-call', content: 'Synthetic document created successfully.' },
];

test('DeepSeek chat preserves validated explicit thinking and tool replay without changing other provider requests', () => {
  for (const type of ['enabled', 'disabled']) {
    const input = { messages: replayMessages, thinking: { type }, max_tokens: 16, stream: true };
    const prepared = prepareUpstream('chat', input, route);
    assert.deepEqual(prepared.body.thinking, { type });
    assert.deepEqual(prepared.body.messages, replayMessages);
    assert.equal(prepared.body.model, route.upstreamModel);
    assert.equal(prepared.streaming, true);
  }
  const plain = prepareUpstream('chat', { messages: [{ role: 'user', content: 'Hello' }], max_tokens: 16 }, route);
  assert.equal(Object.hasOwn(plain.body, 'thinking'), false, 'An omitted caller choice must not be invented by the gateway.');
  for (const thinking of [null, true, 'disabled', [], {}, { type: 'auto' }, { type: 1 }, { type: 'enabled', budget_tokens: 100 }]) {
    assert.throws(() => prepareUpstream('chat', { messages: replayMessages, thinking }, route));
  }
  const qwen = { ...route, id: 'qwen-standard-fixture', provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' };
  const standard = prepareUpstream('chat', { messages: replayMessages, enable_thinking: false, thinking_budget: 32, thinking: { type: 'enabled' } }, qwen);
  assert.equal(Object.hasOwn(standard.body, 'thinking'), false);
  assert.equal(standard.body.enable_thinking, false);
  assert.equal(standard.body.thinking_budget, 32);
  assert.equal(applyRequestPricing(qwenDefinition(true), standard.body).enable_thinking, false, 'Explicit Qwen mode still controls its existing price selection.');
  const constant = priceDefinition.parse({ rates: [{ metric: 'input_tokens', price: '2', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '8', unitQuantity: '1000000' }], tariff: { kind: 'constant' } });
  const deepseek = prepareUpstream('chat', { messages: replayMessages, thinking: { type: 'disabled' } }, route);
  assert.deepEqual(applyRequestPricing(constant, deepseek.body).thinking, { type: 'disabled' });
});

test('DeepSeek tool replay validates before authorization and catalog exposes the actual provider behind an alias', { timeout: 180000 }, async t => {
  const fixture = await isolatedDatabase();
  const savedStorage = { token: process.env.BLOB_READ_WRITE_TOKEN, id: process.env.BLOB_STORE_ID };
  let cleanupDatabase = async () => {};
  try {
    // Result persistence is intentionally unavailable: this test never contacts an object store.
    delete process.env.BLOB_READ_WRITE_TOKEN; delete process.env.BLOB_STORE_ID;
    process.env.AUTH_URL = 'http://127.0.0.1:4310';
    process.env.AUTH_SECRET = randomBytes(48).toString('base64');
    process.env[route.credentialEnv] = randomBytes(32).toString('base64url');
    const { database, closeDatabase } = await import('../src/core/db');
    cleanupDatabase = closeDatabase;
    const tables = await import('../src/core/db/schema');
    const { createAuthentication } = await import('../src/core/auth');
    const { createKey } = await import('../src/core/keys');
    const { postLedger, walletFor } = await import('../src/core/wallet');
    const { saveRoute, createPriceVersion } = await import('../src/core/catalog');
    const { createGateway, availableModels } = await import('../src/core/gateway');
    const userId = randomUUID(), password = randomBytes(24).toString('base64url'), email = `${userId}@example.invalid`;
    const auth = createAuthentication({ db: database().db, origin: process.env.AUTH_URL, secret: process.env.AUTH_SECRET,
      deliverMail: async () => { throw new Error('NO_REAL_EMAIL_IN_FIXTURE'); } });
    const definition = priceDefinition.parse({ rates: [{ metric: 'input_tokens', price: '2', unitQuantity: '1000000' },
      { metric: 'cached_input_tokens', price: '0.04', unitQuantity: '1000000' },
      { metric: 'output_tokens', price: '8', unitQuantity: '1000000' }], tariff: { kind: 'constant' } });
    let cookie = '', key: Awaited<ReturnType<typeof createKey>>, dispatches = 0;
    const received: Record<string, unknown>[] = [];
    const gateway = createGateway({ fetch: async (url, init) => {
      dispatches++;
      assert.equal(String(url), 'https://api.deepseek.com/v1/chat/completions');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${process.env[route.credentialEnv]}`);
      received.push(JSON.parse(String(init?.body)));
      return Response.json({ id: 'synthetic-continuation', choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic document is ready.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 20, completion_tokens: 10 } });
    } });
    const request = (requestId: string, body: unknown) => new Request(`${process.env.AUTH_URL}/v1/chat/completions`, { method: 'POST',
      headers: { 'content-type': 'application/json', cookie, authorization: `Bearer ${key.secret}`, 'idempotency-key': requestId, 'x-ccagent-task-id': 'deepseek-tool-replay-fixture' },
      body: JSON.stringify(body) });
    const record = async (requestId: string) => (await database().db.select().from(tables.reservations).where(eq(tables.reservations.idempotencyKey, requestId)))[0];
    await database().db.insert(tables.user).values({ id: userId, name: 'DeepSeek replay fixture', email, emailVerified: true });
    await database().db.insert(tables.account).values({ id: randomUUID(), userId, providerId: 'credential', accountId: userId, password: await hashPassword(password) });
    const login = await auth.handler(new Request(`${process.env.AUTH_URL}/api/auth/sign-in/email`, { method: 'POST', headers: { origin: process.env.AUTH_URL, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }));
    assert.equal(login.status, 200);
    cookie = login.headers.getSetCookie().find(value => value.startsWith('ccagent.session_token='))!.split(';')[0];
    key = await createKey(userId, 'DeepSeek replay fixture');
    await database().db.transaction(tx => postLedger(tx, userId, 'deepseek-replay-fixture-credit', 'recharge', 1000000n, 0n));
    await saveRoute(userId, route);
    await createPriceVersion(userId, { routeId: route.id, currency: 'CNY', definition,
      sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', effectiveAt: new Date(Date.now() - 1000).toISOString() });
    await saveRoute(userId, { ...route, enabled: true });
    await t.test('invalid thinking never reserves balance or dispatches a supplier call', async () => {
      const before = await walletFor(userId);
      for (const thinking of [null, true, 'disabled', [], {}, { type: 'auto' }, { type: 'enabled', extra: true }]) {
        const id = randomUUID();
        const response = await gateway.execute(request(id, { model: route.id, messages: replayMessages, max_tokens: 16, thinking }), 'chat');
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'INVALID_INPUT');
        assert.equal(await record(id), undefined);
      }
      assert.equal(dispatches, 0);
      assert.deepEqual(await walletFor(userId), before);
    });
    await t.test('both explicit modes reach the supplier and preserve tool history', async () => {
      for (const type of ['enabled', 'disabled']) {
        const id = randomUUID();
        const response = await gateway.execute(request(id, { model: route.id, messages: replayMessages, max_tokens: 16, thinking: { type } }), 'chat');
        assert.equal(response.status, 200);
        assert.equal((await response.json()).choices[0].message.content, 'Synthetic document is ready.');
        assert.deepEqual(received.at(-1)?.thinking, { type });
        assert.deepEqual(received.at(-1)?.messages, replayMessages);
        assert.equal((await record(id)).status, 'settled');
      }
      const id = randomUUID();
      const response = await gateway.execute(request(id, { model: route.id, messages: [{ role: 'user', content: 'Hello' }], max_tokens: 16 }), 'chat');
      assert.equal(response.status, 200); await response.arrayBuffer();
      assert.equal(Object.hasOwn(received.at(-1)!, 'thinking'), false);
      assert.equal(dispatches, 3);
      assert.equal((await walletFor(userId)).frozen, 0n);
    });
    await t.test('catalog reports the selected provider even when the alias suggests another provider', async () => {
      const catalog = await availableModels(request(randomUUID(), {}));
      const actual = catalog.data.find(item => item.id === route.id);
      assert.equal(actual?.provider, 'deepseek');
      assert.equal(actual?.protocol, 'openai-chat');
      assert.equal(actual?.id, 'legacy-qwen-alias');
      assert.equal(JSON.stringify(catalog).includes(route.credentialEnv), false);
      assert.equal(JSON.stringify(catalog).includes(process.env[route.credentialEnv]!), false);
    });
  } finally {
    delete process.env[route.credentialEnv];
    if (savedStorage.token === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = savedStorage.token;
    if (savedStorage.id === undefined) delete process.env.BLOB_STORE_ID; else process.env.BLOB_STORE_ID = savedStorage.id;
    await cleanupDatabase(); await fixture.cleanup();
  }
});
