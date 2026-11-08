import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

test('bridge page checks configured Host across Next internal URL rewriting and ignores forwarded Host', async () => {
  const origin = 'https://bridge-host-test.example.invalid';
  process.env.AUTH_URL = origin; process.env.AUTH_SECRET = randomBytes(48).toString('base64url');
  const { GET } = await import('../src/app/account/bridge/route');
  const query = new URLSearchParams({ clientOrigin: 'http://127.0.0.1:4174', target: '/account', channel: randomBytes(32).toString('base64url') });
  const route = '/account/bridge?' + query;
  assert.equal(GET(new Request('http://internal-next:3000' + route, { headers: { host: new URL(origin).host } })).status, 200);
  assert.equal(GET(new Request(origin + route)).status, 200);
  assert.equal(GET(new Request(origin + route, { headers: { host: 'untrusted.example.invalid', 'x-forwarded-host': new URL(origin).host } })).status, 400);
  assert.equal(GET(new Request('http://internal-next:3000' + route, { headers: { 'x-forwarded-host': new URL(origin).host } })).status, 400);
});
