import { isolatedDatabase } from '../tests/database-fixture';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { watch, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashPassword } from 'better-auth/crypto';

// Actual Next.js + local app + isolated DB: ordinary user A and business admin B.
// No production user, email, key or auth bypass.
const fixture = await isolatedDatabase();
const cloudOrigin = 'http://127.0.0.1:4311', localOrigin = 'http://127.0.0.1:4312';
process.env.AUTH_URL = cloudOrigin;
process.env.AUTH_SECRET = randomBytes(48).toString('base64');
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
const { database, closeDatabase } = await import('../src/core/db');
const tables = await import('../src/core/db/schema');
const output = path.resolve('..', 'output', 'playwright'); await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'ccagent-bridge-browser-'));
const home = path.join(temporary, 'home'), workspace = path.join(temporary, 'workspace');
await mkdir(home); await mkdir(workspace);
const credentials = path.join(output, 'account-bridge-fixture.json'), stopFile = path.join(output, `${fixture.schema}.stop`);
const children: ChildProcess[] = []; let closing = false;
async function cleanup() {
  if (closing) return; closing = true;
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>(resolve => child.once('close', () => resolve()));
      if (child.connected) child.send('ccagent:shutdown'); else child.kill();
      const timeout = setTimeout(() => child.kill(), 6000); await stopped; clearTimeout(timeout);
    }
  }
  await closeDatabase(); await fixture.cleanup();
  await rm(credentials, { force: true }); await rm(stopFile, { force: true });
  if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('ccagent-bridge-browser-')) throw new Error('REFUSE_UNSCOPED_CLEANUP');
  await rm(temporary, { recursive: true, force: true });
}
async function start(args: string[], cwd: string, env: NodeJS.ProcessEnv, origin: string) {
  const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); children.push(child);
  for (let attempt = 0; attempt < 160; attempt++) {
    if (child.exitCode !== null) throw new Error('FIXTURE_SERVER_EXITED');
    try { if ((await fetch(origin + '/api/health')).ok) return; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('FIXTURE_SERVER_TIMEOUT');
}
try {
  const password = randomBytes(32).toString('base64url'), hashed = await hashPassword(password);
  const users = [{ id: randomUUID(), name: '应用账户 A', email: 'bridge-a@ccagent.example.invalid' }, { id: randomUUID(), name: '原云端账户 B', email: 'bridge-b@ccagent.example.invalid' }];
  await database().db.insert(tables.user).values(users.map((user, index) => ({ ...user, emailVerified: true, role: index === 1 ? 'admin' : 'user' })));
  await database().db.insert(tables.userRoles).values({ userId: users[1].id, roleId: 'admin' });
  await database().db.insert(tables.account).values(users.map(user => ({ id: randomUUID(), accountId: user.id, providerId: 'credential', userId: user.id, password: hashed })));
  const cloudEnv: NodeJS.ProcessEnv = { ...process.env, RESEND_API_KEY: '', ZPAY_KEY: '', ZPAY_PID: '', PAYMENT_ENABLED: 'false' };
  await start([path.resolve('node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '4311'], process.cwd(), cloudEnv, cloudOrigin);
  const localEnv: NodeJS.ProcessEnv = { ...process.env, CCAGENT_HOME: home, CCAGENT_PLATFORM_HOME: home, CCAGENT_CLOUD_URL: cloudOrigin, CCAGENT_DISABLE_STREAM_LOG: '1' };
  delete localEnv.CCAGENT_DESKTOP_TOKEN; delete localEnv.CCAGENT_ACCOUNT_ID; delete localEnv.CCAGENT_AUTH_SESSION_FILE;
  await start([path.resolve('../dist/ccagent.js'), 'web', '--workspace', workspace, '--port', '4312'], workspace, localEnv, localOrigin);
  await writeFile(credentials, JSON.stringify({ cloudOrigin, localOrigin, password, users }), { mode: 0o600 });
  console.log(JSON.stringify({ ready: true, isolatedSchema: fixture.schema, cloudOrigin, localOrigin, credentials: path.relative(path.resolve('..'), credentials), stopFile: path.relative(path.resolve('..'), stopFile) }));
  const watcher = watch(output, (_event, name) => { if (name?.toString() === path.basename(stopFile) && existsSync(stopFile)) { watcher.close(); void cleanup().then(() => process.exit(0)); } });
  process.stdin.setEncoding('utf8'); process.stdin.on('data', data => { if (String(data).trim() === 'stop') void cleanup().then(() => process.exit(0)); }); process.stdin.resume();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void cleanup().then(() => process.exit(0)); });
  setTimeout(() => { void cleanup().then(() => process.exit(0)); }, 15 * 60 * 1000);
} catch {
  console.error('ACCOUNT_BRIDGE_BROWSER_FIXTURE_FAILED'); await cleanup(); process.exitCode = 1;
}
