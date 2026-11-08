import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

/** Obtain same-project development access without overwriting local configuration or exposing the token. */
export async function previewAccessToken(): Promise<string> {
  const cloudRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const linked = JSON.parse(await readFile(path.join(cloudRoot, '.vercel/project.json'), 'utf8'));
  assert.equal(linked.projectId, 'prj_2VwqV4ZbAkSX4WKJKDImBzWsNNYF'); assert.equal(linked.orgId, 'team_00cQVitR68vaaggGmAEYYrC5');
  const usable = (token: string) => {
    try { const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')); return typeof claims.exp === 'number' && claims.exp > Date.now() / 1000 + 300; }
    catch { return false; }
  };
  if (process.env.VERCEL_OIDC_TOKEN && usable(process.env.VERCEL_OIDC_TOKEN)) return process.env.VERCEL_OIDC_TOKEN;
  const packageRoot = path.resolve(process.env.APPDATA || '', 'npm/node_modules/vercel');
  const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(metadata.version, '65.12.1', 'PINNED_VERCEL_CLI_REQUIRED');
  const temporary = await realpath(os.tmpdir()), directory = await mkdtemp(path.join(temporary, 'ccagent-preview-access-'));
  const tokenFile = path.join(directory, 'development.env');
  try {
    const environment: NodeJS.ProcessEnv = { ...process.env, NODE_USE_SYSTEM_CA: '1', NODE_USE_ENV_PROXY: '1' };
    delete environment.NODE_TLS_REJECT_UNAUTHORIZED;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(packageRoot, 'dist/vc.js'), 'env', 'pull', tokenFile, '--environment=development', '--scope', 'lvye-1989s-projects', '--yes'],
        { cwd: cloudRoot, windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.resume(); child.stderr.resume();
      child.once('error', () => reject(new Error('PREVIEW_CREDENTIAL_REFRESH_FAILED')));
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('PREVIEW_CREDENTIAL_REFRESH_FAILED')));
    });
    const token = parse(await readFile(tokenFile)).VERCEL_OIDC_TOKEN || '';
    assert.ok(usable(token), 'PREVIEW_ACCESS_TOKEN_UNAVAILABLE');
    return token;
  } finally {
    assert.equal(path.dirname(directory), temporary); assert.ok(path.basename(directory).startsWith('ccagent-preview-access-'));
    await rm(directory, { recursive: true, force: true });
  }
}
