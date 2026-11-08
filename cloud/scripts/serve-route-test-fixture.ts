import { isolatedDatabase } from '../tests/database-fixture';
import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { mkdtemp, writeFile, readFile, rm, realpath, mkdir } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import net from 'node:net';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'drizzle-orm';

const temporary = await realpath(os.tmpdir()), directory = await mkdtemp(path.join(temporary, 'ccagent-route-test-ui-'));
const certificate = path.join(directory, 'certificate.pem'), privateKey = path.join(directory, 'private-key.pem'), modeFile = path.join(directory, 'provider-mode'), metricsFile = path.join(directory, 'provider-counts.json'), stopFile = path.join(directory, 'stop-fixture');
const secret = 'local-TLS-provider-only-' + randomBytes(24).toString('hex'), password = randomBytes(32).toString('base64url');
let fixture: Awaited<ReturnType<typeof isolatedDatabase>> | undefined, child: ChildProcess | undefined, listening = false, closing = false;
let closeDatabase: (() => Promise<void>) | undefined;
const metrics = { postRequests: 0, correctAuthorization: true, fixedModelAndBudget: true };
const server = https.createServer();
async function stop() {
  if (closing) return; closing = true;
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise<void>(resolve => child!.once('exit', () => resolve())); child.kill();
    await Promise.race([ended, delay(15000).then(() => { throw new Error('OWNED_NEXT_PROCESS_DID_NOT_STOP'); })]);
  }
  if (listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  if (fixture && closeDatabase) {
    const { database } = await import('../src/core/db'), tables = await import('../src/core/db/schema');
    const [state] = await database().db.execute(sql`select (select count(*)::int from ${tables.ledger}) as ledger,
      (select count(*)::int from ${tables.reservations}) as reservations,(select count(*)::int from ${tables.orders}) as orders,
      (select count(*)::int from ${tables.blobs}) as private_files,(select coalesce(sum(balance),0)::text from ${tables.wallets}) as wallet_balance,
      (select coalesce(sum(frozen),0)::text from ${tables.wallets}) as wallet_frozen,
      (select count(*)::int from ${tables.audit} where action='routes.test.start') as starts,
      (select count(*)::int from ${tables.audit} where action='routes.test.result') as results`);
    await writeFile(path.resolve('../output/checks/route-test-ui-database-' + fixture.schema + '.json'), JSON.stringify({ schema: fixture.schema, metrics, state }, null, 2));
    await closeDatabase(); await fixture.cleanup();
  }
  if (path.dirname(directory) !== temporary || !path.basename(directory).startsWith('ccagent-route-test-ui-')) throw new Error('UNSAFE_ROUTE_TEST_FIXTURE_CLEANUP');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log(JSON.stringify({ cleaned: true, schema: fixture?.schema, localTLSAndNextStopped: true, privateCredentialsRemoved: true }));
}
try {
  const configuration = path.join(directory, 'openssl.cnf');
  await writeFile(configuration, '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=127.0.0.1\n[v3]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n');
  execFileSync('C:\\Program Files\\Git\\usr\\bin\\openssl.exe', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-config', configuration, '-keyout', privateKey, '-out', certificate], { windowsHide: true, stdio: 'ignore' });
  server.setSecureContext({ key: await readFile(privateKey), cert: await readFile(certificate) });
  await writeFile(modeFile, 'success'); await writeFile(metricsFile, JSON.stringify(metrics));
  server.on('request', async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    let raw = ''; for await (const part of request) { raw += part; if (raw.length > 65536) { request.destroy(); return; } }
    let body: Record<string, unknown>; try { body = JSON.parse(raw); } catch { response.writeHead(400); response.end(); return; }
    metrics.postRequests++; metrics.correctAuthorization &&= request.headers.authorization === 'Bearer ' + secret;
    metrics.fixedModelAndBudget &&= body.model === 'fixture-chat' && body.max_tokens === 64 && body.stream === false;
    await writeFile(metricsFile, JSON.stringify(metrics)); const mode = (await readFile(modeFile, 'utf8')).trim();
    const send = () => {
      if (response.destroyed) return;
      response.writeHead(mode === 'denied' ? 403 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(mode === 'denied' ? { error: { code: secret, message: secret } } : { choices: [{ message: { role: 'assistant', content: 'OK' } }], ...(mode === 'missing' ? {} : { usage: { prompt_tokens: 8, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } } }) }));
    };
    if (mode === 'slow') setTimeout(send, 2500).unref(); else send();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(443, '127.0.0.1', () => { listening = true; server.off('error', reject); resolve(); }); });
  fixture = await isolatedDatabase();
  const { database, closeDatabase: close } = await import('../src/core/db'), tables = await import('../src/core/db/schema'); closeDatabase = close;
  const users = [{ id: randomUUID(), name: '连接检测管理员', email: 'probe-ui-admin@example.invalid' }, { id: randomUUID(), name: '连接检测普通用户', email: 'probe-ui-user@example.invalid' }];
  const hashed = await hashPassword(password);
  await database().db.insert(tables.user).values(users.map(user => ({ ...user, emailVerified: true })));
  await database().db.insert(tables.account).values(users.map(user => ({ id: randomUUID(), accountId: user.id, providerId: 'credential', userId: user.id, password: hashed })));
  await database().db.insert(tables.userRoles).values({ userId: users[0]!.id, roleId: 'admin' });
  const port = await new Promise<number>((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const address = probe.address(); probe.close(() => address && typeof address !== 'string' ? resolve(address.port) : reject(new Error('NO_PORT'))); }); });
  const origin = `http://127.0.0.1:${port}`, credentialEnv = 'CCAGENT_PROVIDER_CONNECTIVITY_FIXTURE';
  process.env.CCAGENT_ALLOWED_UPSTREAM_HOSTS = '127.0.0.1'; process.env[credentialEnv] = secret;
  const { routeInput, saveRoute, priceDefinition, createPriceVersion } = await import('../src/core/catalog');
  await saveRoute(users[0]!.id, routeInput.parse({ id: 'probe-ui-chat', name: '本机 TLS 连接检测', service: 'chat', protocol: 'openai-chat', provider: 'deepseek', baseUrl: 'https://127.0.0.1/v1', upstreamModel: 'fixture-chat', credentialEnv, enabled: false, retries: 2, timeoutMs: 1000, options: { contextWindow: 4096, maxOutputTokens: 128, maxImages: 2 } }));
  await createPriceVersion(users[0]!.id, { routeId: 'probe-ui-chat', currency: 'CNY', sourceUrl: 'https://example.invalid/synthetic-prices', effectiveAt: new Date(Date.now() - 1000).toISOString(), definition: priceDefinition.parse({ rates: [{ metric: 'input_tokens', price: '1', unitQuantity: '1000000' }, { metric: 'cached_input_tokens', price: '0', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '1', unitQuantity: '1000000' }], tariff: { kind: 'constant' } }) });
  const env = { ...process.env, AUTH_URL: origin, AUTH_SECRET: randomBytes(48).toString('base64url'), VERCEL: '', VERCEL_URL: '', NODE_EXTRA_CA_CERTS: certificate, NODE_USE_SYSTEM_CA: '1', NODE_USE_ENV_PROXY: '1', NO_PROXY: `${process.env.NO_PROXY || ''},127.0.0.1,localhost`, RESEND_API_KEY: '', ZPAY_KEY: '', ZPAY_PID: '', PAYMENT_ENABLED: 'false' };
  (env as NodeJS.ProcessEnv).NODE_TLS_REJECT_UNAUTHORIZED = '1';
  child = spawn(process.execPath, [path.resolve('node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.resume(); child.stderr?.resume();
  const deadline = Date.now() + 60000; let ready = false;
  while (Date.now() < deadline) { if (child.exitCode !== null) throw new Error('NEXT_FIXTURE_EXITED'); try { ready = (await fetch(origin + '/login')).ok; if (ready) break; } catch {} await delay(200); }
  if (!ready) throw new Error('NEXT_FIXTURE_NOT_READY');
  console.log(JSON.stringify({ ready: true, fixtureOnly: true, schema: fixture.schema, origin, users, password, secret, modeFile, metricsFile, stopFile, temporaryDirectory: directory, nodeExtraCaOnly: true }));
  const stopAndExit = () => { void stop().then(() => process.exit(0), () => { console.error('ROUTE_TEST_UI_FIXTURE_CLEANUP_FAILED'); process.exit(1); }); };
  const watcher = watch(directory, (_event, name) => { if (name?.toString() === 'stop-fixture' && existsSync(stopFile)) { watcher.close(); stopAndExit(); } });
  process.on('SIGINT', stopAndExit); process.on('SIGTERM', stopAndExit); setTimeout(stopAndExit, 20 * 60_000).unref();
} catch (error) {
  console.error(JSON.stringify({ fixtureFailed: true, code: error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : error instanceof Error ? error.name : 'unknown' }));
  await stop(); process.exitCode = 1;
}
