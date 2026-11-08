import './load-env';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

async function main() {
  const canonical = 'https://ccagent-cloud.vercel.app';
  const target = process.argv[2] || canonical;
  assert.equal(target, canonical, 'PUBLIC_CCAGENT_PRODUCTION_URL_REQUIRED');
  const access: Record<string, string> = {};
  let checks = 0;
  for (const [route, expected] of [['/api/health', 200], ['/api/auth/get-session', 401], ['/api/account/me', 401], ['/api/admin/overview', 401], ['/v1/models', 401], ['/login', 200]] as const) {
    const reply: Response = await fetch(target + route, { headers: access, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    assert.equal(reply.status, expected, `${route}: unexpected status`);
    await reply.body?.cancel(); checks++;
    console.log(JSON.stringify({ route, status: reply.status, passed: true }));
  }
  for (const route of ['/api/auth/sign-up/email', '/api/auth/request-password-reset', '/api/auth/send-verification-email']) {
    // Syntactically invalid input cannot create an account or send an email.
    const reply: Response = await fetch(target + route, { method: 'POST', headers: { ...access, origin: canonical, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'short', name: '' }), redirect: 'manual', signal: AbortSignal.timeout(30000) });
    assert.equal(reply.status, 400, `${route}: input validation must be reachable`);
    await reply.body?.cancel(); checks++;
    console.log(JSON.stringify({ route, status: reply.status, inputValidation: true, passed: true }));
  }
  const wrongPassword = await fetch(target + '/api/auth/sign-in/email', { method: 'POST', headers: { ...access, origin: canonical, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'deployment-connection-check@example.invalid', password: randomBytes(24).toString('base64url') }), redirect: 'manual', signal: AbortSignal.timeout(30000) });
  const result = await wrongPassword.json() as { code?: string };
  assert.equal(wrongPassword.status, 401); assert.equal(result.code, 'INVALID_EMAIL_OR_PASSWORD'); checks++;
  console.log(JSON.stringify({ route: '/api/auth/sign-in/email', status: 401, realDatabaseAuthenticationPath: true, passed: true }));
  const rejectedOrigin = await fetch(target + '/api/auth/sign-up/email', { method: 'POST', headers: { ...access, origin: 'https://untrusted.example.invalid', 'content-type': 'application/json' },
    body: '{}', redirect: 'manual', signal: AbortSignal.timeout(30000) });
  assert.equal(rejectedOrigin.status, 403); await rejectedOrigin.body?.cancel(); checks++;
  console.log(JSON.stringify({ passed: true, target, publicAccess: true, checks, registrationInputReachable: true, realEmailSent: false, realAccountCreated: false, realProviderRequest: false }));
}
main().catch(error => { console.error(JSON.stringify({ passed: false, code: 'PRODUCTION_CHECK_FAILED',
  detail: error instanceof assert.AssertionError ? error.message : 'Inspect deployment and safe runtime logs.' })); process.exitCode = 1; });
