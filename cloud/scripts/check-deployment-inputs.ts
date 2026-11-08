import './load-env';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { requiredDatabaseContract } from '../src/core/db/migration-contract';
import { assertMigrationContract } from './lib/migration-contract';

assertMigrationContract(requiredDatabaseContract);
const root = path.resolve('..');
const environment = process.argv.includes('--production') ? 'production' : 'preview';
const cliEnvironment: NodeJS.ProcessEnv = { ...process.env, NODE_USE_SYSTEM_CA: '1', NODE_USE_ENV_PROXY: '1' };
delete cliEnvironment.NODE_TLS_REJECT_UNAUTHORIZED;
const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npx.cmd --offline --yes vercel@65.12.1 deploy --project prj_2VwqV4ZbAkSX4WKJKDImBzWsNNYF --scope lvye-1989s-projects --dry --json' + (environment === 'production' ? ' --prod' : '')],
  { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000, env: cliEnvironment });
if (result.status !== 0) throw new Error('DEPLOYMENT_DRY_RUN_FAILED');
const plan = JSON.parse(result.stdout) as { files: { path: string; size: number; mode: number; sha?: string }[]; fileCount: number };
const credentials = Object.entries(process.env)
  .filter(([name, value]) => value && value.length >= 16 && /SECRET|PASSWORD|TOKEN|API_KEY|_KEY$|DATABASE.*URL|POSTGRES.*URL|CCAGENT_PROVIDER_/i.test(name))
  .map(([, value]) => value!);
for (const name of ['DATABASE_URL', 'DATABASE_MIGRATION_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING']) {
  const value = process.env[name];
  if (!value) continue;
  const database = new URL(value);
  if (database.password) credentials.push(database.password, decodeURIComponent(database.password));
}
const manifest: { path: string; sha256: string; bytes: number }[] = [];
let bytes = 0, files = 0;
for (const file of plan.files) {
  if (!file.sha) continue; // Empty directories have no contents to upload.
  const relative = file.path.replaceAll('\\', '/');
  const allowed = /^cloud\/(?:src\/.+\.(?:ts|tsx|css|svg)|(?:package(?:-lock)?|tsconfig|vercel)\.json|(?:next\.config|next-env\.d|drizzle\.config)\.ts|\.gitignore)$/.test(relative) || /^src\/platform\/(?:money|zpay|pricingDefinition)\.ts$/.test(relative);
  const absolute = path.resolve(root, relative);
  if (!allowed || !absolute.startsWith(root + path.sep) || /(?:^|\/)(?:\.env[^/]*|\.ccagent|node_modules|\.vercel|\.next)(?:\/|$)/.test(relative)) throw new Error('UNEXPECTED_DEPLOYMENT_FILE');
  const contents = await readFile(absolute);
  const body = contents.toString('utf8');
  if (credentials.some(value => body.includes(value))) throw new Error('DEPLOYMENT_CONTAINS_LOCAL_CREDENTIAL');
  if (contents.length !== file.size) throw new Error('DEPLOYMENT_SOURCE_CHANGED_DURING_REVIEW');
  manifest.push({ path: relative, sha256: createHash('sha256').update(contents).digest('hex'), bytes: contents.length });
  bytes += file.size; files++;
}
manifest.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const sharedModules = ['money.ts', 'zpay.ts', 'pricingDefinition.ts'];
if (sharedModules.some(name => !manifest.some(file => file.path === 'src/platform/' + name))) throw new Error('REQUIRED_SHARED_MODULE_MISSING');
const sourceSha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
console.log(JSON.stringify({ checked: true, target: 'ccagent-cloud', environment, reviewedSourceFiles: files, bytes, sourceSha256,
  sharedModules, credentialsExcluded: true, localDataExcluded: true, generatedFilesExcluded: true }));
