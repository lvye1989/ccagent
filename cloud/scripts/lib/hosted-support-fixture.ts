import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { parse } from 'dotenv';

const project = 'prj_2VwqV4ZbAkSX4WKJKDImBzWsNNYF';
const team = 'team_00cQVitR68vaaggGmAEYYrC5';
const scope = 'lvye-1989s-projects';
const targetPattern = /^https:\/\/ccagent-cloud-[a-z0-9]+-lvye-1989s-projects\.vercel\.app$/;

/** Existing CLI authentication; values are passed through process env, never argv or logs. */
function cli(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  assert.ok(args.every(value => /^[A-Za-z0-9_:/?.=\-]+$/.test(value)), 'UNSAFE_HOSTED_CLI_ARGUMENT');
  const childEnvironment: NodeJS.ProcessEnv = { ...env, NODE_USE_SYSTEM_CA: '1', NODE_USE_ENV_PROXY: '1' };
  delete childEnvironment.NODE_TLS_REJECT_UNAUTHORIZED;
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', ['npx.cmd', '--offline', '--yes', 'vercel@65.12.1', ...args].join(' ')],
      { cwd, env: childEnvironment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += String(data); });
    child.stderr.on('data', data => { stderr += String(data); });
    child.once('error', () => reject(new Error('HOSTED_CLI_START_FAILED')));
    child.once('exit', code => {
      if (code === 0) resolve(stdout);
      else {
        // CLI errors can echo request data. Keep only a fixed failure classification.
        const error = new Error(/deployment[_ ]not[_ ]found/i.test(stderr + stdout) ? 'HOSTED_DEPLOYMENT_NOT_FOUND'
          : /action_required|confirm|approval/i.test(stderr + stdout) ? 'HOSTED_CLI_APPROVAL_REQUIRED' : 'HOSTED_CLI_FAILED');
        reject(error);
      }
    });
  });
}

