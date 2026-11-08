import './load-env';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { databaseOptions } from '../src/core/db/options';
import { databaseUrl, databaseSchema } from '../src/core/env';

// This initial cutover uses the application's existing private schema without migrations or data rewrites.
async function main() {
const project = 'prj_2VwqV4ZbAkSX4WKJKDImBzWsNNYF', scope = 'lvye-1989s-projects';
const origin = 'https://ccagent-cloud.vercel.app';
const execute = process.argv.includes('--run');
if (databaseSchema() !== 'ccagent') throw new Error('REFUSE_TEST_DATABASE_FOR_PRODUCTION');
const runtimeUrl = databaseUrl();
if (decodeURIComponent(new URL(runtimeUrl).username).split('.')[0] !== 'ccagent_runtime') throw new Error('RESTRICTED_RUNTIME_DATABASE_REQUIRED');
for (const key of ['RESEND_API_KEY', 'BLOB_READ_WRITE_TOKEN']) if (!process.env[key]) throw new Error(`${key}_NOT_CONFIGURED`);
const db = postgres(runtimeUrl, databaseOptions(1));
try {
  const [identity] = await db`select current_user as role,
    has_table_privilege(current_user, 'ccagent.wallets', 'UPDATE') as wallet_write,
    has_table_privilege(current_user, 'ccagent.ledger', 'DELETE') as ledger_delete`;
  assert.equal(identity.role, 'ccagent_runtime'); assert.equal(identity.wallet_write, false); assert.equal(identity.ledger_delete, false);
  const [state] = await db`select (select count(*)::integer from ccagent.orders) as orders,
    (select count(*)::integer from ccagent.wallets where frozen <> 0) as frozen_wallets`;
  // Any real financial state requires a separately reviewed operational cutover.
  assert.equal(state.orders, 0); assert.equal(state.frozen_wallets, 0);
} finally { await db.end({ timeout: 5 }); }

function cli(args: string[], input?: string): string {
  const command = ['npx.cmd', '--offline', '--yes', 'vercel@65.12.1', ...args, '--project', project, '--scope', scope].join(' ');
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
    input, encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: { ...process.env, NODE_USE_SYSTEM_CA: '1', NODE_USE_ENV_PROXY: '1', NODE_TLS_REJECT_UNAUTHORIZED: undefined },
  });
  if (result.status !== 0) throw new Error('VERCEL_PRODUCTION_CONFIGURATION_FAILED');
  return result.stdout;
}
const metadata = JSON.parse(cli(['env', 'ls', '--environment', 'production', '--json'])) as { envs?: { key: string }[]; environmentVariables?: { key: string }[] };
const entries = metadata.envs ?? metadata.environmentVariables;
if (!Array.isArray(entries)) throw new Error('ENVIRONMENT_METADATA_REVIEW_REQUIRED');
const existing = new Set(entries.map(entry => entry.key));
const secrets = { DATABASE_URL: runtimeUrl, AUTH_SECRET: randomBytes(48).toString('base64url'), RESEND_API_KEY: process.env.RESEND_API_KEY!,
  BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN!, CRON_SECRET: randomBytes(36).toString('base64url') };
const config = { AUTH_URL: origin, AUTH_EMAIL_FROM: process.env.AUTH_EMAIL_FROM || 'CCAGENT <account@notify.cjai.pro>', DB_SCHEMA: 'ccagent', DB_MAX_CONNECTIONS: '1', PAYMENT_ENABLED: 'false' };
for (const [type, values] of [['secret', secrets], ['config', config]] as const) {
  for (const [key, value] of Object.entries(values)) {
    if (existing.has(key)) { console.log(JSON.stringify({ key, retained: true, environment: 'production' })); continue; }
    if (execute) cli(['env', 'add', key, 'production', '--type', type], value);
    console.log(JSON.stringify({ key, type, environment: 'production', saved: execute, planned: !execute }));
  }
}
console.log(JSON.stringify({ configured: execute, origin, restrictedRuntime: true, existingApplicationDatabase: true,
  databaseWrites: false, productionAuthSecret: existing.has('AUTH_SECRET') ? 'retained-unverified' : execute ? 'created-independently' : 'planned-independent',
  payments: existing.has('PAYMENT_ENABLED') ? 'retained-unverified' : execute ? 'disabled' : 'planned-disabled', mailSent: false }));
}
main().catch(() => { console.error(JSON.stringify({ configured: false, code: 'PRODUCTION_CONFIGURATION_FAILED' })); process.exitCode = 1; });
