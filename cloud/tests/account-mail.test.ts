import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { accountMailDelivery, deliverAccountMail, requireAccountMailConfiguration, type AccountMail, type MailTransport } from '../src/core/mail';
import { HttpError } from '../src/core/http';

const origin = 'http://127.0.0.1:4310';
const password = 'synthetic-mail-password-123';
const request = (path: string, body: unknown) => new Request(`${origin}/api/auth${path}`, {
  method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
function fixture(transport: MailTransport, checkConfiguration?: () => void) {
  const rows: Record<string, any[]> = { user: [], account: [], session: [], verification: [], rateLimit: [] };
  const delivery = accountMailDelivery(transport, checkConfiguration);
  const auth = betterAuth({ baseURL: origin, secret: randomBytes(48).toString('base64'), database: memoryAdapter(rows),
    emailAndPassword: { enabled: true, autoSignIn: false, requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => delivery.deliver({ to: user.email, url, kind: 'reset' }) },
    emailVerification: { sendOnSignUp: true, sendOnSignIn: true, autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => delivery.deliver({ to: user.email, url, kind: 'verification' }) },
    rateLimit: { enabled: false }, logger: { disabled: true },
  });
  return { rows, handler: delivery.wrapHandler(auth.handler) };
}
async function safeFailure(response: Response, code: string, privateParts: string[] = []) {
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const text = await response.text();
  assert.equal(JSON.parse(text).code, code);
  for (const part of privateParts) assert.ok(!text.includes(part));
  assert.equal(response.headers.get('set-cookie'), null);
}

test('missing account mail configuration prevents sign-up and reset before any auth database write', async () => {
  const before = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    const auth = fixture(async () => { assert.fail('no email transport should run'); }, requireAccountMailConfiguration);
    for (const path of ['/sign-up/email', '/request-password-reset', '/send-verification-email']) {
      await safeFailure(await auth.handler(request(path, { name: 'Fixture', email: 'missing@example.invalid', password })), 'MAIL_NOT_CONFIGURED');
      assert.ok(Object.values(auth.rows).every(rows => rows.length === 0));
    }
  } finally { if (before === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = before; }
});

test('real Better Auth swallowed sign-up delivery failure becomes a safe error and preserves verification', async () => {
  const sent: AccountMail[] = [];
  let fail = true;
  const auth = fixture(async message => { sent.push(message); if (fail) throw new Error(`private provider error ${message.to} ${message.url}`); });
  const email = 'undelivered@example.invalid';
  const response = await auth.handler(request('/sign-up/email', { name: 'Undelivered', email, password }));
  assert.equal(sent.length, 1);
  await safeFailure(response, 'MAIL_DELIVERY_UNAVAILABLE', [email, sent[0].url, 'private provider error', 'token=']);
  assert.equal(auth.rows.user.length, 1);
  assert.equal(auth.rows.user[0].emailVerified, false);
  assert.equal(auth.rows.session.length, 0);
  fail = false;
  assert.equal((await auth.handler(request('/sign-in/email', { email, password }))).status, 403);
  assert.equal(auth.rows.user[0].emailVerified, false);
  assert.equal(auth.rows.session.length, 0);
  assert.equal((await auth.handler(request('/send-verification-email', { email }))).status, 200);
  assert.equal(auth.rows.user[0].emailVerified, false);
});

test('real Better Auth password-reset and explicit verification delivery failures never report success', async () => {
  const sent: AccountMail[] = [];
  let fail = false;
  const auth = fixture(async message => { sent.push(message); if (fail) throw new Error(`secret ${message.to} ${message.url}`); });
  const email = 'reset@example.invalid';
  assert.equal((await auth.handler(request('/sign-up/email', { name: 'Reset', email, password }))).status, 200);
  fail = true;
  for (const path of ['/request-password-reset', '/send-verification-email', '/sign-in/email']) {
    const response = await auth.handler(request(path, { email, password }));
    await safeFailure(response, 'MAIL_DELIVERY_UNAVAILABLE', [email, sent.at(-1)!.url, 'secret', 'token=']);
  }
  // Existing-account protection and generic unknown-email behavior remain intact.
  assert.equal(auth.rows.user[0].emailVerified, false);
  assert.equal(auth.rows.session.length, 0);
  assert.equal((await auth.handler(request('/request-password-reset', { email: 'unknown@example.invalid' }))).status, 200);
});

test('overlapping auth requests keep delivery errors isolated and a later request can succeed', async () => {
  let releaseFailure!: () => void, signalFailure!: () => void;
  const failureStarted = new Promise<void>(resolve => { signalFailure = resolve; });
  const failureGate = new Promise<void>(resolve => { releaseFailure = resolve; });
  const auth = fixture(async message => {
    if (message.to === 'fail@example.invalid') { signalFailure(); await failureGate; throw new Error('private concurrent failure'); }
  });
  const failing = auth.handler(request('/sign-up/email', { name: 'Fail', email: 'fail@example.invalid', password }));
  await failureStarted;
  const success = await auth.handler(request('/sign-up/email', { name: 'Pass', email: 'pass@example.invalid', password }));
  assert.equal(success.status, 200);
  releaseFailure();
  await safeFailure(await failing, 'MAIL_DELIVERY_UNAVAILABLE', ['private concurrent failure', 'fail@example.invalid']);
  assert.equal((await auth.handler(request('/sign-up/email', { name: 'Later', email: 'later@example.invalid', password }))).status, 200);
});

test('verified account sign-in does not require a working email transport', async () => {
  let configured = true;
  const check = () => { if (!configured) throw new HttpError(503, 'MAIL_NOT_CONFIGURED', 'private fixture message'); };
  const auth = fixture(async () => { check(); }, check);
  const email = 'verified@example.invalid';
  assert.equal((await auth.handler(request('/sign-up/email', { name: 'Verified', email, password }))).status, 200);
  // Only this isolated in-memory fixture is marked verified; production still
  // requires the signed verification link handled by Better Auth.
  auth.rows.user[0].emailVerified = true;
  configured = false;
  const response = await auth.handler(request('/sign-in/email', { email, password }));
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('set-cookie'));
});

test('Resend provider rejection is sanitized without sending real email', async () => {
  const beforeKey = process.env.RESEND_API_KEY;
  const beforeFetch = globalThis.fetch;
  let calls = 0;
  process.env.RESEND_API_KEY = 're_synthetic_mail_fixture';
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ name: 'validation_error', message: 'private-provider-recipient-token-url' }), {
      status: 403, headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await assert.rejects(() => deliverAccountMail({ to: 'private@example.invalid', url: `${origin}/?token=private-token`, kind: 'verification' }),
      error => error instanceof Error && error.message.includes('邮件') && !error.message.includes('private'));
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = beforeFetch;
    if (beforeKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = beforeKey;
  }
});
