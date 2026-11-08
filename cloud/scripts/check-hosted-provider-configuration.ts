import './load-env';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { and, eq } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { parse } from 'dotenv';
import postgres from 'postgres';
import { isolatedDatabase } from '../tests/database-fixture';
import { databaseSchema, databaseUrl } from '../src/core/env';
import { databaseOptions } from '../src/core/db/options';
import { hostedSupportFixture } from './lib/hosted-support-fixture';

if (!process.argv.includes('--run')) {
  console.log('From cloud/, use --run to verify inherited Preview provider Secret configuration with isolated accounts. No supplier request, real payment or mail is sent.');
  process.exit(0);
}
const cloudRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(process.cwd().toLowerCase(), cloudRoot.toLowerCase(), 'RUN_FROM_CLOUD_DIRECTORY');
assert.equal(databaseSchema(), 'ccagent', 'REVIEW_ORIGINAL_DATABASE_SCHEMA');
const previousEnvironment = { ...process.env };
const realRouteTest = process.argv.includes('--real-route-test');
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), status: 'running', phase: 'prepare-isolation', checks: [] as string[], realProviderRequests: realRouteTest,
  realUserCharged: false, syntheticPrices: true, realMailSent: false, realPayments: false };
const output = path.resolve(cloudRoot, `../output/checks/${realRouteTest ? 'hosted-admin-live-route-test' : 'hosted-provider-configuration'}.json`);
const save = async () => { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); };
const checked = async (name: string) => { (report.checks as string[]).push(name); await save(); };
const credentials = parse(await readFile(path.resolve(cloudRoot, '../.env')));
const forbiddenValues = Object.entries(credentials).filter(([name, value]) => /API_KEY|TOKEN|SECRET|PASSWORD/i.test(name) && value.length >= 16).map(([, value]) => value);
const suppliers = [
  { id: 'credential-check-deepseek', provider: 'deepseek', service: 'chat', protocol: 'openai-responses', baseUrl: 'https://api.deepseek.com/v1', credentialEnv: 'CCAGENT_PROVIDER_DEEPSEEK' },
  { id: 'credential-check-qwen', provider: 'qwen', service: 'vision', protocol: 'openai-chat', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', credentialEnv: 'CCAGENT_PROVIDER_QWEN' },
  { id: 'credential-check-jev', provider: 'openrouter', service: 'decision', protocol: 'jev-decisions', baseUrl: 'https://openrouter.ai/api/alpha/decisions', credentialEnv: 'CCAGENT_PROVIDER_JEV' },
  { id: 'credential-check-tavily', provider: 'tavily', service: 'search', protocol: 'tavily', baseUrl: 'https://api.tavily.com/search', credentialEnv: 'CCAGENT_PROVIDER_TAVILY' },
  { id: 'credential-check-bocha', provider: 'bocha', service: 'search', protocol: 'bocha', baseUrl: 'https://api.bochaai.com/v1/web-search', credentialEnv: 'CCAGENT_PROVIDER_BOCHA' },
];

async function main() {
  const fixture = await isolatedDatabase(); report.schema = fixture.schema;
  const temporary = await realpath(os.tmpdir()), directory = await mkdtemp(path.join(temporary, 'ccagent-provider-config-'));
  let closeDatabase = async () => {}, closeHosted = async () => {};
  let fingerprint: (() => Promise<Record<string, string>>) | undefined, before: Record<string, string> | undefined;
  try {
    const { database, closeDatabase: close } = await import('../src/core/db'); closeDatabase = close;
    const tables = await import('../src/core/db/schema');
    const protectedTables = [tables.user, tables.session, tables.account, tables.userRoles, tables.wallets, tables.ledger, tables.apiKeys,
      tables.routes, tables.prices, tables.orders, tables.reservations, tables.audit, tables.blobs];
    assert.equal(tables.namespace.schemaName, fixture.schema);
    for (const table of protectedTables) assert.equal(getTableConfig(table).schema, fixture.schema);
    const [identity] = await database().client<{ role: string }[]>`select current_user as role`;
    assert.equal(identity!.role, 'ccagent_runtime'); report.runtimeRole = identity!.role;
    fingerprint = async () => {
      const rows: Record<string, string> = {};
      for (const table of protectedTables) {
        const name = getTableConfig(table).name;
        const [row] = await fixture.owner.unsafe<{ digest: string }[]>(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as digest from "ccagent"."${name}" t`);
        rows[name] = row!.digest;
      }
      return rows;
    };
    before = await fingerprint(); report.mainTablesChecked = protectedTables.length;
    const userId = randomUUID(), password = randomBytes(30).toString('base64url'), email = `${userId}@example.invalid`;
    await database().db.insert(tables.user).values({ id: userId, name: 'Isolated provider configuration administrator', email, emailVerified: true });
    await database().db.insert(tables.account).values({ id: randomUUID(), userId, accountId: userId, providerId: 'credential', password: await hashPassword(password) });
    await database().db.insert(tables.userRoles).values({ userId, roleId: 'admin' });
    const { routeInput, saveRoute, createPriceVersion, priceDefinition } = await import('../src/core/catalog');
    for (const supplier of suppliers) await saveRoute(userId, routeInput.parse({ ...supplier, name: supplier.id, upstreamModel: 'configuration-check-only', options: {}, enabled: false }));
    if (realRouteTest) await createPriceVersion(userId, { routeId: 'credential-check-tavily', currency: 'CNY', sourceUrl: 'https://example.invalid/synthetic-admin-test-price', effectiveAt: new Date(Date.now() - 1000).toISOString(),
      definition: priceDefinition.parse({ tariff: { kind: 'constant' }, rates: [{ metric: 'search_credits', price: '0.001', unitQuantity: '1' }] }) });
    process.env.AUTH_SECRET = randomBytes(48).toString('base64url');
    report.phase = 'deploy-inherited-provider-secrets'; await save();
    const hosted = await hostedSupportFixture({ cloudRoot, directory, schema: fixture.schema, providerVariables: [], record: async values => { Object.assign(report, values); await save(); } });
    closeHosted = hosted.close;
    const { platformRequest } = await import('../../src/platform/transport');
    const anonymous = await platformRequest(new URL('/api/admin/settings', hosted.origin), { timeoutMs: 30000 });
    assert.equal(anonymous.status, 401); await anonymous.body?.cancel(); await checked('anonymous-settings-denied');
    process.env.CCAGENT_HOME = directory; process.env.CCAGENT_PLATFORM_HOME = directory;
    for (const name of ['CCAGENT_ACCOUNT_ID', 'CCAGENT_AUTH_SESSION_FILE', 'CCAGENT_CLOUD_URL', 'CCAGENT_ENV_FILE']) delete process.env[name];
    const { configurePlatform, getPlatformAccountClient, enterPlatformAccount, getPlatformSessionFile } = await import('../../src/platform/account');
    report.phase = 'native-admin-login'; await save();
    await configurePlatform(hosted.origin); const account = await getPlatformAccountClient();
    await account.signIn(email, password); await enterPlatformAccount();
    await checked('native-login-and-account-scope-verified');
    const { SecureCredentialStore } = await import('../../src/platform/secureStore');
    const session = await new SecureCredentialStore<{ user: { id: string }; origin: string; cookie: string }>(getPlatformSessionFile()).read();
    assert.equal(session?.user.id, userId); assert.equal(session?.origin, hosted.origin);
    assert.match(session!.cookie, /^(?:__Secure-)?ccagent\.session_token=[^;\s\r\n]+$/);
    // Administrator endpoints use their normal authenticated HTTP boundary; the native service allowlist remains strict.
    const adminRequest = (route: string, body?: Record<string, unknown>) => {
      assert.match(route, /^\/api\/admin\/(?:settings|routes\?id=[a-z0-9-]+|routes\/test(?:\?routeId=[a-z0-9-]+(?:&testId=[a-f0-9-]{36})?)?)$/);
      return platformRequest(new URL(route, hosted.origin), { method: body ? 'POST' : 'GET', ...(body ? { body: Buffer.from(JSON.stringify(body)) } : {}),
        headers: { cookie: session!.cookie, origin: hosted.origin, ...(body ? { 'content-type': 'application/json' } : {}) }, maximumBytes: 1024 * 1024, timeoutMs: 30000 });
    };
    report.phase = 'read-admin-credential-status'; await save();
    const adminGet = async (route: string) => {
      const response = await adminRequest(route);
      assert.equal(response.status, 200, 'HOSTED_ADMIN_READ_FAILED');
      const body = await response.text(); assert.ok(forbiddenValues.every(value => !body.includes(value)), 'HOSTED_RESPONSE_EXPOSES_PROVIDER_SECRET');
      return JSON.parse(body);
    };
    const settings = await adminGet('/api/admin/settings');
    assert.equal(settings.credentials.providers.configuredCount, suppliers.length);
    assert.equal(settings.credentials.backend.schema, fixture.schema);
    assert.equal(settings.credentials.backend.maxConnections, 2);
    assert.equal(settings.credentials.email, false); assert.equal(settings.credentials.payment.merchantConfigured, false); assert.equal(settings.credentials.payment.keyConfigured, false);
    assert.equal(settings.credentials.storage.access, 'private');
    await checked('five-inherited-preview-provider-secrets-and-isolated-schema-confirmed');
    for (const supplier of suppliers) {
      const route = await adminGet(`/api/admin/routes?id=${supplier.id}`);
      assert.equal(route.credentialConfigured, true); assert.equal(route.route.enabled, false); assert.equal(route.ready, false);
      await checked(supplier.id + '-configured-without-secret-exposure-or-sale');
    }
    let completedTest: Record<string, unknown> | undefined;
    if (realRouteTest) {
      report.phase = 'platform-paid-real-tavily-test'; await save();
      const { walletFor } = await import('../src/core/wallet');
      const beforeWallet = await walletFor(userId); assert.equal(beforeWallet.balance, 0n); assert.equal(beforeWallet.frozen, 0n);
      const routeId = 'credential-check-tavily', quote = (await adminGet(`/api/admin/routes/test?routeId=${routeId}`)).quote;
      assert.equal(quote.platformPaid, true); assert.equal(quote.userChargeMicro, '0');
      const body = { routeId, testId: randomUUID(), confirmationFingerprint: quote.confirmationFingerprint, confirmPlatformCost: true };
      report.testId = body.testId; await save();
      const started = await adminRequest('/api/admin/routes/test', body); assert.equal(started.status, 202);
      const initial = await started.json() as { test: Record<string, unknown>; replay: boolean };
      assert.equal(initial.replay, false); assert.equal(initial.test.id, body.testId);
      for (let attempt = 0; attempt < 30; attempt++) {
        completedTest = (await adminGet(`/api/admin/routes/test?routeId=${routeId}&testId=${body.testId}`)).test;
        if (completedTest!.status !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      report.connectionTest = completedTest; await save();
      assert.equal(completedTest!.status, 'succeeded'); assert.equal(completedTest!.upstreamStatus, 200);
      assert.equal(completedTest!.platformPaid, true); assert.equal(completedTest!.userChargeMicro, '0'); assert.equal(completedTest!.requestSent, true);
      assert.equal(completedTest!.responseValidated, true); assert.equal(completedTest!.usageVerified, true);
      assert.deepEqual(completedTest!.quantities, { search_credits: '1' });
      assert.deepEqual(await walletFor(userId), beforeWallet);
      const auditCounts = async () => ({ starts: (await database().db.select().from(tables.audit).where(and(eq(tables.audit.action, 'routes.test.start'), eq(tables.audit.objectId, routeId)))).length,
        results: (await database().db.select().from(tables.audit).where(and(eq(tables.audit.action, 'routes.test.result'), eq(tables.audit.objectId, routeId)))).length });
      assert.deepEqual(await auditCounts(), { starts: 1, results: 1 });
      const repeated = await adminRequest('/api/admin/routes/test', body); assert.equal(repeated.status, 200);
      const replayed = await repeated.json() as { test: Record<string, unknown>; replay: boolean };
      assert.equal(replayed.replay, true); assert.deepEqual(replayed.test, completedTest);
      assert.deepEqual(await auditCounts(), { starts: 1, results: 1 }); assert.deepEqual(await walletFor(userId), beforeWallet);
      Object.assign(report, { replayedOriginalTest: true, auditCounts: await auditCounts(), userWalletUnchanged: true, userBalanceAfter: '0', userFrozenAfter: '0' });
      await checked('real-tavily-platform-paid-test-and-original-id-replay');
    }
    await database().db.delete(tables.userRoles).where(and(eq(tables.userRoles.userId, userId), eq(tables.userRoles.roleId, 'admin')));
    const denied = await adminRequest('/api/admin/settings');
    assert.equal(denied.status, 403); await denied.body?.cancel(); await checked('live-role-revocation-immediately-denies-settings');
    if (realRouteTest) {
      const deniedTest = await adminRequest(`/api/admin/routes/test?routeId=credential-check-tavily&testId=${report.testId}`);
      assert.equal(deniedTest.status, 403); await deniedTest.body?.cancel(); await checked('revoked-administrator-cannot-read-paid-test');
    }
    assert.equal((await database().db.select().from(tables.reservations)).length, 0);
    assert.equal((await database().db.select().from(tables.orders)).length, 0);
    assert.equal((await database().db.select().from(tables.ledger)).length, 0);
    await checked(realRouteTest ? 'zero-user-reservations-orders-and-ledger-entries' : 'zero-paid-calls-orders-and-ledger-entries');
    report.status = 'passed';
  } finally {
    try { await closeHosted(); }
    finally {
      try {
        if (before && fingerprint) { report.mainRowsUnchanged = JSON.stringify(before) === JSON.stringify(await fingerprint()); assert.equal(report.mainRowsUnchanged, true, 'DEVELOPMENT_ROWS_CHANGED'); }
      } finally {
        await closeDatabase(); await fixture.cleanup();
        const audit = postgres(databaseUrl(), databaseOptions(1));
        try { const [row] = await audit<{ count: number }[]>`select count(*)::int as count from pg_namespace where nspname=${fixture.schema}`; report.schemaRemoved = row!.count === 0; assert.equal(report.schemaRemoved, true); }
        finally { await audit.end({ timeout: 5 }); }
        assert.equal(path.dirname(directory), temporary); assert.ok(path.basename(directory).startsWith('ccagent-provider-config-'));
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  }
}

try { await save(); await main(); }
catch (error) { report.status = 'failed'; report.errorType = error instanceof Error ? error.name : 'UnknownError';
  const detail = error as { code?: unknown; status?: unknown };
  if (typeof detail.code === 'string' && /^[A-Za-z0-9_]+$/.test(detail.code)) report.errorCode = detail.code;
  if (typeof detail.status === 'number') report.httpStatus = detail.status;
  const code = error instanceof Error ? error.message : ''; if (!report.errorCode && /^[A-Z0-9_]+$/.test(code)) report.errorCode = code; process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString(); await save();
  for (const name of Object.keys(process.env)) if (!(name in previousEnvironment)) delete process.env[name];
  Object.assign(process.env, previousEnvironment);
}
console.log(JSON.stringify({ status: report.status, checks: (report.checks as string[]).length, mainRowsUnchanged: report.mainRowsUnchanged, schemaRemoved: report.schemaRemoved, hostedDeploymentRemoved: report.hostedDeploymentRemoved, realProviderRequests: realRouteTest }));
