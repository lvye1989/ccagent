import './load-env';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { del } from '@vercel/blob';
import { isolatedDatabase } from '../tests/database-fixture';
import { databaseSchema, databaseUrl } from '../src/core/env';
import { databaseOptions } from '../src/core/db/options';
import { hostedSupportFixture } from './lib/hosted-support-fixture';

if (!process.argv.includes('--run')) {
  console.log('From cloud/, --run uses the real QueryEngine and at most two unique DeepSeek requests. Add --cancel-stream for one native request stopped before completion, then query/replay its original id. Funds and prices are synthetic.');
  process.exit(0);
}
const cloudRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(process.cwd().toLowerCase(), cloudRoot.toLowerCase()); assert.equal(databaseSchema(), 'ccagent');
const originalEnvironment = { ...process.env };
const cancelStream = process.argv.includes('--cancel-stream'), expectedCalls = cancelStream ? 1 : 2;
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), status: 'running', phase: 'isolate-database', realProviderCalls: true,
  provider: 'deepseek', inheritedPreviewSecret: true, actualQueryEngine: !cancelStream, maximumUniquePaidRequests: expectedCalls, syntheticPrices: true, realUserCharged: false, realPayments: false, realMailSent: false };
const reportName = cancelStream ? 'live-cancel-stream-hosted' : 'live-engine-hosted';
const output = path.resolve(cloudRoot, `../output/checks/${reportName}.json`);
const archive = path.resolve(cloudRoot, `../output/checks/${reportName}-${randomUUID()}.json`);
const save = async () => { await mkdir(path.dirname(output), { recursive: true }); const data = JSON.stringify(report, null, 2) + '\n'; await writeFile(archive, data); await writeFile(output, data); };
const phase = async (value: string) => { report.phase = value; await save(); };

