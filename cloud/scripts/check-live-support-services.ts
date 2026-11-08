import './load-env';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { eq } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { hashPassword } from 'better-auth/crypto';
import { del } from '@vercel/blob';
import postgres from 'postgres';
import { isolatedDatabase } from '../tests/database-fixture';
import { databaseSchema, databaseUrl } from '../src/core/env';
import { databaseOptions } from '../src/core/db/options';

if (!process.argv.includes('--run')) {
  console.log('From cloud/, --run checks Jev/Tavily/Bocha once each. --services=deepseek,voice --hosted --inherit-provider-secrets checks those existing providers using Preview Secrets. --prepare-only makes no supplier requests. All wallet prices and funds are synthetic.');
  process.exit(0);
}

const cloudRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(process.cwd().toLowerCase(), cloudRoot.toLowerCase(), 'RUN_FROM_CLOUD_DIRECTORY');
const hosted = process.argv.includes('--hosted');
const selectedServices = (process.argv.find(value => value.startsWith('--services='))?.slice('--services='.length)
  || process.argv.find(value => value.startsWith('--service='))?.slice('--service='.length) || 'jev,tavily,bocha').split(',');
assert.ok(selectedServices.every(value => ['jev', 'tavily', 'bocha', 'deepseek', 'voice'].includes(value)), 'INVALID_SELECTED_SERVICE');
assert.equal(new Set(selectedServices).size, selectedServices.length, 'DUPLICATE_SELECTED_SERVICE');
const primaryProbe = selectedServices.some(value => ['deepseek', 'voice'].includes(value));
assert.ok(!primaryProbe || hosted, 'PRIMARY_SERVICE_PROBE_REQUIRES_HOSTED');
const inheritedSecrets = process.argv.includes('--inherit-provider-secrets');
assert.ok(!inheritedSecrets || hosted, 'INHERITED_SECRET_PROBE_REQUIRES_HOSTED');
const reportName = primaryProbe ? 'live-primary-services-hosted' : hosted ? 'live-support-services-hosted' : 'live-support-services';
const output = path.resolve(cloudRoot, `../output/checks/${reportName}.json`);
const archivedOutput = path.resolve(cloudRoot, `../output/checks/${reportName}-${randomUUID()}.json`);
const prepareOnly = process.argv.includes('--prepare-only');
const originalEnvironment = { ...process.env };
const originalSchema = databaseSchema();
assert.equal(originalSchema, 'ccagent', 'REVIEW_ORIGINAL_DATABASE_SCHEMA');
const credentials = parse(await readFile(path.resolve(cloudRoot, '../.env')));
let primaryModel = 'deepseek-flash', primaryBase = 'https://api.deepseek.com';
const voiceModel = credentials.QWEN_TTS_MODEL || 'qwen-audio-3.1-tts-flash';
const voiceBase = new URL(credentials.DASHSCOPE_BASE_URL || credentials.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com').origin;
const voiceUrl = credentials.DASHSCOPE_TTS_URL || `${voiceBase}/api/v1/services/audio/tts/SpeechSynthesizer`;
if (primaryProbe) {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, credentials); delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const { loadProfiles } = await import('../../src/services/api/providers/profile');
    const profile = (await loadProfiles(path.resolve(cloudRoot, '..'))).profiles.deepseek;
    assert.equal(profile?.protocol, 'openai-responses'); assert.equal(profile?.model, 'deepseek-flash');
    assert.equal(new URL(profile!.baseURL!).origin, 'https://api.deepseek.com');
    primaryModel = profile!.model!; primaryBase = profile!.baseURL!;
    assert.equal(voiceModel, 'qwen-audio-3.1-tts-flash');
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
  }
  process.env.CCAGENT_ALLOWED_UPSTREAM_HOSTS = [...new Set([...(process.env.CCAGENT_ALLOWED_UPSTREAM_HOSTS || '').split(',').filter(Boolean), new URL(voiceUrl).hostname])].join(',');
}
const aliases = inheritedSecrets ? { jev: 'CCAGENT_PROVIDER_JEV', tavily: 'CCAGENT_PROVIDER_TAVILY', bocha: 'CCAGENT_PROVIDER_BOCHA', deepseek: 'CCAGENT_PROVIDER_DEEPSEEK', voice: 'CCAGENT_PROVIDER_QWEN' }
  : { jev: 'CCAGENT_PROVIDER_LIVE_SUPPORT_JEV', tavily: 'CCAGENT_PROVIDER_LIVE_SUPPORT_TAVILY', bocha: 'CCAGENT_PROVIDER_LIVE_SUPPORT_BOCHA', deepseek: 'CCAGENT_PROVIDER_LIVE_SUPPORT_DEEPSEEK', voice: 'CCAGENT_PROVIDER_LIVE_SUPPORT_VOICE' };
