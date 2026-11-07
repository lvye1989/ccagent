import './load-env';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const target = process.argv[2];
if (!target || !/^https:\/\/ccagent-cloud-[a-z0-9]+-lvye-1989s-projects\.vercel\.app$/.test(target)) throw new Error('EXACT_CCAGENT_PREVIEW_URL_REQUIRED');
const token = process.env.VERCEL_OIDC_TOKEN;
if (!token) throw new Error('PULL_DEVELOPMENT_OIDC_TOKEN_FIRST');
const headers = { 'x-vercel-trusted-oidc-idp-token': token };
const external = await fetch(`${target}/login`, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
const protectionRedirect = external.status === 302 && new URL(external.headers.get('location') || '/', target).hostname === 'vercel.com';
assert.ok([401, 403].includes(external.status) || protectionRedirect, 'PREVIEW_PROTECTION_MUST_REMAIN_ENABLED');
console.log(JSON.stringify({ publicAccess: false, platformProtection: true }));
for (const [path, expected] of [['/api/health', 200], ['/api/account/me', 401], ['/v1/models', 401], ['/api/admin/overview', 401], ['/api/admin/routes/defaults', 401], ['/api/system/maintenance', 401], ['/account', 307], ['/login', 200]] as const) {
  const response = await fetch(`${target}${path}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  if (response.status !== expected) throw new Error(`PREVIEW_CHECK_FAILED:${path}:${response.status}`);
  if (path === '/account') assert.equal(response.headers.get('location'), '/login');
  await response.body?.cancel();
  console.log(JSON.stringify({ path, status: response.status, passed: true }));
}
const response = await fetch(`${target}/api/auth/sign-in/email`, { method: 'POST', headers: { ...headers, origin: target, 'content-type': 'application/json' }, redirect: 'manual',
  signal: AbortSignal.timeout(30000), body: JSON.stringify({ email: 'deployment-connection-check@example.invalid', password: randomBytes(24).toString('base64url') }) });
const result = await response.json() as { code?: string };
assert.equal(response.status, 401); assert.equal(result.code, 'INVALID_EMAIL_OR_PASSWORD');
console.log(JSON.stringify({ path: '/api/auth/sign-in/email', status: response.status, invalidLoginRejected: true, realDatabaseAuthenticationPath: true, realEmailSent: false }));
