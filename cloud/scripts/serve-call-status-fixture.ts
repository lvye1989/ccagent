import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { watch, existsSync, type FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { hashPassword } from 'better-auth/crypto';
import { isolatedDatabase } from '../tests/database-fixture';

// Synthetic display history only. No provider dispatch, real user data, mail or payment.
const fixture = await isolatedDatabase();
const temporary = await realpath(os.tmpdir()), directory = await mkdtemp(path.join(temporary, 'ccagent-call-status-ui-'));
let child: ChildProcess | undefined, stopWatcher: FSWatcher | undefined, closing = false, closeDatabase = async () => {};
let compare = async () => {};
const stateFile = path.join(directory, 'browser-fixture.json');
const stopFile = path.join(directory, 'stop-fixture');
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), status: 'running', schema: fixture.schema,
  syntheticDisplayHistoryOnly: true, realProviderCalls: false, realPayments: false, realMailSent: false };
const reportPath = path.resolve('../output/checks/call-status-ui-fixture-' + fixture.schema + '.json');
async function stop() {
  if (closing) return; closing = true;
  stopWatcher?.close();
  try {
    if (child && child.exitCode === null && child.signalCode === null) {
      const ended = new Promise<void>(resolve => child!.once('exit', () => resolve())); child.kill();
      await Promise.race([ended, delay(15000).then(() => { throw new Error('OWNED_NEXT_DID_NOT_STOP'); })]);
    }
    await compare();
  } catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message : 'FIXTURE_CHECK_FAILED'; }
  finally {
    try { await closeDatabase(); await fixture.cleanup(); report.schemaRemoved = true; }
    catch { report.status = 'failed'; report.cleanupFailed = true; }
    assert.equal(path.dirname(directory), temporary); assert.ok(path.basename(directory).startsWith('ccagent-call-status-ui-'));
    await rm(directory, { recursive: true, force: true });
    report.privateCredentialsRemoved = true; report.finishedAt = new Date().toISOString();
    if (report.status === 'running') report.status = 'passed';
    await mkdir(path.dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ terminal: true, status: report.status, reportPath }));
  }
}
try {
  const { database, closeDatabase: close } = await import('../src/core/db'); closeDatabase = close;
  const tables = await import('../src/core/db/schema');
  const checked = [tables.user, tables.session, tables.account, tables.userRoles, tables.wallets, tables.ledger, tables.apiKeys,
    tables.routes, tables.prices, tables.orders, tables.reservations, tables.audit, tables.blobs];
  for (const table of checked) assert.equal(getTableConfig(table).schema, fixture.schema);
  assert.equal(tables.namespace.schemaName, fixture.schema);
  const [role] = await database().client`select current_user as role`; assert.equal(role!.role, 'ccagent_runtime');
  report.runtimeRole = role!.role; report.mainTablesChecked = checked.length;
  async function fingerprints(schema: string, selected = checked) {
    assert.ok(schema === 'ccagent' || schema === fixture.schema);
    const output: Record<string, string> = {};
    for (const table of selected) {
      const name = getTableConfig(table).name;
      const [row] = await fixture.owner.unsafe(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as digest from "${schema}"."${name}" t`);
      output[name] = row!.digest;
    }
    return output;
  }
  const before = await fingerprints('ccagent');
  compare = async () => { assert.deepEqual(await fingerprints('ccagent'), before); report.mainRowsUnchanged = true; };
  const password = randomBytes(30).toString('base64url'), hashed = await hashPassword(password);
  const users = [0, 1].map(index => ({ id: randomUUID(), name: `调用恢复用户 ${index + 1}`, email: `recovery-${index}@example.invalid` }));
  await database().db.insert(tables.user).values(users.map(user => ({ ...user, emailVerified: true })));
  await database().db.insert(tables.account).values(users.map(user => ({ id: randomUUID(), accountId: user.id, providerId: 'credential', userId: user.id, password: hashed })));
  const keyIds = users.map(() => randomUUID());
  await database().db.insert(tables.apiKeys).values(users.map((user, index) => ({ id: keyIds[index]!, userId: user.id, name: '已撤销显示夹具 Key', prefix: 'display-fixture', hash: randomUUID(), revokedAt: new Date() })));
  await database().db.insert(tables.routes).values({ id: 'recovery-display', name: '历史显示夹具', service: 'chat', protocol: 'openai-responses', provider: 'fixture',
    baseUrl: 'https://example.invalid', upstreamModel: 'display-only', credentialEnv: 'CCAGENT_PROVIDER_NO_REAL_KEY', enabled: false });
  const records = [
    { user: 0, id: '_held', status: 'held', charged: 0n }, { user: 0, id: '.', status: 'pending', charged: 0n },
    { user: 0, id: '..', status: 'settled', charged: 900n }, { user: 0, id: '-released', status: 'released', charged: 0n },
    { user: 1, id: ':other', status: 'settled', charged: 700n },
  ];
  await database().db.insert(tables.reservations).values(records.map(record => ({ id: randomUUID(), userId: users[record.user]!.id, keyId: keyIds[record.user]!,
    routeId: 'recovery-display', taskId: 'task-recovery', idempotencyKey: record.id, requestHash: 'f'.repeat(64), status: record.status,
    authorized: 10000n, charged: record.charged, priceSnapshot: {}, reconcileAt: new Date(Date.now() + 86400000) })));
  const financial = [tables.wallets, tables.ledger, tables.apiKeys, tables.prices, tables.orders, tables.reservations, tables.blobs];
  const originalHistory = await fingerprints(fixture.schema, financial);
  compare = async () => {
    assert.deepEqual(await fingerprints(fixture.schema, financial), originalHistory); report.readOnlyHistoryUnchanged = true;
    assert.deepEqual(await fingerprints('ccagent'), before); report.mainRowsUnchanged = true;
  };
  const port = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => {
      const address = probe.address(); probe.close(() => address && typeof address !== 'string' ? resolve(address.port) : reject(new Error('NO_PORT')));
    });
  });
  const origin = `http://127.0.0.1:${port}`, env = { ...process.env };
  for (const name of Object.keys(env)) if (/CCAGENT_PROVIDER_|RESEND_|ZPAY_|BLOB_|VERCEL|CRON_SECRET/.test(name)) delete env[name];
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  Object.assign(env, { AUTH_URL: origin, AUTH_SECRET: randomBytes(48).toString('base64url'), PAYMENT_ENABLED: 'false',
    RESEND_API_KEY: '', ZPAY_PID: '', ZPAY_KEY: '', BLOB_READ_WRITE_TOKEN: '', CRON_SECRET: '', VERCEL: '', VERCEL_URL: '', NODE_USE_SYSTEM_CA: '1', NODE_USE_ENV_PROXY: '1' });
  child = spawn(process.execPath, [path.resolve('node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout?.resume(); child.stderr?.resume();
  let ready = false; const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { if (child.exitCode !== null) throw new Error('NEXT_EXITED'); try { ready = (await fetch(origin + '/login')).ok; if (ready) break; } catch {} await delay(200); }
  assert.ok(ready, 'NEXT_NOT_READY');
  await writeFile(stateFile, JSON.stringify({ origin, users, password, schema: fixture.schema }), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ ready: true, origin, stateFile, stopFile, reportPath, schema: fixture.schema }));
  const stopAndExit = () => { void stop().then(() => process.exit(report.status === 'passed' ? 0 : 1)); };
  stopWatcher = watch(directory, (_event, name) => { if (name?.toString() === 'stop-fixture' && existsSync(stopFile)) stopAndExit(); });
  process.stdin.setEncoding('utf8'); process.stdin.on('data', data => { if (String(data).trim() === 'stop') stopAndExit(); }); process.stdin.resume();
  process.on('SIGINT', stopAndExit); process.on('SIGTERM', stopAndExit); setTimeout(stopAndExit, 20 * 60_000).unref();
} catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message : 'FIXTURE_FAILED'; await stop(); process.exitCode = 1; }