for (const [service, secret] of Object.entries({ jev: credentials.OPENROUTER_API_KEY, tavily: credentials.TAVILY_API_KEY, bocha: credentials.bocha_API_KEY || credentials.BOCHA_API_KEY,
  deepseek: credentials.DEEPSEEK_API_KEY, voice: credentials.DASHSCOPE_API_KEY || credentials.QWEN_API_KEY })) {
  assert.ok(secret?.trim(), `MISSING_${service.toUpperCase()}_CREDENTIAL`);
  process.env[aliases[service as keyof typeof aliases]] = secret!.trim();
}

type ServiceResult = { service: string; status: 'passed' | 'failed'; requests: number | null; phase?: string; reservationStatus?: string; pendingReason?: string; transportFailure?: string; upstreamUsageKeys?: string[]; httpStatus?: number; code?: string; chargedSyntheticMicro?: string; replayed?: boolean; usage?: unknown };
const report: { startedAt: string; finishedAt?: string; status: string; phase: string; hosted: boolean; requestCountSource: string; errorType?: string; errorCode?: string; invalidFields?: string[]; schema?: string; runtimeRole?: string; mainTablesChecked?: number; mainRowsUnchanged?: boolean; schemaRemoved?: boolean; services: ServiceResult[]; upstreamRequestCount: number | null; realProviderRequests: boolean; realUserCharged: boolean; syntheticPrices: boolean; paymentTransactions: boolean; realMailSent: boolean; error?: string } = {
  startedAt: new Date().toISOString(), status: 'running', phase: 'database-fixture', hosted, requestCountSource: hosted ? 'persisted-gateway-usage-attempts' : 'local-fetch-boundary', services: [], upstreamRequestCount: hosted ? null : 0, realProviderRequests: !prepareOnly, realUserCharged: false, syntheticPrices: true, paymentTransactions: false, realMailSent: false,
};
Object.assign(report, { selectedServices, credentialSource: inheritedSecrets ? 'inherited-project-preview-secrets' : 'explicit-isolated-deployment-environment' });
const save = async () => { await mkdir(path.dirname(output), { recursive: true }); const data = JSON.stringify(report, null, 2) + '\n'; await writeFile(archivedOutput, data); await writeFile(output, data); };
const phase = async (value: string) => { report.phase = value; await save(); };

