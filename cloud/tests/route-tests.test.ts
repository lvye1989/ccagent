import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { hashPassword } from 'better-auth/crypto';
import { and, eq, sql } from 'drizzle-orm';
import { isolatedDatabase } from './database-fixture';

test('administrator connection tests use real auth immutable audit and isolated platform costs', { timeout: 600000 }, async t => {
  const fixture = await isolatedDatabase();
  process.env.AUTH_URL = 'http://127.0.0.1:4310'; process.env.AUTH_SECRET = randomBytes(48).toString('base64url');
  const credentialEnv = 'CCAGENT_PROVIDER_ROUTE_TEST_FIXTURE', secret = 'synthetic-probe-secret-' + randomBytes(24).toString('hex'); process.env[credentialEnv] = secret;
  const { database, closeDatabase } = await import('../src/core/db'), tables = await import('../src/core/db/schema');
  const { authentication } = await import('../src/core/auth'), { createRouteTests } = await import('../src/core/route-tests');
  const { saveRoute, routeInput, priceDefinition, createPriceVersion, publishedRoute } = await import('../src/core/catalog');
  const users = [{ id: randomUUID(), name: 'Probe admin', email: 'probe-admin@example.invalid' }, { id: randomUUID(), name: 'Probe user', email: 'probe-user@example.invalid' }];
  const password = randomBytes(32).toString('base64url'), hashed = await hashPassword(password), cookies: string[] = [];
  type Call = { url: string; method: string; body: Record<string, any>; authorization: string | null };
  const calls: Call[] = [], jobs: Promise<void>[] = []; let clockOffset = 0, release: ((value: Response) => void) | undefined;
  const chat = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'OK' } }], usage: { prompt_tokens: 8, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } } });
  let handler: (call: Call, options?: RequestInit) => Promise<Response> = async () => chat();
  const tester = createRouteTests({ now: () => new Date(Date.now() + clockOffset), keepAlive: work => jobs.push(work), fetch: async (url, options) => {
    const call: Call = { url: String(url), method: options?.method || 'GET', body: options?.body ? JSON.parse(String(options.body)) : {}, authorization: new Headers(options?.headers).get('authorization') };
    calls.push(call); return handler(call, options);
  } });
  const headers = (cookie = cookies[0] || '') => ({ cookie, origin: process.env.AUTH_URL!, 'content-type': 'application/json' });
  const get = (routeId = 'probe-chat', testId?: string, cookie = cookies[0] || '') => tester.get(new Request(process.env.AUTH_URL + '/api/admin/routes/test?' + new URLSearchParams({ routeId, ...(testId ? { testId } : {}) }), { headers: headers(cookie) }));
  const post = (body: unknown, cookie = cookies[0] || '', extra: Record<string, string> = {}) => tester.post(new Request(process.env.AUTH_URL + '/api/admin/routes/test', { method: 'POST', headers: { ...headers(cookie), ...extra }, body: JSON.stringify(body) }));
  const drain = async () => { while (jobs.length) await Promise.all(jobs.splice(0)); };
  const quote = async (id = 'probe-chat') => { const response = await get(id); assert.equal(response.status, 200); return (await response.json()).quote; };
  const input = (value: any, testId = randomUUID()) => ({ routeId: value.routeId, testId, confirmationFingerprint: value.confirmationFingerprint, confirmPlatformCost: true });
  const finished = async (body: any) => { const response = await post(body); assert.equal(response.status, 202); await drain(); const status = await get(body.routeId, body.testId); assert.equal(status.status, 200); return (await status.json()).test; };
  const base = { name: 'Probe fixture', provider: 'deepseek', credentialEnv, enabled: false, timeoutMs: 1000, retries: 2, upstreamModel: 'synthetic-probe-model', options: { contextWindow: 4096, maxOutputTokens: 128, maxImages: 2 } };
  const variants = [
    { id: 'probe-chat', service: 'chat', protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com/v1' },
    { id: 'probe-backup', service: 'chat', protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com/v1' },
    { id: 'probe-responses', service: 'chat', protocol: 'openai-responses', baseUrl: 'https://api.deepseek.com/v1' },
    { id: 'probe-vision', service: 'vision', protocol: 'openai-chat', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    { id: 'probe-decision', service: 'decision', protocol: 'jev-decisions', baseUrl: 'https://openrouter.ai/api/v1/decisions' },
    { id: 'probe-tavily', service: 'search', protocol: 'tavily', baseUrl: 'https://api.tavily.com/search' },
    { id: 'probe-bocha', service: 'search', protocol: 'bocha', baseUrl: 'https://api.bochaai.com/web-search' },
    { id: 'probe-voice', service: 'voice', protocol: 'dashscope-tts', baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation' },
  ];
  const tokenRates = [{ metric: 'input_tokens', price: '1', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '1', unitQuantity: '1000000' }];
  let initialWallets: unknown;
  try {
    await database().db.insert(tables.user).values(users.map(user => ({ ...user, emailVerified: true })));
    await database().db.insert(tables.account).values(users.map(user => ({ id: randomUUID(), accountId: user.id, providerId: 'credential', userId: user.id, password: hashed })));
    await database().db.insert(tables.userRoles).values({ userId: users[0]!.id, roleId: 'admin' });
    for (const user of users) {
      const response = await authentication().handler(new Request(process.env.AUTH_URL + '/api/auth/sign-in/email', { method: 'POST', headers: headers(''), body: JSON.stringify({ email: user.email, password }) }));
      assert.equal(response.status, 200); const cookie = response.headers.getSetCookie().find(value => value.startsWith('ccagent.session_token='))?.split(';')[0]; assert(cookie); cookies.push(cookie);
    }
    initialWallets = await database().db.select().from(tables.wallets).orderBy(tables.wallets.userId);
    for (const variant of variants) {
      await saveRoute(users[0]!.id, routeInput.parse({ ...base, ...variant }));
      const rates = variant.protocol === 'tavily' ? [{ metric: 'search_credits', price: '1', unitQuantity: '1' }] : variant.protocol === 'bocha' ? [{ metric: 'requests', price: '1', unitQuantity: '1' }]
        : variant.protocol === 'dashscope-tts' ? [{ metric: 'input_characters', price: '1', unitQuantity: '1000' }] : ['openai-chat', 'openai-responses'].includes(variant.protocol) ? [...tokenRates, { metric: 'cached_input_tokens', price: '0', unitQuantity: '1000000' }] : tokenRates;
      await createPriceVersion(users[0]!.id, { routeId: variant.id, currency: 'CNY', sourceUrl: 'https://example.invalid/synthetic-costs', effectiveAt: new Date(Date.now() - 1000).toISOString(), definition: priceDefinition.parse({ rates, tariff: { kind: 'constant' } }) });
    }
    const primary = routeInput.parse({ ...base, ...variants[0], options: { ...base.options, fallbackEnabled: true, fallbackRouteId: 'probe-backup' } }); await saveRoute(users[0]!.id, primary);

    await t.test('unauthenticated ordinary cross origin unconfirmed and extra-field requests never contact a supplier', async () => {
      const value = input(await quote()), before = calls.length;
      assert.equal((await get('probe-chat', undefined, '')).status, 401); assert.equal((await post(value, '')).status, 401);
      assert.equal((await get('probe-chat', undefined, cookies[1])).status, 403); assert.equal((await post(value, cookies[1])).status, 403);
      assert.equal((await post(value, cookies[0], { origin: 'https://example.invalid' })).status, 403);
      assert.equal((await post({ ...value, confirmPlatformCost: false })).status, 400); assert.equal((await post({ ...value, prompt: 'client input is forbidden' })).status, 400);
      assert.equal(calls.length, before);
    });
    await t.test('free quotes validate saved paused routes and never publish them or expose supplier credentials', async () => {
      const response = await get(), value = await response.json(); assert.equal(value.quote.enabled, false); assert.equal(value.quote.singleAttempt, true); assert.equal(value.quote.fallback, false);
      assert.equal(value.quote.timeoutMs, 1000); assert.match(value.quote.confirmationFingerprint, /^[a-f0-9]{64}$/); assert(BigInt(value.quote.estimatedPublicCostMicro) > 0n);
      assert.equal(value.quote.userChargeMicro, '0'); assert.equal(JSON.stringify(value).includes(secret), false); assert.equal(JSON.stringify(value).includes(credentialEnv), false);
      await assert.rejects(() => publishedRoute('probe-chat'), (error: any) => error.code === 'SERVICE_UNAVAILABLE');
    });
    await t.test('changed limits reject an old cost confirmation before any supplier request or start event', async () => {
      const old = input(await quote()), before = calls.length;
      await saveRoute(users[0]!.id, { ...primary, options: { ...primary.options, maxOutputTokens: 127 } });
      const response = await post(old); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'TEST_CONFIGURATION_CHANGED'); assert.equal(calls.length, before);
      assert.equal((await get(old.routeId, old.testId)).status, 404); await saveRoute(users[0]!.id, primary);
    });
    await t.test('the built-in vision request respects a zero image limit before contacting the supplier', async () => {
      const route = routeInput.parse({ ...base, ...variants[3] }), old = input(await quote(route.id)), before = calls.length;
      await saveRoute(users[0]!.id, { ...route, options: { ...route.options, maxImages: 0 } });
      const response = await get(route.id); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'TEST_IMAGE_LIMIT');
      assert.equal((await post(old)).status, 409); assert.equal(calls.length, before); await saveRoute(users[0]!.id, route);
    });
    await t.test('same request shares one supplier attempt while a second identifier is blocked until the first finishes', async () => {
      let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
      handler = async () => { began(); return new Promise<Response>(resolve => { release = resolve; }); };
      const body = input(await quote()), before = calls.length; assert.equal((await post(body)).status, 202); await started;
      const replay = await post(body); assert.equal(replay.status, 202); assert.equal((await replay.json()).replay, true);
      const other = await post({ ...body, testId: randomUUID() }); assert.equal(other.status, 409); assert.equal((await other.json()).code, 'TEST_IN_PROGRESS'); assert.equal(calls.length, before + 1);
      release!(chat()); release = undefined; await drain(); const result = (await (await get(body.routeId, body.testId)).json()).test;
      assert.equal(result.status, 'succeeded'); assert.equal(result.publicCostMicro, '9'); assert.equal(result.userChargeMicro, '0'); assert.equal(result.usageVerified, true);
      assert.equal(result.pricing.version, 1); assert.equal(result.requestSent, true); assert(result.executionStartedAt);
      assert.equal((await post(body)).status, 200); assert.equal(calls.length, before + 1);
      assert.equal((await post({ ...body, confirmationFingerprint: '0'.repeat(64) })).status, 409); assert.equal(calls.length, before + 1);
      assert.equal((await get(body.routeId, body.testId, cookies[1])).status, 403);
      const rows = await database().db.select().from(tables.audit).where(sql`${tables.audit.id} in (${body.testId},${body.testId + ':result'})`); assert.equal(rows.length, 2);
      assert.deepEqual(new Set(rows.map(row => row.action)), new Set(['routes.test.start', 'routes.test.result']));
      await assert.rejects(() => database().db.update(tables.audit).set({ result: 'tampered' }).where(eq(tables.audit.id, body.testId)));
      handler = async () => chat();
    });
    await t.test('native protocol payloads metering images typed decisions searches and WAV retrieval stay distinct', async t => {
      for (const variant of variants.filter(route => route.id !== 'probe-backup')) await t.test(variant.protocol + ':' + variant.service, async () => {
        const before = calls.length;
        handler = async call => {
          if (call.method === 'GET') { assert.equal(call.authorization, null); const wav = Buffer.alloc(44); wav.write('RIFF'); wav.write('WAVE', 8); return new Response(wav, { headers: { 'content-type': 'audio/wav' } }); }
          assert.equal(call.authorization === 'Bearer ' + secret, true);
          if (variant.protocol === 'openai-chat') {
            assert(call.url.endsWith('/chat/completions')); assert.equal(call.body.stream, false); assert.equal(call.body.max_tokens, 64); assert.equal(call.body.model, base.upstreamModel);
            if (variant.service === 'vision') { assert.equal(call.body.messages[0].content[1].type, 'image_url'); const png = Buffer.from(call.body.messages[0].content[1].image_url.url.split(',')[1], 'base64'); assert.equal(png.readUInt32BE(16), 64); assert.equal(png.readUInt32BE(20), 64); }
            return chat();
          }
          if (variant.protocol === 'openai-responses') { assert(call.url.endsWith('/responses')); assert.equal(call.body.store, false); assert.equal(call.body.max_output_tokens, 64); return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 8, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } }); }
          if (variant.protocol === 'jev-decisions') { assert.equal(call.body.questions.connectivity.type, 'choice'); assert.equal(call.body.messages, undefined); return Response.json({ answers: { connectivity: { type: 'choice', choice: 'ok' } }, usage: { input_tokens: 8, output_tokens: 0 } }); }
          if (variant.protocol === 'tavily') { assert.equal(call.body.search_depth, 'basic'); assert.equal(call.body.max_results, 1); assert.equal(call.body.include_usage, true); return Response.json({ results: [], usage: { credits: 1 } }); }
          if (variant.protocol === 'bocha') { assert.equal(call.body.count, 1); assert.equal(call.body.query, 'Vercel documentation'); return Response.json({ code: 200, data: { webPages: { value: [] } } }); }
          assert.equal(call.body.input.text, '连接测试。'); assert.equal(call.body.input.format, 'wav'); return Response.json({ output: { audio: { url: 'http://probe.oss-cn-beijing.aliyuncs.com/audio.wav?synthetic=1' } }, usage: { characters: 5 } });
        };
        const result = await finished(input(await quote(variant.id))); assert.equal(result.status, 'succeeded'); assert.equal(result.usageVerified, true); assert.equal(result.platformPaid, true); assert.equal(result.userChargeMicro, '0');
        assert.equal(calls.length - before, variant.protocol === 'dashscope-tts' ? 2 : 1); assert.equal(JSON.stringify(result).includes(secret), false);
        if (variant.protocol === 'dashscope-tts') assert(calls.at(-1)!.url.startsWith('https://'));
      }); handler = async () => chat();
    });
    await t.test('provider errors preserve safe status and known account codes without returning arbitrary text or secrets', async () => {
      for (const [status, code] of [[403, secret], [400, 'Arrearage'], [403, 'Unpurchased']] as const) {
        handler = async () => Response.json({ code, error: { code, message: secret }, echoed_secret: secret }, { status });
        const result = await finished(input(await quote())); assert.equal(result.status, 'failed'); assert.equal(result.upstreamStatus, status); assert.equal(result.publicCostMicro, null); assert.equal(JSON.stringify(result).includes(secret), false);
        assert.equal(result.code, code === secret ? 'UPSTREAM_HTTP_403' : code);
      }
    });
    await t.test('missing usage invalid JSON and network uncertainty stay unconfirmed without internal retries or backup', async () => {
      for (const response of [() => Response.json({ choices: [{ message: { content: 'OK' } }] }), () => new Response('not JSON ' + secret), () => { throw new Error(secret); }]) {
        handler = async () => response(); const before = calls.length, result = await finished(input(await quote()));
        assert.equal(result.status, 'unknown'); assert.equal(result.publicCostMicro, null); assert.equal(calls.length, before + 1); assert.equal(JSON.stringify(result).includes(secret), false);
      }
    });
    await t.test('timeout and 5xx make only one supplier attempt despite saved retries and enabled backup', async () => {
      handler = async (_call, options) => new Promise((_resolve, reject) => { options!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); });
      let before = calls.length, result = await finished(input(await quote())); assert.equal(result.code, 'TEST_TIMEOUT'); assert.equal(result.status, 'unknown'); assert.equal(calls.length, before + 1);
      handler = async () => Response.json({ message: secret }, { status: 503 }); before = calls.length; result = await finished(input(await quote())); assert.equal(result.status, 'failed'); assert.equal(result.upstreamStatus, 503); assert.equal(calls.length, before + 1);
    });
    await t.test('voice download host validation and response size limits fail closed without leaking source URLs', async () => {
      handler = async () => Response.json({ output: { audio: { url: 'https://unapproved.example.invalid/' + secret } }, usage: { characters: 5 } });
      let before = calls.length, result = await finished(input(await quote('probe-voice'))); assert.equal(result.status, 'unknown'); assert.equal(calls.length, before + 1); assert.equal(JSON.stringify(result).includes(secret), false);
      handler = async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)); before = calls.length; result = await finished(input(await quote())); assert.equal(result.status, 'unknown'); assert.equal(calls.length, before + 1);
    });
    await t.test('historical results replay after current model configuration is invalid without a new supplier call', async () => {
      handler = async () => chat(); const body = input(await quote('probe-backup')), result = await finished(body), before = calls.length;
      await saveRoute(users[0]!.id, routeInput.parse({ ...base, ...variants[1], upstreamModel: 'changed-model-needs-new-price' }));
      assert.equal((await get(body.routeId)).status, 503);
      const replay = await post(body); assert.equal(replay.status, 200); assert.equal((await replay.json()).test.confirmationFingerprint, result.confirmationFingerprint); assert.equal(calls.length, before);
    });
    await t.test('abandoned starts become unknown and never re-dispatch when the same identifier is queried or replayed', async () => {
      const q = await quote(), body = input(q), hash = await import('node:crypto').then(({ createHash }) => createHash('sha256').update(JSON.stringify([body.routeId, body.confirmationFingerprint, 1])).digest('hex'));
      const previous = (await (await get()).json()).lastTest; assert(previous);
      const old = { ...previous, id: body.testId, routeId: body.routeId, status: 'running', startedAt: new Date().toISOString(), confirmationFingerprint: body.confirmationFingerprint, requestSent: null };
      await database().db.insert(tables.audit).values({ id: body.testId, actorId: users[0]!.id, action: 'routes.test.start', objectId: body.routeId, result: 'running', metadata: { hash, result: old } });
      clockOffset = 6 * 60_000; const before = calls.length;
      assert.equal((await (await get(body.routeId, body.testId)).json()).test.status, 'unknown'); const replay = await post(body); assert.equal(replay.status, 200); assert.equal((await replay.json()).test.status, 'unknown'); assert.equal(calls.length, before); clockOffset = 0;
    });
    await t.test('personal keys reservations ledger orders files and existing user balances remain unchanged', async () => {
      for (const [name, table] of Object.entries({ keys: tables.apiKeys, reservations: tables.reservations, ledger: tables.ledger, orders: tables.orders, files: tables.blobs })) assert.equal((await database().db.select().from(table)).length, 0, name);
      assert.deepEqual(await database().db.select().from(tables.wallets).orderBy(tables.wallets.userId), initialWallets);
      const rows = await database().db.select().from(tables.audit).where(eq(tables.audit.action, 'routes.test.result')); assert(rows.length > 0); assert(rows.every(row => row.actorId === users[0]!.id)); assert.equal(JSON.stringify(rows).includes(secret), false);
    });
    await t.test('live administrator disablement blocks both status and new test requests', async () => {
      const body = input(await quote()), before = calls.length; await database().db.update(tables.user).set({ banned: true }).where(eq(tables.user.id, users[0]!.id));
      assert.equal((await get()).status, 403); assert.equal((await post(body)).status, 403); assert.equal(calls.length, before);
    });
  } finally {
    release?.(chat()); await drain(); delete process.env[credentialEnv]; await closeDatabase(); await fixture.cleanup();
  }
});
