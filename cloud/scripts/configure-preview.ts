import './load-env';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const project = 'prj_2VwqV4ZbAkSX4WKJKDImBzWsNNYF', scope = 'lvye-1989s-projects';
if (!process.argv.includes('--run')) { console.log('Use --run to configure this CCAGENT preview with the development runtime database and server-only Secrets.'); process.exit(0); }
const runtime = new URL(process.env.DATABASE_URL || '');
if (!decodeURIComponent(runtime.username).startsWith('ccagent_runtime')) throw new Error('PREVIEW_REQUIRES_RUNTIME_DATABASE_ROLE');
function cli(args: string[], input?: string) {
  // Every command argument is a fixed identifier/flag, never a secret or user-provided shell text.
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', ['npx.cmd', '--offline', '--yes', 'vercel@65.12.1', ...args, '--project', project, '--scope', scope].join(' ')],
    { input, encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_USE_SYSTEM_CA: '1', NODE_USE_ENV_PROXY: '1' }, timeout: 60000 });
  if (result.status !== 0) throw new Error('VERCEL_ENV_CONFIGURATION_FAILED');
  return result.stdout;
}
const listed = JSON.parse(cli(['env', 'ls', '--environment', 'preview', '--json'])) as { envs?: { key: string }[]; environmentVariables?: { key: string }[] };
const entries = listed.envs ?? listed.environmentVariables;
if (!Array.isArray(entries)) { console.log(JSON.stringify({ metadataFields: Object.keys(listed) })); throw new Error('ENV_METADATA_SHAPE_REVIEW_REQUIRED'); }
const existing = new Set(entries.map(entry => entry.key));
const secrets = { DATABASE_URL: process.env.DATABASE_URL, AUTH_SECRET: randomBytes(48).toString('base64url'), RESEND_API_KEY: process.env.RESEND_API_KEY,
  BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN, CRON_SECRET: randomBytes(36).toString('base64url') };
for (const [name, value] of Object.entries(secrets)) {
  if (existing.has(name)) { console.log(JSON.stringify({ name, retained: true })); continue; }
  if (!value) throw new Error(`${name}_NOT_CONFIGURED`);
  cli(['env', 'add', name, 'preview', '--type', 'secret'], value);
  console.log(JSON.stringify({ name, environment: 'preview', saved: true, type: 'secret' }));
}
for (const [name, value] of Object.entries({ DB_SCHEMA: 'ccagent', DB_MAX_CONNECTIONS: '1', PAYMENT_ENABLED: 'false' })) {
  if (existing.has(name)) continue;
  cli(['env', 'add', name, 'preview', '--type', 'config'], value);
  console.log(JSON.stringify({ name, environment: 'preview', saved: true, type: 'config' }));
}
