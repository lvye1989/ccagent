import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const mode = process.argv[2] || 'offline';
if (!['offline', 'database'].includes(mode)) throw new Error('Choose offline or database');
// Storage-backed end-to-end tests remain an explicit operator suite. No CI
// credentials or supplier accounts are needed by either group below.
const databaseTests = new Set(['account-bridge', 'admin-filters', 'admin-key-management', 'admin-route-management', 'admin-wallet-adjustment', 'catalog', 'configuration',
  'database-binding', 'database-health', 'operations-overview', 'payment-lock-busy', 'payments', 'platform', 'provider-credentials', 'releases',
  'runtime-bootstrap', 'runtime-pool', 'service-defaults', 'wallet-account-lock', 'wallet-concurrency']);
for (const name of ['deepseek-tool-replay', 'gateway-admin-configuration', 'gateway-price-fingerprint', 'images-gateway', 'maintenance', 'route-tests']) databaseTests.add(name);
const externalTests = new Set(['call-identifiers', 'database-tls', 'files', 'gateway-fallback', 'gateway', 'native-fallback', 'qwen-pricing-gateway']);
const files = [];
for (const file of (await readdir('tests')).filter(file => /\.test\.tsx?$/.test(file)).sort()) {
  const source = await readFile('tests/' + file, 'utf8');
  const name = file.replace(/\.test\.tsx?$/, '');
  if (/database-fixture|scripts\/load-env|@vercel\/blob/.test(source) && !databaseTests.has(name) && !externalTests.has(name)) throw new Error(`Classify integration test before CI can proceed: ${file}`);
  if (mode === 'database' ? databaseTests.has(file.replace(/\.test\.tsx?$/, '')) : !/database-fixture|scripts\/load-env|@vercel\/blob/.test(source)) files.push('tests/' + file);
}
if (!files.length) throw new Error('No tests selected');
if (mode === 'database') {
  if (process.env.CI !== 'true') throw new Error('Database CI suite requires an isolated CI instance');
  for (const name of ['DATABASE_URL', 'DATABASE_MIGRATION_URL']) {
    const url = new URL(process.env[name]);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/ccagent_ci') throw new Error('Database CI suite refuses nonlocal or nonfixture databases');
  }
}
console.log(`CI ${mode}: ${files.length} test files; live storage/supplier tests excluded explicitly.`);
const child = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...files], { stdio: 'inherit', env: { ...process.env, RESEND_API_KEY: '', ZPAY_KEY: '', ZPAY_PID: '', BLOB_READ_WRITE_TOKEN: '', BLOB_STORE_ID: '' } });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
