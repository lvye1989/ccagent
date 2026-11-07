import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { del } from '@vercel/blob';
import { hashPassword } from 'better-auth/crypto';
import { isolatedDatabase } from './database-fixture';

test('authenticated gateway executes native protocols with real isolated ledger and private results', { timeout: 300000 }, async t => {
  const fixture = await isolatedDatabase();
  process.env.AUTH_URL = 'http://127.0.0.1:4310';
  process.env.AUTH_SECRET = randomBytes(48).toString('base64');
  const credentialEnv = 'CCAGENT_PROVIDER_GATEWAY_FIXTURE';
  process.env[credentialEnv] = randomBytes(32).toString('base64url');
  const { database, closeDatabase } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  const { createAuthentication } = await import('../src/core/auth');
  const { createKey } = await import('../src/core/keys');
  const { postLedger, walletFor } = await import('../src/core/wallet');
  const { routeInput, saveRoute, createPriceVersion, quoteDefinition, priceDefinition } = await import('../src/core/catalog');
  const { createGateway, availableModels } = await import('../src/core/gateway');
  const { ownedCallStatus } = await import('../src/core/calls');
  const { initializeUpload, completeUpload } = await import('../src/core/files');
  const userId = randomUUID(), otherId = randomUUID(), password = randomBytes(24).toString('base64url');
  const email = `${userId}@example.invalid`;
  const auth = createAuthentication({ db: database().db, origin: process.env.AUTH_URL, secret: process.env.AUTH_SECRET, deliverMail: async () => { throw new Error('NO_REAL_EMAIL_IN_FIXTURE'); } });
  const definition = priceDefinition.parse({ rates: [{ metric: 'input_tokens', price: '2', unitQuantity: '1000000' }, { metric: 'cached_input_tokens', price: '0.04', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '8', unitQuantity: '1000000' }], tariff: { kind: 'constant' } });
  const queued: (() => Promise<Response> | Response)[] = [], work: Promise<void>[] = [];
  let calls = 0;
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const gateway = createGateway({ keepAlive: promise => { work.push(promise); }, fetch: async (url, init) => {
    calls++; assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${process.env[credentialEnv]}`);
    assert.equal(init?.redirect, 'error'); sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    assert.ok(queued.length, 'unexpected additional supplier request'); return queued.shift()!();
  } });
  const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 10 };
  const reply = () => Response.json({ id: 'fixture-response', object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'synthetic result' }] }], usage });
  let cookie = '', key: Awaited<ReturnType<typeof createKey>>;
  const request = (callId: string, body: unknown, overrides: Record<string, string> = {}) => new Request(`${process.env.AUTH_URL}/v1/responses`, { method: 'POST',
    headers: { 'content-type': 'application/json', cookie, authorization: `Bearer ${key.secret}`, 'idempotency-key': callId, 'x-ccagent-task-id': 'gateway-fixture', ...overrides }, body: JSON.stringify(body) });
  const payload = { model: 'gateway-responses', input: 'Synthetic billing test only.', max_output_tokens: 16 };
  async function record(callId: string) { return (await database().db.select().from(tables.reservations).where(eq(tables.reservations.idempotencyKey, callId)))[0]; }
  try {
    await database().db.insert(tables.user).values([{ id: userId, name: 'Gateway fixture', email, emailVerified: true }, { id: otherId, name: 'Other fixture', email: `${otherId}@example.invalid`, emailVerified: true }]);
    await database().db.insert(tables.account).values({ id: randomUUID(), userId, providerId: 'credential', accountId: userId, password: await hashPassword(password) });
    const login = await auth.handler(new Request(`${process.env.AUTH_URL}/api/auth/sign-in/email`, { method: 'POST', headers: { origin: process.env.AUTH_URL, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }));
    assert.equal(login.status, 200);
    cookie = login.headers.getSetCookie().find(value => value.startsWith('ccagent.session_token='))!.split(';')[0];
    key = await createKey(userId, 'gateway fixture');
    await database().db.transaction(tx => postLedger(tx, userId, 'fixture-credit', 'recharge', 1000000n, 0n));
    const route = routeInput.parse({ id: 'gateway-responses', name: 'Gateway fixture', service: 'chat', protocol: 'openai-responses', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', upstreamModel: 'synthetic-fixture-model', credentialEnv, retries: 1, options: { contextWindow: 4096, maxOutputTokens: 64 } });
    for (const value of [route, { ...route, id: 'gateway-chat', protocol: 'openai-chat' as const }]) {
      await saveRoute(userId, value);
      await createPriceVersion(userId, { routeId: value.id, currency: 'CNY', definition, sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', effectiveAt: new Date(Date.now() - 1000).toISOString() });
      await saveRoute(userId, { ...value, enabled: true });
    }
    await t.test('app login, key ownership, origin and protocol checks precede supplier execution', async () => {
      assert.equal((await gateway.execute(request('no-login', payload, { cookie: '' }), 'responses')).status, 401);
      const otherKey = await createKey(otherId, 'other');
      assert.equal((await gateway.execute(request('wrong-owner', payload, { authorization: `Bearer ${otherKey.secret}` }), 'responses')).status, 403);
      assert.equal((await gateway.execute(request('cross-origin', payload, { origin: 'https://attacker.invalid' }), 'responses')).status, 403);
      assert.equal((await gateway.execute(request('protocol', payload), 'chat')).status, 400);
      assert.equal((await gateway.execute(request('paid-tool', { ...payload, tools: [{ type: 'web_search' }] }), 'responses')).status, 400);
      assert.equal((await gateway.execute(request('server-state', { ...payload, previous_response_id: 'another-users-provider-id' }), 'responses')).status, 400);
      assert.equal((await gateway.execute(request('old-price', payload, { 'x-ccagent-price-version': '999999' }), 'responses')).status, 409);
      assert.equal((await gateway.execute(request('bad-price', payload, { 'x-ccagent-price-version': 'invalid' }), 'responses')).status, 400);
      assert.equal(calls, 0); assert.equal((await walletFor(userId)).frozen, 0n);
      const models = await availableModels(request('discovery', payload));
      assert.equal(models.data.length, 2); assert.equal(JSON.stringify(models).includes(credentialEnv), false);
    });
    await t.test('native Responses request, measured cache pricing, immutable snapshots and replay execute only once', async () => {
      queued.push(reply);
      const result = await gateway.execute(request('measured', payload), 'responses');
      assert.equal(result.status, 200); assert.equal((await result.json()).output[0].content[0].text, 'synthetic result');
      assert.equal(sent[0].url, 'https://api.deepseek.com/v1/responses');
      assert.equal(sent[0].body.model, 'synthetic-fixture-model'); assert.equal(sent[0].body.store, false);
      const stored = await record('measured');
      assert.equal(stored.status, 'settled');
      assert.equal(stored.charged, quoteDefinition(definition, 'CNY', { input_tokens: 80n, cached_input_tokens: 20n, output_tokens: 10n }, new Date()).chargeMicro);
      assert.equal(object(stored.priceSnapshot).markup, '1.3'); assert.equal(JSON.stringify(stored.priceSnapshot).includes(payload.input), false);
      const again = await gateway.execute(request('measured', payload), 'responses');
      assert.equal(again.status, 200); assert.equal(again.headers.get('x-ccagent-replay'), 'true'); await again.arrayBuffer();
      assert.equal(calls, 1);
      assert.equal((await gateway.execute(request('measured', { ...payload, input: 'changed' }), 'responses')).status, 409);
      assert.equal(calls, 1);
    });
    await t.test('internal retry records platform cost but charges only the final measured response', async () => {
      queued.push(() => new Response('temporary', { status: 500 }), reply);
      const response = await gateway.execute(request('retry', payload), 'responses');
      assert.equal(response.status, 200); await response.arrayBuffer();
      const stored = await record('retry');
      assert.equal(stored.charged, (await record('measured')).charged);
      assert.equal(object(stored.usage).attempts, 2); assert.equal(object(stored.usage).platformRetryCosts, 1);
    });
    await t.test('stream framing preserves UTF-8, reasoning and tool arguments while final usage settles once', async () => {
      const content = [
        { type: 'response.reasoning_text.delta', delta: '推理片段' },
        { type: 'response.function_call_arguments.delta', item_id: 'tool-1', delta: '{"path":"synthetic.txt"}' },
        { type: 'response.completed', response: { status: 'completed', usage } },
      ].map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join('');
      const encoded = Buffer.from(content);
      queued.push(() => new Response(new ReadableStream({ start(controller) { for (let i = 0; i < encoded.length; i += 7) controller.enqueue(encoded.subarray(i, i + 7)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } }));
      const result = await gateway.execute(request('stream', { ...payload, stream: true }), 'responses');
      assert.equal(await result.text(), content); await Promise.all(work);
      assert.equal((await record('stream')).status, 'settled'); assert.equal((await record('stream')).charged, (await record('measured')).charged);
    });
    await t.test('client cancellation continues bounded final usage collection and never creates another call', async () => {
      let finish!: () => void;
      queued.push(() => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(Buffer.from('data: {"type":"response.output_text.delta","delta":"synthetic"}\n\n'));
        finish = () => { controller.enqueue(Buffer.from(`data: ${JSON.stringify({ type: 'response.completed', response: { usage } })}\n\n`)); controller.close(); };
      } }), { headers: { 'content-type': 'text/event-stream' } }));
      const result = await gateway.execute(request('cancelled', { ...payload, stream: true }), 'responses');
      await result.body!.cancel(); finish(); await Promise.all(work);
      const stored = await record('cancelled'); assert.equal(stored.status, 'settled'); assert.equal(object(stored.usage).interrupted, true);
    });
    await t.test('missing usage stays pending with frozen funds; repeated request never reruns the supplier', async () => {
      queued.push(() => Response.json({ output: [], usage: { input_tokens: 100 } }));
      const result = await gateway.execute(request('unmeasured', payload), 'responses');
      assert.equal(result.status, 200); await result.arrayBuffer();
      assert.equal((await record('unmeasured')).status, 'pending');
      const before = calls;
      assert.equal((await gateway.execute(request('unmeasured', payload), 'responses')).status, 409);
      assert.equal(calls, before); assert.ok((await walletFor(userId)).frozen > 0n);
    });
    await t.test('rejected input releases its authorization and does not expose supplier error bodies', async () => {
      queued.push(() => new Response(`supplier secret ${process.env[credentialEnv]}`, { status: 400 }));
      const result = await gateway.execute(request('rejected', payload), 'responses');
      assert.equal(result.status, 502); assert.equal((await result.text()).includes(process.env[credentialEnv]!), false);
      assert.equal((await record('rejected')).status, 'released'); assert.equal((await record('rejected')).charged, 0n);
    });
    await t.test('large request files and image references enforce ownership before authorization', async () => {
      const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr4kAAAAASUVORK5CYII=', 'base64');
      const upload = await initializeUpload(otherId, { purpose: 'image', contentType: 'image/png', size: image.length });
      const put = await fetch(upload.upload.url, { method: 'PUT', headers: upload.upload.headers, body: image }); assert.ok(put.ok);
      await completeUpload(otherId, upload.id);
      const before = calls;
      const result = await gateway.execute(request('cross-file', { ...payload, input: [{ role: 'user', content: [{ type: 'input_image', image_url: `ccagent-file:${upload.id}` }] }] }), 'responses');
      assert.equal(result.status, 404); assert.equal(calls, before); assert.equal(await record('cross-file'), undefined);
      const body = Buffer.from(JSON.stringify(payload));
      const large = await initializeUpload(userId, { purpose: 'request', contentType: 'application/json', size: body.length });
      assert.ok((await fetch(large.upload.url, { method: 'PUT', headers: large.upload.headers, body })).ok);
      await completeUpload(userId, large.id); queued.push(reply);
      const accepted = await gateway.execute(request('large', { request_file_id: large.id }), 'responses'); assert.equal(accepted.status, 200); await accepted.arrayBuffer();
    });
    await t.test('call status is login-owned, omits private identifiers and remains readable after key revocation', async () => {
      const status = await ownedCallStatus(new Request(process.env.AUTH_URL + '/api/account/calls/measured', { headers: { cookie } }), 'measured');
      assert.equal(status.status, 'settled'); assert.equal(status.resultAvailable, true);
      assert.equal(status.charged, (await record('measured')).charged);
      assert.equal('userId' in status || 'keyId' in status || 'resultId' in status || 'requestHash' in status, false);
      await assert.rejects(ownedCallStatus(new Request(process.env.AUTH_URL + '/api/account/calls/measured'), 'measured'), error => (error as { status?: number }).status === 401);
      await database().db.insert(tables.account).values({ id: randomUUID(), userId: otherId, providerId: 'credential', accountId: otherId, password: await hashPassword(password) });
      const login = await auth.handler(new Request(process.env.AUTH_URL + '/api/auth/sign-in/email', { method: 'POST', headers: { origin: process.env.AUTH_URL!, 'content-type': 'application/json' }, body: JSON.stringify({ email: `${otherId}@example.invalid`, password }) }));
      assert.equal(login.status, 200); const otherCookie = login.headers.getSetCookie().find(value => value.startsWith('ccagent.session_token='))!.split(';')[0];
      await assert.rejects(ownedCallStatus(new Request(process.env.AUTH_URL + '/api/account/calls/measured', { headers: { cookie: otherCookie } }), 'measured'), error => (error as { status?: number }).status === 404);
      const { revokeKey } = await import('../src/core/keys'); await revokeKey(userId, key.key.id);
      assert.equal((await ownedCallStatus(new Request(process.env.AUTH_URL + '/api/account/calls/measured', { headers: { cookie } }), 'measured')).status, 'settled');
    });
  } finally {
    await Promise.allSettled(work);
    const files = await database().db.select({ pathname: tables.blobs.pathname }).from(tables.blobs);
    for (const file of files) await del(file.pathname);
    await closeDatabase(); await fixture.cleanup(); delete process.env[credentialEnv];
  }
});

function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
