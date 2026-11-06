import './load-env';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('..');
const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npx.cmd --offline --yes vercel@65.12.1 deploy --project prj_2VwqV4ZbAkSX4WKJKDImBzWsNNYF --scope lvye-1989s-projects --dry --json'],
  { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, NODE_USE_SYSTEM_CA: '1', NODE_USE_ENV_PROXY: '1' } });
if (result.status !== 0) throw new Error('DEPLOYMENT_DRY_RUN_FAILED');
const plan = JSON.parse(result.stdout) as { files: { path: string; size: number; mode: number; sha?: string }[]; fileCount: number };
const credentials = Object.entries(process.env).filter(([name, value]) => value && value.length >= 16 && /DATABASE_URL|AUTH_SECRET|RESEND_API_KEY|BLOB_READ_WRITE_TOKEN|POSTGRES_URL|SUPABASE_SERVICE_ROLE_KEY|VERCEL_OIDC_TOKEN/.test(name)).map(([, value]) => value!);
const runtime = new URL(process.env.DATABASE_URL || '');
if (runtime.password) credentials.push(decodeURIComponent(runtime.password));
let bytes = 0, files = 0;
for (const file of plan.files) {
  if (!file.sha) continue; // Empty directories have no contents to upload.
  const relative = file.path.replaceAll('\\', '/');
  const allowed = /^cloud\/(?:src\/.+\.(?:ts|tsx|css|svg)|(?:package(?:-lock)?|tsconfig|vercel)\.json|(?:next\.config|next-env\.d|drizzle\.config)\.ts|\.gitignore)$/.test(relative) || /^src\/platform\/(?:money|zpay)\.ts$/.test(relative);
  const absolute = path.resolve(root, relative);
  if (!allowed || !absolute.startsWith(root + path.sep) || /(?:^|\/)(?:\.env[^/]*|\.ccagent|node_modules|\.vercel|\.next)(?:\/|$)/.test(relative)) throw new Error('UNEXPECTED_DEPLOYMENT_FILE');
  const body = await readFile(absolute, 'utf8');
  if (credentials.some(value => body.includes(value))) throw new Error('DEPLOYMENT_CONTAINS_LOCAL_CREDENTIAL');
  bytes += file.size; files++;
}
console.log(JSON.stringify({ checked: true, target: 'ccagent-cloud', environment: 'preview', reviewedSourceFiles: files, bytes,
  sharedModules: ['money.ts', 'zpay.ts'], credentialsExcluded: true, localDataExcluded: true, generatedFilesExcluded: true }));
