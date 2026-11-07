import './load-env';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { hashPassword } from 'better-auth/crypto';
import { del } from '@vercel/blob';
import { loadEnv } from '../../src/utils/loadEnv';
import { loadProfiles } from '../../src/services/api/providers/profile';
import { isolatedDatabase } from '../tests/database-fixture';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import { configurePlatform, enterPlatformAccount, getPlatformAccountClient } from '../../src/platform/account';
import { getPlatformGatewayClient, saveOfficialServices } from '../../src/platform/gatewayClient';

if (!process.argv.includes('--run')) {
  console.log('Use --run for two short real supplier requests using disposable auth, wallet and private files. No real user is charged.');
  process.exit(0);
}
const uploadOnly = process.argv.includes('--upload-only');
if (uploadOnly && !process.argv.includes('--native')) throw new Error('UPLOAD_ONLY_REQUIRES_NATIVE');
// Read existing local provider configuration without letting it replace cloud database/auth settings.
const cloudDirectory = process.cwd(), environment = { ...process.env };
process.chdir(path.resolve('..'));
await loadEnv();
const loaded = await loadProfiles();
const deepseek = loaded.profiles.deepseek;
const voiceKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;
const voiceModel = process.env.QWEN_TTS_MODEL || 'qwen-audio-3.1-tts-flash';
const voiceBase = process.env.DASHSCOPE_BASE_URL || process.env.QWEN_BASE_URL;
const voiceUrl = process.env.DASHSCOPE_TTS_URL || `${voiceBase ? new URL(voiceBase).origin : 'https://dashscope.aliyuncs.com'}/api/v1/services/audio/tts/SpeechSynthesizer`;
process.chdir(cloudDirectory);
for (const name of Object.keys(process.env)) if (!(name in environment)) delete process.env[name];
Object.assign(process.env, environment);
if (!deepseek?.apiKey || deepseek.model !== 'deepseek-flash' || !voiceKey || voiceModel !== 'qwen-audio-3.1-tts-flash') throw new Error('LIVE_PRICE_OR_CREDENTIAL_REVIEW_REQUIRED');
process.env.CCAGENT_PROVIDER_LIVE_DEEPSEEK = deepseek.apiKey;
process.env.CCAGENT_PROVIDER_LIVE_VOICE = voiceKey;
process.env.CCAGENT_ALLOWED_UPSTREAM_HOSTS = new URL(voiceUrl).hostname;
const fixture = await isolatedDatabase();
const { nativeHttpFixture } = await import('../tests/native-http-fixture');
const native = process.argv.includes('--native');
let syntheticUploads = 0;
const http = native ? await nativeHttpFixture({ schema: fixture.schema, fetch: async (url, init) => {
  const input = init?.body ? JSON.parse(String(init.body)) : {};
  if (typeof input.input === 'string' && input.input.startsWith('SYNTHETIC_NATIVE_UPLOAD ')) {
    syntheticUploads++;
    return Response.json({ id: 'synthetic-native-upload', object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'UPLOAD_OK' }] }], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1 } });
  }
  if (uploadOnly) throw new Error('REAL_SUPPLIER_DISABLED_IN_UPLOAD_ONLY_CHECK');
  return fetch(url, init);
} }) : undefined;
const clientBase = native ? await mkdtemp(path.join(await realpath(os.tmpdir()), 'ccagent-native-live-')) : undefined;
process.env.AUTH_URL = http?.origin ?? 'http://127.0.0.1:4310';
process.env.AUTH_SECRET = randomBytes(48).toString('base64');
const { database, closeDatabase } = await import('../src/core/db');
const tables = await import('../src/core/db/schema');
const { createAuthentication } = await import('../src/core/auth');
const { createKey } = await import('../src/core/keys');
const { routeInput, saveRoute, createPriceVersion, priceDefinition } = await import('../src/core/catalog');
const { postLedger, walletFor } = await import('../src/core/wallet');
const { createGateway } = await import('../src/core/gateway');
const userId = randomUUID(), email = `${userId}@example.invalid`, password = randomBytes(32).toString('base64url');
const holidays: string[] = [];
for (const [start, end] of [['2026-01-01', '2026-01-03'], ['2026-02-15', '2026-02-23'], ['2026-04-04', '2026-04-06'], ['2026-05-01', '2026-05-05'], ['2026-06-19', '2026-06-21'], ['2026-09-25', '2026-09-27'], ['2026-10-01', '2026-10-07']]) {
  for (let date = new Date(`${start}T00:00:00Z`); date <= new Date(`${end}T00:00:00Z`); date = new Date(date.getTime() + 86400000)) holidays.push(date.toISOString().slice(0, 10));
}
try {
  await database().db.insert(tables.user).values({ id: userId, name: 'Synthetic supplier gateway check', email, emailVerified: true });
  await database().db.insert(tables.account).values({ id: randomUUID(), userId, accountId: userId, providerId: 'credential', password: await hashPassword(password) });
  const auth = createAuthentication({ db: database().db, origin: process.env.AUTH_URL, secret: process.env.AUTH_SECRET, deliverMail: async () => { throw new Error('NO_REAL_EMAIL_IN_FIXTURE'); } });
  http?.setAuthentication(auth);
  const login = await auth.handler(new Request(`${process.env.AUTH_URL}/api/auth/sign-in/email`, { method: 'POST', headers: { origin: process.env.AUTH_URL, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }));
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().find(value => value.startsWith('ccagent.session_token='))!.split(';')[0];
  const key = await createKey(userId, 'synthetic live gateway');
  await database().db.transaction(tx => postLedger(tx, userId, 'synthetic-fixture-credit', 'adjustment', native ? 10000000n : 1000000n, 0n, { fixture: true, realMoney: false }));
  const candidates = [
    { endpoint: 'responses' as const, route: routeInput.parse({ id: 'live-deepseek', name: 'Synthetic live DeepSeek', service: 'chat', protocol: 'openai-responses', provider: 'deepseek', baseUrl: deepseek.baseURL!, upstreamModel: deepseek.model,
      credentialEnv: 'CCAGENT_PROVIDER_LIVE_DEEPSEEK', options: { contextWindow: 1048576, maxOutputTokens: 16 } }),
      definition: priceDefinition.parse({ rates: [{ metric: 'input_tokens', price: '2', offPeakPrice: '1', unitQuantity: '1000000' }, { metric: 'cached_input_tokens', price: '0.04', offPeakPrice: '0.02', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '8', offPeakPrice: '4', unitQuantity: '1000000' }],
        tariff: { kind: 'deepseek', calendarYear: 2026, holidays, calendarSourceUrl: 'https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html' } }),
      sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', input: { input: 'Reply only OK. Synthetic gateway connectivity test.', reasoning: { effort: 'none' }, max_output_tokens: 8 } },
    { endpoint: 'voice' as const, route: routeInput.parse({ id: 'live-voice', name: 'Synthetic live Qwen voice', service: 'voice', protocol: 'dashscope-tts', provider: 'qwen', baseUrl: voiceUrl, upstreamModel: voiceModel,
      credentialEnv: 'CCAGENT_PROVIDER_LIVE_VOICE', options: { contextWindow: 131072, maxOutputTokens: 8192 } }),
      definition: priceDefinition.parse({ rates: [{ metric: 'input_tokens', price: '1.5', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '12', unitQuantity: '1000000' }], tariff: { kind: 'constant' } }),
      sourceUrl: 'https://help.aliyun.com/zh/model-studio/qwen-audio-3-1-tts-flash', input: { text: '测试完成。' } },
  ];
  for (const candidate of candidates) {
    await saveRoute(userId, candidate.route);
    await createPriceVersion(userId, { routeId: candidate.route.id, currency: 'CNY', definition: candidate.definition, sourceUrl: candidate.sourceUrl, effectiveAt: new Date(Date.now() - 1000).toISOString() });
    await saveRoute(userId, { ...candidate.route, enabled: true });
  }
  let client: Awaited<ReturnType<typeof getPlatformGatewayClient>> | undefined;
  if (native) {
    process.env.CCAGENT_PLATFORM_HOME = clientBase; process.env.CCAGENT_HOME = clientBase;
    delete process.env.CCAGENT_ACCOUNT_ID; delete process.env.CCAGENT_AUTH_SESSION_FILE;
    await configurePlatform(http!.origin);
    await (await getPlatformAccountClient()).signIn(email, password); await enterPlatformAccount();
    await saveOfficialServices({ apiKey: key.secret }); client = await getPlatformGatewayClient();
  }
  for (const candidate of uploadOnly ? [] : candidates) {
    const requestId = randomUUID();
    const response: Response = client ? await client.call(candidate.endpoint, { model: candidate.route.id, ...candidate.input }, { requestId, taskId: 'synthetic-live-check' })
      : await createGateway().execute(new Request(`${process.env.AUTH_URL}/v1/${candidate.endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, authorization: `Bearer ${key.secret}`, 'idempotency-key': requestId, 'x-ccagent-task-id': 'synthetic-live-check' },
      body: JSON.stringify({ model: candidate.route.id, ...candidate.input }) }), candidate.endpoint);
    assert.equal(response.status, 200, `GATEWAY_${candidate.endpoint}_FAILED`);
    const result = await response.json() as Record<string, unknown>;
    if (candidate.endpoint === 'voice') {
      const id = (result.audio as { file_id?: string })?.file_id; assert.ok(id);
      if (client) { const audio = Buffer.from(await client.download(id)); assert.equal(audio.toString('ascii', 0, 4), 'RIFF'); assert(audio.length > 44); }
    }
    const [stored] = await database().db.select().from(tables.reservations).where(eq(tables.reservations.idempotencyKey, requestId));
    assert.equal(stored.status, 'settled'); assert.ok(stored.charged > 0n && stored.resultBlobId);
    console.log(JSON.stringify({ service: candidate.endpoint, nativeClient: native, realHttp: native, realSupplier: true, realDatabase: true, privateResult: true, status: stored.status, chargedMicro: stored.charged.toString(), usage: stored.usage, priceSnapshotVersion: 1, realUserCharged: false }));
  }
  if (client) {
    const response = await client.call('responses', { model: 'live-deepseek', input: 'SYNTHETIC_NATIVE_UPLOAD ' + 'x'.repeat(3 * 1024 * 1024), max_output_tokens: 8 }, { taskId: 'synthetic-upload-check' });
    assert.equal(response.status, 200); const result = await response.json() as { output?: unknown }; assert(result.output); assert.equal(syntheticUploads, 1);
    console.log(JSON.stringify({ nativeClient: true, realHttp: true, realDatabase: true, realPrivateUpload: true, syntheticSupplier: true, realUserCharged: false }));
  }
  assert.equal((await walletFor(userId)).frozen, 0n);
} finally {
  await http?.close();
  const files = await database().db.select({ pathname: tables.blobs.pathname }).from(tables.blobs);
  for (const file of files) await del(file.pathname);
  await closeDatabase(); await fixture.cleanup();
  delete process.env.CCAGENT_PROVIDER_LIVE_DEEPSEEK; delete process.env.CCAGENT_PROVIDER_LIVE_VOICE;
  for (const name of ['CCAGENT_PLATFORM_HOME', 'CCAGENT_HOME', 'CCAGENT_ACCOUNT_ID', 'CCAGENT_AUTH_SESSION_FILE']) {
    if (environment[name] === undefined) delete process.env[name]; else process.env[name] = environment[name];
  }
  if (clientBase) {
    if (path.dirname(clientBase) !== await realpath(os.tmpdir()) || !path.basename(clientBase).startsWith('ccagent-native-live-')) throw new Error('UNSAFE_CLIENT_CLEANUP');
    await rm(clientBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
