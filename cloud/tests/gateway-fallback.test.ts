import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { del } from '@vercel/blob';
import { hashPassword } from 'better-auth/crypto';
import { isolatedDatabase } from './database-fixture';

test('explicitly approved one-hop fallback preserves real funding snapshots billing replay and streaming boundaries', { timeout: 900000 }, async t => {
  const fixture = await isolatedDatabase();
  process.env.AUTH_URL = 'http://127.0.0.1:4310'; process.env.AUTH_SECRET = randomBytes(48).toString('base64url');
  const primaryEnv = 'CCAGENT_PROVIDER_FALLBACK_PRIMARY', backupEnv = 'CCAGENT_PROVIDER_FALLBACK_BACKUP';
  process.env[primaryEnv] = randomBytes(32).toString('base64url'); process.env[backupEnv] = randomBytes(32).toString('base64url');
  const { database, closeDatabase } = await import('../src/core/db'), tables = await import('../src/core/db/schema');
  const { authentication } = await import('../src/core/auth');
  const { createKey } = await import('../src/core/keys');
  const { postLedger, walletFor } = await import('../src/core/wallet');
  const { saveConfiguration } = await import('../src/core/configuration');
  const { routeInput, priceDefinition, saveRoute, createPriceVersion, publishedRoute, publicPricing } = await import('../src/core/catalog');
  const { createGateway } = await import('../src/core/gateway');
  const { ownedCallStatus } = await import('../src/core/calls');
  const userId = randomUUID(), email = `${userId}@example.invalid`, password = randomBytes(24).toString('base64url');
  const primary = routeInput.parse({ id: 'fallback-primary', name: 'Synthetic primary', service: 'chat', protocol: 'openai-responses', provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1', upstreamModel: 'fixture-primary', credentialEnv: primaryEnv, options: { contextWindow: 4096, maxOutputTokens: 64 } });
  const backup = routeInput.parse({ ...primary, id: 'fallback-backup', name: 'Synthetic backup', upstreamModel: 'fixture-backup', credentialEnv: backupEnv });
  const enabledPrimary = { ...primary, enabled: true, options: { ...primary.options, fallbackEnabled: true, fallbackRouteId: backup.id } };
  const price = (amount: string) => priceDefinition.parse({ rates: [{ metric: 'input_tokens', price: amount, unitQuantity: '1000000' },
    { metric: 'cached_input_tokens', price: '0', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '0', unitQuantity: '1000000' }], tariff: { kind: 'constant' } });
  const sourceUrl = 'https://example.invalid/synthetic-price';
  async function publishPrice(id: string, currency: 'CNY' | 'USD', amount: string) { return createPriceVersion(userId, { routeId: id, currency, definition: price(amount), sourceUrl, effectiveAt: new Date(Date.now() - 1000).toISOString() }); }
  const queued: ((signal: AbortSignal) => Response | Promise<Response>)[] = [], sent: string[] = [], work: Promise<void>[] = [];
  const gateway = createGateway({ keepAlive: promise => { work.push(promise); }, fetch: async (_url, init) => {
    const model = JSON.parse(String(init?.body)).model; sent.push(model);
    const expected = model === primary.upstreamModel ? process.env[primaryEnv] : process.env[backupEnv];
    assert.equal(new Headers(init?.headers).get('authorization') === `Bearer ${expected}`, true); assert.equal(init?.redirect, 'error');
    assert.ok(queued.length, 'unexpected extra supplier request'); return queued.shift()!(init!.signal!);
  } });
  const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 10 };
  const success = () => Response.json({ id: 'synthetic', object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'SYNTHETIC_OK' }] }], usage });
  const unavailable = () => new Response('Synthetic unavailable', { status: 503 });
  const body = { model: primary.id, input: 'Synthetic fallback billing fixture only.', max_output_tokens: 16 };
  let cookie = '', apiKey = '';
  async function pins(primaryId = primary.id, backupId = backup.id) {
    const p = await publishedRoute(primaryId), b = await publishedRoute(backupId);
    return { 'x-ccagent-price-version': String(p.price.version), 'x-ccagent-price-fingerprint': publicPricing(p).fingerprint,
      'x-ccagent-fallback-route': backupId, 'x-ccagent-fallback-price-version': String(b.price.version), 'x-ccagent-fallback-price-fingerprint': publicPricing(b).fingerprint };
  }
  const request = (id: string, headers: Record<string, string> = {}, value: unknown = body) => new Request(`${process.env.AUTH_URL}/v1/responses`, { method: 'POST',
    headers: { cookie, authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': id, 'x-ccagent-task-id': 'fallback-fixture', ...headers }, body: JSON.stringify(value) });
  const record = async (id: string) => (await database().db.select().from(tables.reservations).where(eq(tables.reservations.idempotencyKey, id)))[0]!;
  const ledgerCount = async () => (await database().db.select().from(tables.ledger).where(eq(tables.ledger.userId, userId))).length;
  try {
    await database().db.insert(tables.user).values({ id: userId, name: 'Fallback fixture', email, emailVerified: true });
    await database().db.insert(tables.account).values({ id: randomUUID(), userId, accountId: userId, providerId: 'credential', password: await hashPassword(password) });
    const login = await authentication().handler(new Request(`${process.env.AUTH_URL}/api/auth/sign-in/email`, { method: 'POST', headers: { origin: process.env.AUTH_URL, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }));
    assert.equal(login.status, 200); cookie = login.headers.getSetCookie().find(value => value.startsWith('ccagent.session_token='))!.split(';')[0]!;
    apiKey = (await createKey(userId, 'Synthetic fallback')).secret;
    await database().db.transaction(tx => postLedger(tx, userId, 'fallback-fixture-credit', 'recharge', 10000000n, 0n));
    for (const route of [primary, backup]) { await saveRoute(userId, route); await publishPrice(route.id, 'CNY', route.id === primary.id ? '1' : '10'); await saveRoute(userId, { ...route, enabled: true }); }
    await saveRoute(userId, enabledPrimary);
    await t.test('admin rejects missing targets mismatched services protocols and circular maps', async () => {
      assert.equal(routeInput.safeParse({ ...enabledPrimary, options: { ...enabledPrimary.options, fallbackRouteId: null } }).success, false);
      await assert.rejects(saveRoute(userId, { ...enabledPrimary, options: { ...enabledPrimary.options, fallbackRouteId: 'missing-fallback' } }), { code: 'INCOMPATIBLE_FALLBACK' });
      const incompatible = { ...backup, id: 'wrong-protocol', protocol: 'openai-chat' as const }; await saveRoute(userId, incompatible);
      await assert.rejects(saveRoute(userId, { ...enabledPrimary, options: { ...enabledPrimary.options, fallbackRouteId: incompatible.id } }), { code: 'INCOMPATIBLE_FALLBACK' });
      await assert.rejects(saveRoute(userId, { ...backup, enabled: true, options: { ...backup.options, fallbackEnabled: true, fallbackRouteId: primary.id } }), { code: 'FALLBACK_CYCLE' });
    });
    await t.test('administrator mapping alone never authorizes fallback and primary-only calls keep their own rate', async () => {
      const before = sent.length; queued.push(success);
      const response = await gateway.execute(request('no-user-consent'), 'responses'); assert.equal(response.status, 200); await response.text();
      const saved = await record('no-user-consent'); assert.equal(saved.charged, 104n); assert.equal(saved.status, 'settled');
      assert.equal(response.headers.get('x-ccagent-fallback'), 'false'); assert.equal(sent.length - before, 1); assert.equal(object(saved.priceSnapshot).fallback, undefined);
    });
    await t.test('incomplete consent stale prices changed policy and incompatible output limits fail before any funds or supplier request', async () => {
      const agreed = await pins(), before = sent.length, funds = await walletFor(userId), ledger = await ledgerCount();
      for (const [index, values] of [{ 'x-ccagent-fallback-route': backup.id }, { ...agreed, 'x-ccagent-fallback-price-version': '999' }, { ...agreed, 'x-ccagent-price-fingerprint': '0'.repeat(64) }].entries()) {
        const response = await gateway.execute(request(`bad-consent-${index}`, values), 'responses'); assert.ok([400, 409].includes(response.status));
      }
      await saveRoute(userId, { ...primary, enabled: true });
      assert.equal((await gateway.execute(request('disabled-policy', agreed), 'responses')).status, 409); await saveRoute(userId, enabledPrimary);
      await saveRoute(userId, { ...backup, enabled: true, options: { ...backup.options, maxOutputTokens: 8 } });
      assert.equal((await gateway.execute(request('incompatible-limit', await pins()), 'responses')).status, 400); await saveRoute(userId, { ...backup, enabled: true });
      assert.equal(sent.length, before); assert.equal(await ledgerCount(), ledger); assert.deepEqual(await walletFor(userId), funds);
    });
    await t.test('one reservation freezes the larger budget and only the successful backup is charged once with both immutable snapshots', async () => {
      const agreed = await pins(), before = sent.length, funds = await walletFor(userId), ledger = await ledgerCount(); queued.push(unavailable, success);
      const response = await gateway.execute(request('backup-success', agreed), 'responses'); assert.equal(response.status, 200); await response.text();
      const saved = await record('backup-success'), snapshot = object(saved.priceSnapshot), actual = object(saved.usage);
      assert.equal(saved.status, 'settled'); assert.equal(saved.charged, 1040n); assert.ok(saved.authorized > 1040n);
      assert.equal(snapshot.routeId, primary.id); assert.equal(object(snapshot.fallback).routeId, backup.id); assert.equal(object(snapshot.fallbackConsent).fingerprint, agreed['x-ccagent-fallback-price-fingerprint']);
      assert.equal(actual.executedRouteId, backup.id); assert.equal(actual.fallbackUsed, true); assert.equal(actual.attempts, 2); assert.equal(actual.platformRetryCosts, 1);
      assert.equal((await walletFor(userId)).balance, funds.balance - 1040n); assert.equal((await walletFor(userId)).frozen, funds.frozen);
      assert.equal(await ledgerCount() - ledger, 2); assert.deepEqual(sent.slice(before), [primary.upstreamModel, backup.upstreamModel]);
      assert.equal(response.headers.get('x-ccagent-route-id'), backup.id); assert.equal(response.headers.get('x-ccagent-fallback'), 'true');
      assert.equal(JSON.stringify(snapshot).includes(process.env[primaryEnv]!), false); assert.equal(JSON.stringify(snapshot).includes(process.env[backupEnv]!), false);
      const status = await ownedCallStatus(new Request(`${process.env.AUTH_URL}/api/account/calls/backup-success`, { headers: { cookie } }), 'backup-success'); assert.equal(object(status.usage).executedRouteId, backup.id);
      assert.equal(status.executedRouteId, backup.id); assert.equal(status.fallbackUsed, true);
      await saveRoute(userId, { ...primary, enabled: true }); await publishPrice(backup.id, 'CNY', '10');
      const replay = await gateway.execute(request('backup-success', agreed), 'responses'); assert.equal(replay.status, 200); assert.equal(replay.headers.get('x-ccagent-replay'), 'true'); await replay.text();
      assert.equal(replay.headers.get('x-ccagent-route-id'), backup.id); assert.equal(sent.length - before, 2); assert.equal(await ledgerCount() - ledger, 2);
      assert.equal((await gateway.execute(request('backup-success', { ...agreed, 'x-ccagent-fallback-price-version': '999' }), 'responses')).status, 409);
      assert.deepEqual((await record('backup-success')).priceSnapshot, saved.priceSnapshot); await saveRoute(userId, enabledPrimary);
    });
    await t.test('concurrent duplicate fallback requests execute one supplier sequence and one settlement', async () => {
      const agreed = await pins(), before = sent.length, ledger = await ledgerCount();
      let release!: () => void, arrived!: () => void;
      const started = new Promise<void>(resolve => { arrived = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
      const timer = setTimeout(() => release(), 30000);
      queued.push(async () => { arrived(); await held; return unavailable(); }, success);
      const first = gateway.execute(request('concurrent-fallback', agreed), 'responses');
      try {
        await started;
        const duplicate = await gateway.execute(request('concurrent-fallback', agreed), 'responses'); assert.equal(duplicate.status, 409);
        release(); const response = await first; assert.equal(response.status, 200); await response.text();
        assert.equal(sent.length - before, 2); assert.equal(await ledgerCount() - ledger, 2); assert.equal((await record('concurrent-fallback')).charged, 1040n);
      } finally { clearTimeout(timer); release(); await first; }
    });
    await t.test('unusually high backup usage is capped by the authorized budget with the excess borne by the platform', async () => {
      queued.push(unavailable, () => Response.json({ usage: { input_tokens: 1000000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0 }, output: 'Synthetic high usage' }));
      const before = await walletFor(userId), response = await gateway.execute(request('backup-over-budget', await pins()), 'responses');
      assert.equal(response.status, 200); await response.text(); const saved = await record('backup-over-budget'), usage = object(saved.usage);
      assert.equal(saved.charged, saved.authorized); assert.equal(BigInt(String(usage.calculatedChargeMicro)), 13000000n);
      assert.equal(BigInt(String(usage.platformAbsorbedMicro)), 13000000n - saved.authorized); assert.equal((await walletFor(userId)).balance, before.balance - saved.authorized);
    });
    await t.test('primary retries and backup retries are bounded while extra attempts never multiply customer charges', async () => {
      await saveRoute(userId, { ...enabledPrimary, retries: 1 }); queued.push(unavailable, unavailable, success);
      const response = await gateway.execute(request('primary-retry-backup', await pins()), 'responses'); assert.equal(response.status, 200); await response.text();
      assert.equal((await record('primary-retry-backup')).charged, 1040n); assert.equal(object((await record('primary-retry-backup')).usage).attempts, 3);
      await saveRoute(userId, enabledPrimary); await saveRoute(userId, { ...backup, enabled: true, retries: 1 }); queued.push(unavailable, unavailable, success);
      const retried = await gateway.execute(request('backup-retry', await pins()), 'responses'); assert.equal(retried.status, 200); await retried.text();
      assert.equal((await record('backup-retry')).charged, 1040n); assert.equal(object((await record('backup-retry')).usage).platformRetryCosts, 2);
      await saveRoute(userId, { ...backup, enabled: true });
    });
    await t.test('transport failure can switch before output while all attempted secrets are redacted', async () => {
      queued.push(() => { throw new Error('Synthetic transport failure'); }, () => Response.json({ output: `${process.env[primaryEnv]}/${process.env[backupEnv]}`, usage }));
      const response = await gateway.execute(request('transport-backup', await pins()), 'responses'); assert.equal(response.status, 200);
      const text = await response.text(); assert.equal(text.includes(process.env[primaryEnv]!), false); assert.equal(text.includes(process.env[backupEnv]!), false); assert.ok(text.includes('[redacted]'));
      assert.equal((await record('transport-backup')).charged, 1040n);
    });
    await t.test('FX changes invalidate consent even when the backup price version is unchanged', async () => {
      await saveConfiguration(userId, { changes: [{ key: 'settlement_usd_cny', value: '7.2', version: 0 }] }); await publishPrice(backup.id, 'USD', '10');
      const agreed = await pins(), before = sent.length, ledger = await ledgerCount();
      await saveConfiguration(userId, { changes: [{ key: 'settlement_usd_cny', value: '7.3', version: 1 }] });
      const response = await gateway.execute(request('changed-fx', agreed), 'responses'); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'FALLBACK_PRICE_CHANGED');
      assert.equal(sent.length, before); assert.equal(await ledgerCount(), ledger); await publishPrice(backup.id, 'CNY', '10');
    });
    await t.test('definitive request rejection does not invoke backup and an expired overall timeout cannot start another supplier', async () => {
      const before = sent.length; queued.push(() => new Response('Synthetic invalid input', { status: 400 }));
      assert.equal((await gateway.execute(request('supplier-bad-input', await pins()), 'responses')).status, 502);
      assert.equal(sent.length - before, 1); assert.equal((await record('supplier-bad-input')).status, 'released');
      await saveRoute(userId, { ...enabledPrimary, timeoutMs: 1000 });
      queued.push(signal => new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Synthetic timed out')), { once: true })));
      assert.equal((await gateway.execute(request('overall-timeout', await pins()), 'responses')).status, 502); assert.equal(sent.length - before, 2);
      assert.equal((await record('overall-timeout')).status, 'pending'); assert.equal(object((await record('overall-timeout')).usage).fallbackUsed, false);
      await saveRoute(userId, enabledPrimary);
    });
    await t.test('a backup with its own fallback never creates a third attempt and unknown final usage stays frozen', async () => {
      const third = { ...backup, id: 'fallback-third', upstreamModel: 'fixture-third' }; await saveRoute(userId, third); await publishPrice(third.id, 'CNY', '100'); await saveRoute(userId, { ...third, enabled: true });
      await saveRoute(userId, { ...backup, enabled: true, options: { ...backup.options, fallbackEnabled: true, fallbackRouteId: third.id } });
      const before = sent.length; queued.push(unavailable, unavailable);
      assert.equal((await gateway.execute(request('no-third-hop', await pins()), 'responses')).status, 502); assert.equal(sent.length - before, 2);
      const saved = await record('no-third-hop'); assert.equal(saved.status, 'pending'); assert.equal(saved.charged, 0n); assert.equal(object(saved.usage).executedRouteId, backup.id);
      assert.equal(object(object(saved.priceSnapshot).fallback).routeId, backup.id); await saveRoute(userId, { ...backup, enabled: true });
    });
    await t.test('fallback streaming retains native events final usage and split-secret redaction', async () => {
      const events = [{ type: 'response.output_text.delta', delta: `测试${process.env[primaryEnv]}/${process.env[backupEnv]}` }, { type: 'response.completed', response: { status: 'completed', usage } }];
      const raw = new TextEncoder().encode(events.map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(''));
      queued.push(unavailable, () => new Response(new ReadableStream({ start(controller) { for (let index = 0; index < raw.length; index += 7) controller.enqueue(raw.slice(index, index + 7)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } }));
      const response = await gateway.execute(request('backup-stream', await pins(), { ...body, stream: true }), 'responses'); assert.equal(response.status, 200);
      const text = await response.text(); await Promise.allSettled(work); assert.ok(text.includes('response.output_text.delta')); assert.ok(text.includes('测试'));
      assert.equal(text.includes(process.env[primaryEnv]!), false); assert.equal(text.includes(process.env[backupEnv]!), false);
      assert.equal((await record('backup-stream')).charged, 1040n); assert.equal(object((await record('backup-stream')).usage).fallbackUsed, true);
    });
    await t.test('an interrupted successful primary stream never switches or retries after output', async () => {
      const before = sent.length;
      queued.push(() => { let first = true; return new Response(new ReadableStream({ pull(controller) { if (first) { first = false; controller.enqueue(new TextEncoder().encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n')); } else controller.error(new Error('Synthetic interruption')); } }), { headers: { 'content-type': 'text/event-stream' } }); });
      const response = await gateway.execute(request('interrupted-primary', await pins(), { ...body, stream: true }), 'responses'); assert.equal(response.status, 200);
      await assert.rejects(response.text()); await Promise.allSettled(work);
      assert.equal(sent.length - before, 1); const saved = await record('interrupted-primary'); assert.equal(saved.status, 'pending'); assert.equal(saved.charged, 0n); assert.equal(object(saved.usage).fallbackUsed, false);
    });
    await t.test('the successful attempt uses its own tariff boundary and a calendar expiring before dispatch releases funds without sending', async () => {
      for (const route of [primary, backup]) {
        const definition = price(route.id === primary.id ? '1' : '10');
        await createPriceVersion(userId, { routeId: route.id, currency: 'CNY', sourceUrl, effectiveAt: new Date(Date.now() - 1000).toISOString(),
          definition: { rates: definition.rates.map(rate => ({ ...rate, offPeakPrice: rate.metric === 'input_tokens' ? route.id === primary.id ? '0.5' : '5' : '0' })),
            tariff: { kind: 'deepseek', calendarYear: 2026, holidays: [], calendarSourceUrl: 'https://example.invalid/synthetic-calendar' } } });
      }
      const times = ['2026-11-06T00:59:58Z','2026-11-06T00:59:59Z','2026-11-06T01:00:00Z']; let clock = 0, attempts = 0;
      const timed = createGateway({ now: () => new Date(times[Math.min(clock++, times.length - 1)]!), fetch: async () => ++attempts === 1 ? unavailable() : success() });
      const response = await timed.execute(request('tariff-boundary', await pins()), 'responses'); assert.equal(response.status, 200); await response.text();
      const saved = await record('tariff-boundary'); assert.equal(saved.charged, 1040n); assert.equal(object(saved.usage).tariff, 'peak'); assert.equal(object(saved.usage).executionStartedAt, '2026-11-06T01:00:00.000Z');
      // The configured calendar expires at Beijing midnight (UTC 16:00).
      const deadline = ['2026-12-31T15:59:59Z','2026-12-31T16:00:00Z']; let position = 0;
      const expired = createGateway({ now: () => new Date(deadline[Math.min(position++, 1)]!), fetch: async () => { throw new Error('MUST_NOT_DISPATCH'); } });
      const rejected = await expired.execute(request('calendar-before-send', await pins()), 'responses'); assert.equal(rejected.status, 503); assert.equal((await rejected.json()).code, 'PRICE_CALENDAR_EXPIRED');
      const neverSent = await record('calendar-before-send'); assert.equal(neverSent.status, 'released'); assert.equal(neverSent.charged, 0n); assert.equal(object(neverSent.usage).attempts, 0);
      const status = await ownedCallStatus(new Request(`${process.env.AUTH_URL}/api/account/calls/calendar-before-send`, { headers: { cookie } }), 'calendar-before-send'); assert.equal(status.executedRouteId, null);
      await publishPrice(primary.id, 'CNY', '1'); await publishPrice(backup.id, 'CNY', '10');
    });
    const variants: { id: string; service: string; protocol: string; provider: string; baseUrl: string; endpoint: 'chat' | 'decisions' | 'search' | 'voice'; metric: string; input: Record<string, unknown>; reply: unknown; charge: bigint }[] = [
      { id: 'chat', service: 'chat', protocol: 'openai-chat', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', endpoint: 'chat', metric: 'tokens',
        input: { messages: [{ role: 'user', content: 'Synthetic chat' }], max_tokens: 16 }, reply: { choices: [{ message: { role: 'assistant', content: 'CHAT_OK' } }], usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens: 10 } }, charge: 1040n },
      { id: 'vision', service: 'vision', protocol: 'openai-chat', provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', endpoint: 'chat', metric: 'tokens',
        input: { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9sAAAAASUVORK5CYII=' } }] }], max_tokens: 16 },
        reply: { choices: [{ message: { role: 'assistant', content: 'VISION_OK' } }], usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens: 10 } }, charge: 1040n },
      { id: 'decision', service: 'decision', protocol: 'jev-decisions', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1/decisions', endpoint: 'decisions', metric: 'decision',
        input: { state: { stage: 'synthetic' }, questions: { q: { type: 'choice', instructions: 'Choose.', criteria: { yes: 'Allow.', no: 'Deny.' } } } }, reply: { answers: { q: { type: 'choice', choice: 'yes' } }, usage: { input_tokens: 100, output_tokens: 0 } }, charge: 1300n },
      { id: 'tavily', service: 'search', protocol: 'tavily', provider: 'tavily', baseUrl: 'https://api.tavily.com/search', endpoint: 'search', metric: 'search_credits',
        input: { query: 'Synthetic search', max_results: 3, search_depth: 'advanced', topic: 'news', include_domains: ['example.com'] }, reply: { results: [{ title: 'Synthetic', url: 'https://example.com', content: 'TAVILY_OK' }], usage: { credits: 1 } }, charge: 1300n },
      { id: 'bocha', service: 'search', protocol: 'bocha', provider: 'bocha', baseUrl: 'https://api.bochaai.com/web-search', endpoint: 'search', metric: 'requests',
        input: { query: 'Synthetic search', max_results: 3, freshness: 'oneWeek', include_domains: ['example.com'] }, reply: { code: 200, data: { webPages: { value: [{ name: 'Synthetic', url: 'https://example.com', snippet: 'BOCHA_OK' }] } } }, charge: 1300n },
      { id: 'voice', service: 'voice', protocol: 'dashscope-tts', provider: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', endpoint: 'voice', metric: 'input_characters',
        input: { text: 'fixture', voice: 'Cherry' }, reply: { output: { audio: { url: 'http://fixture.oss-cn-beijing.aliyuncs.com/synthetic.wav' } }, usage: { characters: 7 } }, charge: 9100n },
    ];
    for (const variant of variants) await t.test(`${variant.id} fallback preserves its dedicated request response and actual billing unit`, async () => {
      const p = routeInput.parse({ ...primary, id: `special-${variant.id}-primary`, service: variant.service, protocol: variant.protocol, provider: variant.provider, baseUrl: variant.baseUrl });
      const b = routeInput.parse({ ...p, id: `special-${variant.id}-backup`, credentialEnv: backupEnv, upstreamModel: 'fixture-backup' });
      for (const route of [p, b]) {
        await saveRoute(userId, route);
        const definition = variant.metric === 'tokens' ? price(route.id === p.id ? '1' : '10') : priceDefinition.parse({ tariff: { kind: 'constant' },
          rates: variant.metric === 'decision' ? [{ metric: 'input_tokens', price: route.id === p.id ? '1' : '10', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '0', unitQuantity: '1000000' }]
            : [{ metric: variant.metric, price: route.id === p.id ? '0.0001' : '0.001', unitQuantity: '1' }] });
        await createPriceVersion(userId, { routeId: route.id, currency: 'CNY', definition, sourceUrl, effectiveAt: new Date(Date.now() - 1000).toISOString() });
        await saveRoute(userId, { ...route, enabled: true });
      }
      await saveRoute(userId, { ...p, enabled: true, options: { ...p.options, fallbackEnabled: true, fallbackRouteId: b.id } });
      const requests: Record<string, unknown>[] = [], wav = Buffer.alloc(44); wav.write('RIFF', 0); wav.write('WAVE', 8);
      const specialized = createGateway({ fetch: async (url, init) => {
        if (init?.method !== 'POST') { assert.equal(String(url), 'https://fixture.oss-cn-beijing.aliyuncs.com/synthetic.wav'); assert.equal(new Headers(init?.headers).has('authorization'), false); return new Response(wav); }
        requests.push(JSON.parse(String(init.body))); assert.equal(new Headers(init.headers).get('authorization') === `Bearer ${process.env[requests.length === 1 ? primaryEnv : backupEnv]}`, true);
        assert.ok(requests.length <= 2); return requests.length === 1 ? unavailable() : Response.json(variant.reply);
      } });
      const id = `special-${variant.id}`, response = await specialized.execute(request(id, await pins(p.id, b.id), { model: p.id, ...variant.input }), variant.endpoint);
      assert.equal(response.status, 200); const result = await response.json(); assert.equal(requests.length, 2); assert.equal(response.headers.get('x-ccagent-route-id'), b.id);
      assert.equal((await record(id)).charged, variant.charge); assert.equal(object((await record(id)).usage).fallbackUsed, true);
      if (variant.endpoint === 'chat') for (const sent of requests) assert.deepEqual(sent.messages, variant.input.messages);
      if (variant.endpoint === 'decisions') { for (const sent of requests) { assert.deepEqual(sent.state, variant.input.state); assert.deepEqual(sent.questions, variant.input.questions); } assert.deepEqual(result.answers, object(variant.reply).answers); }
      if (variant.endpoint === 'search') { for (const sent of requests) assert.equal(sent.query, variant.input.query); assert.deepEqual(result, variant.reply); }
      if (variant.endpoint === 'voice') { assert.equal(result.audio.content_type, 'audio/wav'); assert.equal(result.audio.bytes, 44); assert.match(result.audio.file_id, /^[a-f0-9-]{36}$/); assert.equal(JSON.stringify(result).includes('oss-cn-beijing'), false); }
    });
    assert.equal(queued.length, 0);
  } finally {
    await Promise.allSettled(work);
    try { for (const file of await database().db.select({ pathname: tables.blobs.pathname }).from(tables.blobs)) await del(file.pathname); }
    finally { await closeDatabase(); await fixture.cleanup(); delete process.env[primaryEnv]; delete process.env[backupEnv]; }
  }
});
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