export async function hostedSupportFixture(options: { cloudRoot: string; directory: string; schema: string; providerVariables: string[];
  record: (values: Record<string, unknown>) => Promise<void> }) {
  assert.match(options.schema, /^ccagent_test_[a-f0-9]{16}$/);
  assert.equal(process.env.DB_SCHEMA, options.schema);
  const root = path.resolve(options.cloudRoot, '..');
  const identity = JSON.parse(await cli(['whoami', '--format', 'json'], root));
  assert.equal(identity.team.id, team); assert.equal(identity.cliVersion, '65.12.1');
  const config = JSON.parse(await cli(['api', `/v9/projects/${project}`, '--scope', scope, '--raw'], root));
  assert.equal(config.id, project); assert.equal(config.accountId, team); assert.equal(config.name, 'ccagent-cloud');
  assert.equal(config.rootDirectory, 'cloud'); assert.equal(config.framework, 'nextjs'); assert.equal(config.nodeVersion, '24.x');
  assert.equal(config.ssoProtection?.deploymentType, 'all_except_custom_domains');
  const review = await cli(['deploy', '--project', project, '--scope', scope, '--dry', '--json'], root);
  const inputs = JSON.parse(review) as { files: { path: string; sha?: string }[] };
  assert.ok(inputs.files.filter(file => file.sha).every(file => /^(?:cloud\/(?:src\/|[^/]+\.(?:json|ts)$)|src\/platform\/(?:money|zpay|pricingDefinition)\.ts$)/.test(file.path.replaceAll('\\', '/')) || file.path === 'cloud/.gitignore'), 'HOSTED_UNREVIEWED_INPUT');
  // The existing deployment reviewer also checks file bytes, credentials and the SQL contract.
  const { spawnSync } = await import('node:child_process');
  const reviewed = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/check-deployment-inputs.ts'], { cwd: options.cloudRoot, encoding: 'utf8', windowsHide: true, env: process.env });
  assert.equal(reviewed.status, 0, 'HOSTED_DEPLOYMENT_REVIEW_FAILED');
  const manifest = JSON.parse(reviewed.stdout);
  const expectedSource = process.env.CCAGENT_HOSTED_REVIEWED_SOURCE_SHA256;
  assert.match(expectedSource || '', /^[a-f0-9]{64}$/, 'HOSTED_REVIEWED_SOURCE_REQUIRED');
  assert.equal(manifest.sourceSha256, expectedSource, 'REVIEW_NEW_HOSTED_SOURCE_BEFORE_DISPATCH');
  await options.record({ hostedSourceSha256: manifest.sourceSha256, hostedSourceFiles: manifest.reviewedSourceFiles });

  let token = process.env.VERCEL_OIDC_TOKEN || '';
  const expires = () => { try { return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')).exp as number; } catch { return 0; } };
  if (expires() < Date.now() / 1000 + 900) {
    const linked = JSON.parse(await readFile(path.join(options.cloudRoot, '.vercel/project.json'), 'utf8'));
    assert.equal(linked.projectId, project); assert.equal(linked.orgId, team);
    // Only a new exact scratch file is written; existing .env.local is never pulled over.
    const tokenFile = path.join(options.directory, 'oidc.env');
    await cli(['env', 'pull', tokenFile.replaceAll('\\', '/'), '--environment=development', '--yes', '--scope', scope], options.cloudRoot);
    try { token = parse(await readFile(tokenFile)).VERCEL_OIDC_TOKEN || ''; }
    finally { assert.equal(path.dirname(tokenFile), options.directory); await rm(tokenFile, { force: true }); }
  }
  assert.ok(token && expires() > Date.now() / 1000 + 600, 'HOSTED_OIDC_UNAVAILABLE');

  const environment = { ...process.env, AUTH_URL: '', DB_SCHEMA: options.schema, DB_MAX_CONNECTIONS: '2', PAYMENT_ENABLED: 'false',
    RESEND_API_KEY: '', CRON_SECRET: '', ZPAY_PID: '', ZPAY_KEY: '' };
  const names = ['DATABASE_URL', 'DB_SCHEMA', 'DB_MAX_CONNECTIONS', 'AUTH_SECRET', 'AUTH_URL', 'PAYMENT_ENABLED', 'BLOB_READ_WRITE_TOKEN',
    'RESEND_API_KEY', 'CRON_SECRET', 'ZPAY_PID', 'ZPAY_KEY', ...options.providerVariables];
  for (const name of ['DATABASE_URL', 'AUTH_SECRET', 'BLOB_READ_WRITE_TOKEN', ...options.providerVariables]) assert.ok(environment[name as keyof typeof environment], 'HOSTED_REQUIRED_ENVIRONMENT_MISSING');
  let deploymentId = '', origin = '', restored = false;
  const originalRequest = https.request;
  const close = async () => {
    if (!restored) { https.request = originalRequest; restored = true; }
    if (!deploymentId) return;
    assert.match(deploymentId, /^dpl_[A-Za-z0-9]+$/); assert.match(origin, targetPattern);
    // Only this invocation's exact deployment is removed. No project or alias is deleted.
    const before = JSON.parse(await cli(['api', `/v13/deployments/${deploymentId}`, '--scope', scope, '--raw'], root));
    assert.equal(before.id, deploymentId); assert.equal(before.projectId, project); assert.notEqual(before.target, 'production');
    await cli(['remove', deploymentId, '--scope', scope, '--yes'], root);
    let missing = false;
    try { await cli(['api', `/v13/deployments/${deploymentId}`, '--scope', scope, '--raw'], root); }
    catch (error) { if (error instanceof Error && error.message === 'HOSTED_DEPLOYMENT_NOT_FOUND') missing = true; else throw error; }
    assert.ok(missing, 'HOSTED_DEPLOYMENT_STILL_PRESENT');
    await options.record({ hostedDeploymentRemoved: true });
  };
  try {
    const result = JSON.parse(await cli(['deploy', '--project', project, '--scope', scope, '--yes', '--force', '--no-wait', '--json',
      ...names.flatMap(name => ['--env', name])], root, environment));
    deploymentId = result.id || result.deployment?.id || '';
    origin = 'https://' + String(result.url || result.deployment?.url || '').replace(/^https:\/\//, '');
    assert.match(deploymentId, /^dpl_[A-Za-z0-9]+$/); assert.match(origin, targetPattern);
    await options.record({ hostedDeploymentId: deploymentId, hostedOrigin: origin, hostedDeploymentRemoved: false });
    let ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      const state = JSON.parse(await cli(['api', `/v13/deployments/${deploymentId}`, '--scope', scope, '--raw'], root));
      assert.equal(state.projectId, project); assert.notEqual(state.target, 'production');
      if (state.readyState === 'READY') { ready = true; break; }
      if (['ERROR', 'CANCELED'].includes(state.readyState)) throw new Error('HOSTED_BUILD_FAILED');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    assert.ok(ready, 'HOSTED_BUILD_NOT_READY');
    const publicResponse = await fetch(origin + '/login', { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    const redirect = publicResponse.headers.get('location');
    assert.ok([401, 403].includes(publicResponse.status) || publicResponse.status === 302 && redirect && new URL(redirect, origin).hostname === 'vercel.com', 'HOSTED_PROTECTION_MISSING');
    await publicResponse.body?.cancel();
    const health = await fetch(origin + '/api/health', { headers: { 'x-vercel-trusted-oidc-idp-token': token }, redirect: 'error', signal: AbortSignal.timeout(30000) });
    assert.equal(health.status, 200, 'HOSTED_HEALTH_FAILED'); await health.body?.cancel();
    // Test-only header injection preserves the actual native TLS/cookie/client transport.
    // The protection credential is scoped to the exact owned Preview origin, never upstreams or Blob URLs.
    https.request = function (url: URL | string, ...args: unknown[]) {
      if (new URL(url).origin === origin) {
        const requestOptions = args[0] as https.RequestOptions;
        assert.ok(requestOptions && typeof requestOptions === 'object', 'HOSTED_NATIVE_REQUEST_SIGNATURE_CHANGED');
        args[0] = { ...requestOptions, headers: { ...requestOptions.headers, 'x-vercel-trusted-oidc-idp-token': token } };
      }
      return Reflect.apply(originalRequest, https, [url, ...args]);
    } as typeof https.request;
    await options.record({ hostedReady: true, hostedProtectionEnabled: true });
    return { origin, close };
  } catch (error) { await close(); throw error; }
}