async function main() {
  const fixture = await isolatedDatabase();
  report.schema = fixture.schema;
  const temporary = await realpath(os.tmpdir());
  const clientDirectory = await mkdtemp(path.join(temporary, 'ccagent-native-support-'));
  const userId = randomUUID(), password = randomBytes(30).toString('base64url');
  let verifiedBinding = false;
  let closeDatabase = async () => {};
  let closeHttp = async () => {};
  let removeResults = async () => {};
  let fingerprint: (() => Promise<Record<string, string>>) | undefined;
  let before: Record<string, string> | undefined;
  try {
    await phase('database-binding');
    const { database, closeDatabase: close } = await import('../src/core/db');
    closeDatabase = close;
    const tables = await import('../src/core/db/schema');
    const checkedTables = [tables.user, tables.session, tables.account, tables.userRoles, tables.wallets, tables.ledger, tables.apiKeys,
      tables.routes, tables.prices, tables.orders, tables.reservations, tables.audit, tables.blobs];
    assert.equal(tables.namespace.schemaName, fixture.schema);
    for (const table of checkedTables) assert.equal(getTableConfig(table).schema, fixture.schema);
    const [identity] = await database().client<{ role: string }[]>`select current_user as role`;
    assert.equal(identity!.role, 'ccagent_runtime');
    report.runtimeRole = identity!.role; verifiedBinding = true;
    fingerprint = async () => {
      const result: Record<string, string> = {};
      for (const table of checkedTables) {
        const name = getTableConfig(table).name;
        const [row] = await fixture.owner.unsafe<{ digest: string }[]>(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as digest from "${originalSchema}"."${name}" t`);
        result[name] = row!.digest;
      }
      return result;
    };
    before = await fingerprint(); report.mainTablesChecked = checkedTables.length;
    removeResults = async () => {
      const files = await database().db.select({ pathname: tables.blobs.pathname }).from(tables.blobs).where(eq(tables.blobs.userId, userId));
      const prefix = `ccagent/users/${createHash('sha256').update(userId).digest('hex').slice(0, 32)}/`;
      for (const file of files) assert.ok(file.pathname.startsWith(prefix), 'REFUSE_OTHER_OWNER_BLOB_CLEANUP');
      const deleted = await Promise.allSettled(files.map(file => del(file.pathname, { abortSignal: AbortSignal.timeout(15000) })));
      assert.ok(deleted.every(item => item.status === 'fulfilled'), 'RESULT_CLEANUP_FAILED');
    };

    const { routeInput, priceDefinition, saveRoute, createPriceVersion } = await import('../src/core/catalog');
    const { nativeHttpFixture } = await import('../tests/native-http-fixture');
    const { createAuthentication } = await import('../src/core/auth');
    const { createKey } = await import('../src/core/keys');
    const { postLedger, walletFor } = await import('../src/core/wallet');
    const { configurePlatform, enterPlatformAccount, getPlatformAccountClient } = await import('../../src/platform/account');
    const { saveOfficialServices, getPlatformGatewayClient } = await import('../../src/platform/gatewayClient');
    await phase('route-validation');
    const candidates = [
      { service: 'jev', endpoint: 'decisions' as const, route: routeInput.parse({ id: 'support-live-jev', name: 'Isolated real Jev probe', service: 'decision', protocol: 'jev-decisions', provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/alpha/decisions', upstreamModel: credentials.JEV_MODEL || '~typesafe/jev-latest', credentialEnv: aliases.jev, timeoutMs: 60000, retries: 0, options: { contextWindow: 4096, maxOutputTokens: 512 } }),
        definition: priceDefinition.parse({ tariff: { kind: 'constant' }, rates: [{ metric: 'input_tokens', price: '1', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '1', unitQuantity: '1000000' }] }),
        input: { state: 'A private connectivity check for the CCAGENT service gateway.', questions: { connectivity: { type: 'choice', instructions: 'Select the matching state.', criteria: { ready: 'A connectivity check.', other: 'Something else.' } } } } },
      { service: 'tavily', endpoint: 'search' as const, route: routeInput.parse({ id: 'support-live-tavily', name: 'Isolated real Tavily probe', service: 'search', protocol: 'tavily', provider: 'tavily',
        baseUrl: 'https://api.tavily.com/search', upstreamModel: 'tavily-search', credentialEnv: aliases.tavily, timeoutMs: 60000, retries: 0, options: {} }),
        definition: priceDefinition.parse({ tariff: { kind: 'constant' }, rates: [{ metric: 'search_credits', price: '0.001', unitQuantity: '1' }] }),
        input: { query: 'PostgreSQL official documentation', max_results: 1, search_depth: 'basic', include_domains: ['postgresql.org'] } },
      { service: 'bocha', endpoint: 'search' as const, route: routeInput.parse({ id: 'support-live-bocha', name: 'Isolated real Bocha probe', service: 'search', protocol: 'bocha', provider: 'bocha',
        baseUrl: 'https://api.bochaai.com/v1/web-search', upstreamModel: 'bocha-search', credentialEnv: aliases.bocha, timeoutMs: 60000, retries: 0, options: {} }),
        definition: priceDefinition.parse({ tariff: { kind: 'constant' }, rates: [{ metric: 'requests', price: '0.001', unitQuantity: '1' }] }),
        input: { query: 'PostgreSQL official documentation', max_results: 1 } },
      { service: 'deepseek', endpoint: 'responses' as const, route: routeInput.parse({ id: 'primary-live-deepseek', name: 'Isolated real DeepSeek probe', service: 'chat', protocol: 'openai-responses', provider: 'deepseek',
        baseUrl: primaryBase, upstreamModel: primaryModel, credentialEnv: aliases.deepseek, timeoutMs: 60000, retries: 0, options: { contextWindow: 4096, maxOutputTokens: 64 } }),
        definition: priceDefinition.parse({ tariff: { kind: 'constant' }, rates: [{ metric: 'input_tokens', price: '1', unitQuantity: '1000000' }, { metric: 'cached_input_tokens', price: '0', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '1', unitQuantity: '1000000' }] }),
        input: { input: 'Reply only OK. Synthetic connectivity check.', max_output_tokens: 8, reasoning: { effort: 'none' }, store: false } },
      { service: 'voice', endpoint: 'voice' as const, route: routeInput.parse({ id: 'primary-live-voice', name: 'Isolated real Qwen voice probe', service: 'voice', protocol: 'dashscope-tts', provider: 'qwen',
        baseUrl: voiceUrl, upstreamModel: voiceModel, credentialEnv: aliases.voice, timeoutMs: 60000, retries: 0, options: { contextWindow: 4096, maxOutputTokens: 1024 } }),
        definition: priceDefinition.parse({ tariff: { kind: 'constant' }, rates: [{ metric: 'input_tokens', price: '1', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '1', unitQuantity: '1000000' }] }),
        input: { text: '测试完成。', voice: credentials.QWEN_TTS_VOICE || 'longanhuan_v3.1' } },
    ].filter(candidate => selectedServices.includes(candidate.service));
    const requestCounts = new Map(candidates.map(item => [item.route.baseUrl, 0]));
    process.env.AUTH_SECRET = randomBytes(48).toString('base64url');
    if (hosted) await phase('hosted-preview-deployment');
    const http = hosted ? await (await import('./lib/hosted-support-fixture')).hostedSupportFixture({ cloudRoot, directory: clientDirectory, schema: fixture.schema,
      providerVariables: inheritedSecrets ? [] : Object.values(aliases), record: async values => { Object.assign(report, values); await save(); } }) : await nativeHttpFixture({ schema: fixture.schema, fetch: async (url, init) => {
      const endpoint = String(url), count = requestCounts.get(endpoint);
      assert.ok(!prepareOnly, 'REFUSE_REAL_REQUEST_DURING_PREPARATION');
      assert.equal(count, 0, 'REFUSE_EXTRA_OR_UNKNOWN_REAL_PROVIDER_REQUEST');
      requestCounts.set(endpoint, 1);
      report.upstreamRequestCount = (report.upstreamRequestCount ?? 0) + 1;
      return fetch(url, { ...init, redirect: 'error' });
    } });
    closeHttp = http.close;
    process.env.AUTH_URL = http.origin;
    if ('setAuthentication' in http && typeof http.setAuthentication === 'function') {
      const auth = createAuthentication({ db: database().db, origin: http.origin, secret: process.env.AUTH_SECRET, deliverMail: async () => { throw new Error('NO_REAL_MAIL_IN_LIVE_PROBE'); } });
      http.setAuthentication(auth);
    }
    await phase('synthetic-account');
    await database().db.insert(tables.user).values({ id: userId, name: 'Isolated support-service live probe', email: `${userId}@example.invalid`, emailVerified: true });
    await database().db.insert(tables.account).values({ id: randomUUID(), userId, accountId: userId, providerId: 'credential', password: await hashPassword(password) });
    const key = await createKey(userId, 'Isolated real support-service check');
    await database().db.transaction(tx => postLedger(tx, userId, 'synthetic-support-service-credit', 'adjustment', 1000000n, 0n, { fixture: true, realMoney: false }));
    await phase('publish-isolated-catalog');
    for (const candidate of candidates) {
      await saveRoute(userId, candidate.route);
      await createPriceVersion(userId, { routeId: candidate.route.id, currency: 'CNY', definition: candidate.definition, sourceUrl: 'https://example.invalid/synthetic-probe-cost', effectiveAt: new Date(Date.now() - 1000).toISOString() });
      await saveRoute(userId, { ...candidate.route, enabled: true });
    }
    process.env.CCAGENT_HOME = clientDirectory; process.env.CCAGENT_PLATFORM_HOME = clientDirectory;
    delete process.env.CCAGENT_ACCOUNT_ID; delete process.env.CCAGENT_AUTH_SESSION_FILE;
    delete process.env.CCAGENT_CLOUD_URL; delete process.env.CCAGENT_ENV_FILE;
    await phase('native-authentication');
    await configurePlatform(http.origin);
    await (await getPlatformAccountClient()).signIn(`${userId}@example.invalid`, password); await enterPlatformAccount();
    await phase('native-catalog-consent');
    await saveOfficialServices({ apiKey: key.secret });
    const client = await getPlatformGatewayClient();
    assert.ok(client, 'NATIVE_GATEWAY_NOT_CONFIGURED');
    if (prepareOnly) { report.status = 'prepared'; await phase('prepared-without-provider-calls'); return; }
    await phase('provider-calls');
    console.log(JSON.stringify({ isolatedSchema: fixture.schema, runtimeRole: identity!.role, developmentTablesProtected: checkedTables.length, maximumRealRequests: candidates.length }));
    for (const candidate of candidates) {
      const result: ServiceResult = { service: candidate.service, status: 'failed', requests: hosted ? null : 0, phase: 'request' };
      report.services.push(result); await save();
      const requestId = randomUUID();
      try {
        const options = { requestId, taskId: 'isolated-real-support-check' };
        const input = { model: candidate.route.id, ...candidate.input };
        const response = await client!.call(candidate.endpoint, input, options);
        result.httpStatus = response.status;
        assert.equal(response.status, 200, 'LIVE_GATEWAY_RESPONSE_FAILED');
        result.phase = 'payload';
        const payload = await response.json() as Record<string, unknown>;
        result.upstreamUsageKeys = payload.usage && typeof payload.usage === 'object' ? Object.keys(payload.usage).sort() : [];
        if (candidate.service === 'jev') assert.ok(payload.answers && typeof payload.answers === 'object', 'DECISIONS_RESULT_MISSING');
        else if (candidate.service === 'tavily') assert.ok(Array.isArray(payload.results) && payload.results.length, 'TAVILY_RESULT_MISSING');
        else if (candidate.service === 'deepseek') assert.ok(Array.isArray(payload.output) && payload.output.length, 'DEEPSEEK_RESULT_MISSING');
        else if (candidate.service === 'voice') {
          const audio = payload.audio as { file_id: string; bytes: number; content_type: string };
          assert.equal(audio?.content_type, 'audio/wav'); assert.ok(audio.bytes > 44);
          const wav = Buffer.from(await client!.download(audio.file_id));
          assert.equal(wav.length, audio.bytes); assert.equal(wav.subarray(0, 4).toString(), 'RIFF'); assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
        } else {
          const data = payload.data as { webPages?: { value?: unknown[] } } | undefined;
          assert.ok(Array.isArray(data?.webPages?.value) && data.webPages.value.length, 'BOCHA_RESULT_MISSING');
        }
        const [stored] = await database().db.select().from(tables.reservations).where(eq(tables.reservations.idempotencyKey, requestId));
        if (hosted) {
          assert.equal((stored?.usage as Record<string, unknown> | undefined)?.attempts, 1, 'HOSTED_GATEWAY_ATTEMPT_COUNT_MISMATCH');
          requestCounts.set(candidate.route.baseUrl, 1);
        }
        result.phase = 'settlement'; result.reservationStatus = stored?.status;
        result.usage = (stored?.usage as Record<string, unknown> | undefined)?.quantities;
        assert.equal(stored!.status, 'settled', 'SUPPLIER_USAGE_NOT_SETTLED');
        assert.ok(stored!.charged > 0n && stored!.resultBlobId);
        result.phase = 'private-result';
        assert.deepEqual(JSON.parse(Buffer.from(await client!.download(stored!.resultBlobId!)).toString('utf8')), payload, 'OWNED_PRIVATE_RESULT_MISMATCH');
        const wallet = await walletFor(userId);
        result.phase = 'replay';
        const replay = await client!.call(candidate.endpoint, input, options);
        assert.equal(replay.headers.get('x-ccagent-replay'), 'true');
        assert.deepEqual(await replay.json(), payload);
        assert.deepEqual(await walletFor(userId), wallet, 'REPLAY_CHANGED_WALLET');
        assert.equal(requestCounts.get(candidate.route.baseUrl), 1, 'REPLAY_DISPATCHED_ANOTHER_REAL_REQUEST');
        result.status = 'passed'; result.phase = 'complete'; result.replayed = true; result.chargedSyntheticMicro = stored!.charged.toString();
        const usage = stored!.usage as Record<string, unknown>;
        result.usage = usage.quantities;
      } catch (error) {
        const failure = error as { code?: unknown; status?: unknown };
        if (typeof failure.code === 'string' && /^[A-Z0-9_]+$/.test(failure.code)) result.code = failure.code;
        if (typeof failure.status === 'number') result.httpStatus = failure.status;
        result.code ||= 'LIVE_SUPPORT_ASSERTION_FAILED';
      }
      if (hosted || result.status === 'failed') {
        const [stored] = await database().db.select().from(tables.reservations).where(eq(tables.reservations.idempotencyKey, requestId));
        result.reservationStatus = stored?.status;
        const information = stored?.usage as Record<string, unknown> | undefined;
        if (typeof information?.reason === 'string' && /^[a-z_]+$/.test(information.reason)) result.pendingReason = information.reason;
        if (typeof information?.transportFailure === 'string' && /^[a-z_]+$/.test(information.transportFailure)) result.transportFailure = information.transportFailure;
        if (hosted) result.requests = Number.isSafeInteger(information?.attempts) ? information!.attempts as number : null;
      }
      if (!hosted) result.requests = requestCounts.get(candidate.route.baseUrl)!;
      if (hosted) report.upstreamRequestCount = report.services.every(item => item.requests !== null) ? report.services.reduce((sum, item) => sum + item.requests!, 0) : null;
      console.log(JSON.stringify(result)); await save();
    }
    report.status = report.services.every(item => item.status === 'passed') ? 'passed' : 'failed';
  } finally {
    try {
      await closeHttp();
      if (verifiedBinding) await removeResults();
      if (before && fingerprint) {
        report.mainRowsUnchanged = JSON.stringify(await fingerprint()) === JSON.stringify(before);
        assert.ok(report.mainRowsUnchanged, 'DEVELOPMENT_ROWS_CHANGED');
      }
    } finally {
      await closeDatabase(); await fixture.cleanup();
      const audit = postgres(databaseUrl(), databaseOptions(1));
      try { const [row] = await audit<{ count: number }[]>`select count(*)::int as count from pg_namespace where nspname=${fixture.schema}`; report.schemaRemoved = row!.count === 0; assert.ok(report.schemaRemoved, 'ISOLATED_SCHEMA_RETAINED'); }
      finally { await audit.end({ timeout: 5 }); }
      assert.equal(path.dirname(clientDirectory), temporary); assert.ok(path.basename(clientDirectory).startsWith('ccagent-native-support-'));
      await rm(clientDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

try { await phase('database-fixture'); await main(); }
catch (error) {
  report.status = 'failed'; report.error = 'LIVE_SUPPORT_CHECK_FAILED';
  const failure = error as { name?: unknown; message?: unknown; code?: unknown; issues?: { path: unknown[]; code: string }[] };
  if (typeof failure.name === 'string' && /^[A-Za-z]+$/.test(failure.name)) report.errorType = failure.name;
  if (typeof failure.code === 'string' && /^[A-Z0-9_]+$/.test(failure.code)) report.errorCode = failure.code;
  if (!report.errorCode && typeof failure.message === 'string' && /^[A-Z0-9_]+$/.test(failure.message)) report.errorCode = failure.message;
  if (Array.isArray(failure.issues)) report.invalidFields = failure.issues.map(issue => issue.path.join('.') + ':' + issue.code);
}
finally {
  report.finishedAt = new Date().toISOString(); await save();
  for (const name of Object.keys(process.env)) if (!(name in originalEnvironment)) delete process.env[name];
  Object.assign(process.env, originalEnvironment);
}
console.log(JSON.stringify({ status: report.status, mainRowsUnchanged: report.mainRowsUnchanged, schemaRemoved: report.schemaRemoved, realUserCharged: false }));
if (!['passed', 'prepared'].includes(report.status)) process.exitCode = 1;