async function main() {
  const fixture = await isolatedDatabase(); report.schema = fixture.schema;
  const temporary = await realpath(os.tmpdir()), directory = await mkdtemp(path.join(temporary, 'ccagent-engine-live-'));
  const workspace = path.join(directory, 'workspace'), home = path.join(directory, 'home');
  await mkdir(workspace); await mkdir(home);
  const proofName = 'stream-proof.txt', proofFile = path.join(workspace, proofName), proof = 'CCAGENT_PROOF_' + randomBytes(18).toString('hex');
  await writeFile(proofFile, proof + '\n');
  const userId = randomUUID(), taskId = randomUUID(), password = randomBytes(30).toString('base64url');
  let closeDatabase = async () => {}, closeHosted = async () => {}, restoreHook = () => {}, removeResults = async () => {};
  let observeCalls = async () => {};
  let fingerprint: (() => Promise<Record<string, string>>) | undefined, before: Record<string, string> | undefined;
  try {
    const { database, closeDatabase: close } = await import('../src/core/db'); closeDatabase = close;
    const tables = await import('../src/core/db/schema');
    const checkedTables = [tables.user, tables.session, tables.account, tables.userRoles, tables.wallets, tables.ledger, tables.apiKeys,
      tables.routes, tables.prices, tables.orders, tables.reservations, tables.audit, tables.blobs];
    assert.equal(tables.namespace.schemaName, fixture.schema);
    for (const table of checkedTables) assert.equal(getTableConfig(table).schema, fixture.schema);
    const [identity] = await database().client<{ role: string }[]>`select current_user as role`;
    assert.equal(identity!.role, 'ccagent_runtime'); report.runtimeRole = identity!.role;
    fingerprint = async () => {
      const result: Record<string, string> = {};
      for (const table of checkedTables) {
        const name = getTableConfig(table).name;
        const [row] = await fixture.owner.unsafe<{ digest: string }[]>(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as digest from "ccagent"."${name}" t`);
        result[name] = row!.digest;
      }
      return result;
    };
    before = await fingerprint(); report.mainTablesChecked = checkedTables.length;
    observeCalls = async () => {
      const calls = await database().db.select().from(tables.reservations).where(eq(tables.reservations.userId, userId));
      report.observedCalls = calls.map(call => {
        const usage = call.usage as { attempts?: number; reason?: string; transportFailure?: string; quantities?: unknown } | null;
        return { requestId: call.idempotencyKey, status: call.status, chargedSyntheticMicro: call.charged.toString(), resultSaved: !!call.resultBlobId,
          attempts: usage?.attempts, reason: usage?.reason, transportFailure: usage?.transportFailure, usage: usage?.quantities };
      });
      await save();
    };
    removeResults = async () => {
      const files = await database().db.select({ pathname: tables.blobs.pathname }).from(tables.blobs).where(eq(tables.blobs.userId, userId));
      const prefix = `ccagent/users/${createHash('sha256').update(userId).digest('hex').slice(0, 32)}/`;
      for (const file of files) assert.ok(file.pathname.startsWith(prefix), 'REFUSE_OTHER_USER_RESULT_CLEANUP');
      const removed = await Promise.allSettled(files.map(file => del(file.pathname, { abortSignal: AbortSignal.timeout(15000) })));
      assert.ok(removed.every(item => item.status === 'fulfilled'), 'ENGINE_RESULT_CLEANUP_FAILED');
    };
    await phase('seed-isolated-route');
    const { routeInput, priceDefinition, saveRoute, createPriceVersion } = await import('../src/core/catalog');
    const { createKey } = await import('../src/core/keys');
    const { postLedger, walletFor } = await import('../src/core/wallet');
    // Local route seeding validates presence. This marker is never included in deployment env arguments;
    // only Vercel's inherited project Secret can authenticate the actual remote supplier request.
    process.env.CCAGENT_PROVIDER_DEEPSEEK ||= 'isolated-seeder-marker-not-a-provider-key';
    report.localSeederMarkerNotDeployed = true;
    await database().db.insert(tables.user).values({ id: userId, name: 'Isolated real engine acceptance', email: `${userId}@example.invalid`, emailVerified: true });
    await database().db.insert(tables.account).values({ id: randomUUID(), accountId: userId, userId, providerId: 'credential', password: await hashPassword(password) });
    const key = await createKey(userId, 'Isolated real streaming engine');
    await database().db.transaction(tx => postLedger(tx, userId, 'synthetic-engine-credit', 'adjustment', 1000000n, 0n, { fixture: true, realMoney: false }));
    const route = routeInput.parse({ id: 'engine-live-deepseek', name: 'Isolated DeepSeek tool loop', service: 'chat', protocol: 'openai-responses', provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com', upstreamModel: 'deepseek-flash', credentialEnv: 'CCAGENT_PROVIDER_DEEPSEEK', timeoutMs: 90000, retries: 0,
      options: { contextWindow: 65536, maxOutputTokens: cancelStream ? 512 : 256 } });
    await saveRoute(userId, route);
    await createPriceVersion(userId, { routeId: route.id, currency: 'CNY', sourceUrl: 'https://example.invalid/synthetic-engine-price', effectiveAt: new Date(Date.now() - 1000).toISOString(),
      definition: priceDefinition.parse({ tariff: { kind: 'constant' }, rates: [{ metric: 'input_tokens', price: '1', unitQuantity: '1000000' }, { metric: 'cached_input_tokens', price: '0', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '1', unitQuantity: '1000000' }] }) });
    await saveRoute(userId, { ...route, enabled: true });
    process.env.AUTH_SECRET = randomBytes(48).toString('base64url');
    await phase('deploy-protected-preview');
    const hosted = await hostedSupportFixture({ cloudRoot, directory, schema: fixture.schema, providerVariables: [], record: async values => { Object.assign(report, values); await save(); } });
    closeHosted = hosted.close;
    process.env.CCAGENT_HOME = home; process.env.CCAGENT_PLATFORM_HOME = home;
    for (const name of ['CCAGENT_ACCOUNT_ID', 'CCAGENT_AUTH_SESSION_FILE', 'CCAGENT_CLOUD_URL', 'CCAGENT_ENV_FILE', 'CCAGENT_DEBUG_STREAM']) delete process.env[name];
    const { configurePlatform, getPlatformAccountClient, enterPlatformAccount } = await import('../../src/platform/account');
    const { saveOfficialServices, getPlatformGatewayClient } = await import('../../src/platform/gatewayClient');
    await phase('native-login-and-catalog');
    await configurePlatform(hosted.origin); await (await getPlatformAccountClient()).signIn(`${userId}@example.invalid`, password); await enterPlatformAccount();
    await saveOfficialServices({ apiKey: key.secret, roles: { main: route.id }, auxiliaryEnabled: false, fallbackEnabled: false });
    const client = await getPlatformGatewayClient(); assert.ok(client);

    type Captured = { requestId: string; taskId: string; body?: Record<string, unknown>; httpRequests: number };
    const requests = new Map<string, Captured>();
    const protectedRequest = https.request;
    https.request = function (url: URL | string, ...args: unknown[]) {
      const target = new URL(url);
      if (target.origin !== hosted.origin || target.pathname !== '/v1/responses') return Reflect.apply(protectedRequest, https, [url, ...args]);
      const options = args[0] as https.RequestOptions, headers = new Headers(options.headers as Record<string, string>);
      const requestId = headers.get('idempotency-key') || '', sentTask = headers.get('x-ccagent-task-id') || '';
      assert.match(requestId, /^[a-f0-9-]{36}$/); assert.equal(sentTask, taskId);
      if (!requests.has(requestId)) { assert.ok(requests.size < expectedCalls, 'REAL_ENGINE_REQUEST_BUDGET_EXCEEDED'); requests.set(requestId, { requestId, taskId: sentTask, httpRequests: 0 }); }
      const record = requests.get(requestId)!; record.httpRequests++;
      const request = Reflect.apply(protectedRequest, https, [url, ...args]);
      const end = request.end;
      request.end = function (...values: unknown[]) {
        assert.ok(values[0] instanceof Uint8Array, 'ENGINE_REQUEST_BODY_MISSING');
        const body = JSON.parse(Buffer.from(values[0] as Uint8Array).toString('utf8')) as Record<string, unknown>;
        assert.equal(body.model, route.id); assert.equal(body.stream, true);
        const tools = (body.tools || []) as { name?: string }[];
        assert.deepEqual(tools.map(tool => tool.name), cancelStream ? [] : ['Read'], 'ENGINE_TOOL_SCOPE_CHANGED');
        if (record.body) assert.deepEqual(body, record.body); else record.body = body;
        return Reflect.apply(end, request, values);
      } as typeof request.end;
      return request;
    } as typeof https.request;
    restoreHook = () => { https.request = protectedRequest; };

    if (cancelStream) {
      await phase('real-stream-client-cancellation');
      const requestId = randomUUID(), controller = new AbortController();
      const response = await client!.call('responses', { model: route.id, input: 'Synthetic stream recovery test. Print the integers 1 through 250, one per line, with no commentary. Do not call tools.',
        stream: true, max_output_tokens: 512, reasoning: { effort: 'none' }, store: false }, { requestId, taskId, signal: controller.signal });
      assert.equal(response.status, 200); assert.ok(response.headers.get('content-type')?.includes('text/event-stream'));
      const reader = response.body!.getReader(), first = await reader.read();
      assert.ok(!first.done && first.value.length > 0, 'STREAM_PREFIX_MISSING');
      const prefix = Buffer.from(first.value).toString('utf8');
      assert.ok(!prefix.includes('response.completed') && !prefix.includes('[DONE]'), 'STREAM_ALREADY_COMPLETED_BEFORE_STOP');
      controller.abort(new Error('SYNTHETIC_USER_STOP'));
      await reader.cancel().catch(() => {});
      Object.assign(report, { clientCanceled: true, clientObservedBytes: first.value.length, clientSawFinalUsage: false, cancellationBeforeCompleted: true,
        uniqueModelRequestIds: requests.size, requestId });
      await phase('query-original-canceled-call');
      const states: string[] = [];
      let status = await client!.callStatus(requestId);
      for (let count = 0; count < 30; count++) {
        states.push(String(status?.status || 'not-found'));
        if (status?.status === 'settled' && status.resultAvailable === true) break;
        await new Promise(resolve => setTimeout(resolve, 1000)); status = await client!.callStatus(requestId);
      }
      report.recoveryStatusObservations = states; await save();
      assert.equal(status?.status, 'settled', 'CANCELED_STREAM_NOT_SETTLED'); assert.equal(status.resultAvailable, true);
      assert.equal(requests.size, 1);
    } else {
    await phase('real-query-engine-tool-loop');
    // Keep local engine types in the local application's compilation; Next.js augments Node's ProcessEnv differently.
    // The helper is checked by root typecheck and loaded from this exact workspace path, with no model/transport substitute.
    const helperUrl = pathToFileURL(path.resolve(cloudRoot, '../src/scripts/helpers/liveEngineToolCheck.ts')).href;
    const { runLiveEngineToolCheck } = await import(helperUrl);
    const engineResult = await runLiveEngineToolCheck({ model: `ccagent:${route.id}`, workspace, taskId, proofName, proof,
      onLocalSettingsApplied: () => assert.equal(requests.size, 0, 'LOCAL_THINK_SETTING_CALLED_PROVIDER') }) as {
        completedReason: string; toolExecutions: string[]; readCalls: number; modelErrorCount: number; failedToolResults: number;
        eventCounts: Record<string, number>; finalAnswerMatchesProof: boolean;
      };
    Object.assign(report, engineResult, { uniqueModelRequestIds: requests.size });
    await save();
    assert.equal(engineResult.completedReason, 'completed'); assert.deepEqual(engineResult.toolExecutions, ['Read']); assert.equal(engineResult.readCalls, 1);
    assert.equal(engineResult.modelErrorCount, 0); assert.equal(engineResult.failedToolResults, 0);
    assert.ok((engineResult.eventCounts.text || 0) > 0); assert.equal(engineResult.finalAnswerMatchesProof, true); assert.equal(requests.size, 2);
    const captured = [...requests.values()];
    const secondInput = captured[1]!.body!.input as { type?: string; call_id?: string }[];
    const toolCalls = secondInput.filter(item => item.type === 'function_call'), toolResults = secondInput.filter(item => item.type === 'function_call_output');
    assert.equal(toolCalls.length, 1); assert.equal(toolResults.length, 1); assert.equal(toolResults[0]!.call_id, toolCalls[0]!.call_id);
    report.functionCallOutputPaired = true;
    }
    await phase('settlement-and-stream-replay');
    let calls = await database().db.select().from(tables.reservations).where(eq(tables.reservations.userId, userId));
    for (let count = 0; count < 30 && (calls.length !== expectedCalls || calls.some(call => call.status !== 'settled')); count++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      calls = await database().db.select().from(tables.reservations).where(eq(tables.reservations.userId, userId));
    }
    assert.equal(calls.length, expectedCalls); const snapshots: Record<string, unknown>[] = [];
    for (const call of calls) {
      assert.equal(call.status, 'settled'); assert.equal(call.routeId, route.id); assert.equal(call.taskId, taskId); assert.ok(call.resultBlobId);
      const usage = call.usage as { attempts?: number; quantities?: unknown; interrupted?: boolean }; assert.equal(usage.attempts, 1);
      const saved = Buffer.from(await client!.download(call.resultBlobId!)).toString('utf8'); assert.ok(saved.includes('response.completed'));
      if (cancelStream) assert.ok(Buffer.byteLength(saved) > Number(report.clientObservedBytes), 'RECOVERED_STREAM_NOT_COMPLETE');
      const beforeReplay = await walletFor(userId), request = requests.get(call.idempotencyKey)!;
      const replay = await client!.call('responses', request.body!, { requestId: request.requestId, taskId });
      assert.equal(replay.headers.get('x-ccagent-replay'), 'true'); assert.equal(await replay.text(), saved);
      assert.deepEqual(await walletFor(userId), beforeReplay);
      snapshots.push({ requestId: call.idempotencyKey, status: call.status, usage: usage.quantities, attempts: usage.attempts, serverMarkedInterruption: usage.interrupted, chargedSyntheticMicro: call.charged.toString(),
        privateStreamBytes: Buffer.byteLength(saved), privateStreamSha256: createHash('sha256').update(saved).digest('hex'), replayed: true });
    }
    const wallet = await walletFor(userId); assert.equal(wallet.frozen, 0n);
    assert.equal(wallet.balance, 1000000n - calls.reduce((total, call) => total + call.charged, 0n));
    assert.equal((await database().db.select().from(tables.reservations).where(eq(tables.reservations.userId, userId))).length, expectedCalls);
    if (cancelStream) {
      const entries = await database().db.select().from(tables.ledger).where(eq(tables.ledger.userId, userId));
      const authorizations = entries.filter(entry => entry.kind === 'authorization'), settlements = entries.filter(entry => entry.kind === 'settlement');
      assert.equal(authorizations.length, 1); assert.equal(settlements.length, 1); assert.ok(calls[0]!.authorized > 0n);
      assert.equal(authorizations[0]!.frozenDelta, calls[0]!.authorized);
      assert.equal(settlements[0]!.frozenDelta, -calls[0]!.authorized); assert.equal(settlements[0]!.balanceDelta, -calls[0]!.charged);
      Object.assign(report, { authorizationEntries: 1, settlementEntries: 1, authorizationAndReleaseBalanced: true });
    }
    assert.equal(await readFile(proofFile, 'utf8'), proof + '\n');
    Object.assign(report, { calls: snapshots, frozenAfter: '0', temporarySourceFileUnchanged: true, status: 'passed' });
  } finally {
    const failures: unknown[] = [];
    restoreHook();
    try { await observeCalls(); } catch (error) { failures.push(error); }
    try { await closeHosted(); } catch (error) { failures.push(error); }
    try { await removeResults(); } catch (error) { failures.push(error); }
    try { if (before && fingerprint) { report.mainRowsUnchanged = JSON.stringify(before) === JSON.stringify(await fingerprint()); assert.equal(report.mainRowsUnchanged, true); } }
    catch (error) { failures.push(error); }
    try { await closeDatabase(); await fixture.cleanup(); }
    finally {
      const audit = postgres(databaseUrl(), databaseOptions(1));
      try { const [row] = await audit<{ count: number }[]>`select count(*)::int as count from pg_namespace where nspname=${fixture.schema}`; report.schemaRemoved = row!.count === 0; assert.equal(report.schemaRemoved, true); }
      finally { await audit.end({ timeout: 5 }); }
      assert.equal(path.dirname(directory), temporary); assert.ok(path.basename(directory).startsWith('ccagent-engine-live-'));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    if (failures.length) throw new Error('LIVE_ENGINE_CLEANUP_OR_ISOLATION_FAILED');
  }
}

try { await save(); await main(); }
catch (error) {
  report.status = 'failed'; report.errorType = error instanceof Error ? error.name : 'UnknownError';
  const failure = error as { code?: unknown; status?: unknown };
  if (typeof failure.code === 'string' && /^[A-Za-z0-9_]+$/.test(failure.code)) report.errorCode = failure.code;
  if (typeof failure.status === 'number') report.httpStatus = failure.status;
  if (!report.errorCode && error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) report.errorCode = error.message;
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString(); await save();
  for (const name of Object.keys(process.env)) if (!(name in originalEnvironment)) delete process.env[name];
  Object.assign(process.env, originalEnvironment);
}
console.log(JSON.stringify({ status: report.status, toolExecutions: report.toolExecutions, uniqueModelRequestIds: report.uniqueModelRequestIds,
  mainRowsUnchanged: report.mainRowsUnchanged, schemaRemoved: report.schemaRemoved, hostedDeploymentRemoved: report.hostedDeploymentRemoved }));
