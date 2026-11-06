import { isolatedDatabase } from '../tests/database-fixture';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { watch, existsSync } from 'node:fs';
import path from 'node:path';
import { hashPassword } from 'better-auth/crypto';

// Disposable real Supabase schema and real Next.js server. Never an auth bypass in the app.
const fixture = await isolatedDatabase();
process.env.AUTH_URL = 'http://127.0.0.1:4311';
process.env.AUTH_SECRET = randomBytes(48).toString('base64');
// Only validates route configuration UI. This synthetic key must never be used for inference.
process.env.CCAGENT_PROVIDER_UI_FIXTURE = randomBytes(32).toString('base64url');
const { database, closeDatabase } = await import('../src/core/db');
const tables = await import('../src/core/db/schema');
const output = path.resolve('..', 'output', 'playwright');
await mkdir(output, { recursive: true });
const stateFiles: string[] = [];
const stopFile = path.join(output, `${fixture.schema}.stop`);
let server: ReturnType<typeof spawn> | undefined, closing = false;
async function cleanup() {
  if (closing) return;
  closing = true;
  if (server && server.exitCode === null) { server.kill(); await new Promise<void>(resolve => { server!.once('close', () => resolve()); setTimeout(resolve, 5000); }); }
  await closeDatabase();
  await fixture.cleanup();
  for (const file of stateFiles) { if (path.dirname(file) !== output || !/^cloud-fixture-(user|admin)\.json$/.test(path.basename(file))) throw new Error('REFUSE_UNSCOPED_CREDENTIAL_CLEANUP'); await rm(file, { force: true }); }
  await rm(stopFile, { force: true });
}
try {
  const password = randomBytes(32).toString('base64url'), hashed = await hashPassword(password);
  const users = [{ id: randomUUID(), name: '页面验收用户', email: 'ui-user@ccagent.example.invalid' }, { id: randomUUID(), name: '页面验收管理员', email: 'ui-admin@ccagent.example.invalid' }];
  await database().db.insert(tables.user).values(users.map(user => ({ ...user, emailVerified: true })));
  await database().db.insert(tables.account).values(users.map(user => ({ id: randomUUID(), accountId: user.id, providerId: 'credential', userId: user.id, password: hashed })));
  await database().db.insert(tables.userRoles).values({ userId: users[1].id, roleId: 'admin' });
  server = spawn(process.execPath, [path.resolve('node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '4311'], {
    cwd: process.cwd(), env: { ...process.env, RESEND_API_KEY: '', ZPAY_KEY: '', ZPAY_PID: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  server.stdout?.on('data', chunk => process.stdout.write(chunk));
  server.stderr?.on('data', chunk => process.stderr.write(chunk));
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error('FIXTURE_SERVER_EXITED');
    try { if ((await fetch(`${process.env.AUTH_URL}/api/health`)).ok) break; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  for (const [index, target] of users.entries()) {
    const response = await fetch(`${process.env.AUTH_URL}/api/auth/sign-in/email`, { method: 'POST', headers: { origin: process.env.AUTH_URL, 'content-type': 'application/json' }, body: JSON.stringify({ email: target.email, password }) });
    if (!response.ok) throw new Error('FIXTURE_LOGIN_FAILED');
    const signed = response.headers.getSetCookie().find(item => item.startsWith('ccagent.session_token='))?.split(';')[0];
    if (!signed) throw new Error('FIXTURE_COOKIE_MISSING');
    const file = path.join(output, `cloud-fixture-${index ? 'admin' : 'user'}.json`);
    await writeFile(file, JSON.stringify({ cookies: [{ name: 'ccagent.session_token', value: signed.slice(signed.indexOf('=') + 1), domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax', expires: -1 }], origins: [] }), { mode: 0o600 });
    stateFiles.push(file);
  }
  console.log(JSON.stringify({ ready: true, origin: process.env.AUTH_URL, isolatedSchema: fixture.schema, storageFiles: stateFiles.map(file => path.relative(path.resolve('..'), file)), stopFile: path.relative(path.resolve('..'), stopFile), stop: 'Create stopFile or send stop on stdin; automatic cleanup after 15 minutes.' }));
  const watcher = watch(output, (_event, name) => { if (name?.toString() === path.basename(stopFile) && existsSync(stopFile)) { watcher.close(); void cleanup().then(() => process.exit(0)); } });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', data => { if (String(data).trim() === 'stop') void cleanup().then(() => process.exit(0)); });
  process.stdin.resume();
  process.on('SIGINT', () => { void cleanup().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { void cleanup().then(() => process.exit(0)); });
  setTimeout(() => { void cleanup().then(() => process.exit(0)); }, 900000);
} catch {
  console.error('BROWSER_FIXTURE_FAILED');
  await cleanup();
  process.exitCode = 1;
}
