import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { authEnvironment, databaseSchema } from '../src/core/env';

test('auth origin uses an exact Vercel deployment URL and never permits insecure hosted login', () => {
  process.env.AUTH_SECRET = randomBytes(48).toString('base64');
  delete process.env.AUTH_URL; delete process.env.VERCEL_URL; delete process.env.VERCEL;
  assert.equal(authEnvironment().origin, 'http://127.0.0.1:4310');
  process.env.VERCEL = '1';
  assert.throws(() => authEnvironment(), /AUTH_HTTPS_REQUIRED/);
  process.env.VERCEL_URL = 'ccagent-synthetic-verification.vercel.app';
  assert.equal(authEnvironment().origin, 'https://ccagent-synthetic-verification.vercel.app');
  process.env.AUTH_URL = 'https://ccagent.example.invalid';
  assert.equal(authEnvironment().origin, process.env.AUTH_URL);
  for (const value of ['http://localhost:4310', 'https://user:pass@ccagent.example.invalid', 'https://ccagent.example.invalid/path', 'https://ccagent.example.invalid/?key=x']) {
    process.env.AUTH_URL = value; assert.throws(() => authEnvironment());
  }
});
test('schema configuration cannot target the reference application or arbitrary SQL', () => {
  for (const value of ['public', 'auth', 'ccagent;drop schema public', 'ccagent_test_fake']) { process.env.DB_SCHEMA = value; assert.throws(() => databaseSchema()); }
  process.env.DB_SCHEMA = 'ccagent_test_0123456789abcdef'; assert.equal(databaseSchema(), process.env.DB_SCHEMA);
});
