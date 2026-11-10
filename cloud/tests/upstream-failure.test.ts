import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upstreamTransportFailure, UpstreamTransportError } from '../src/core/upstream-failure';
import { errorResponse } from '../src/core/http';

test('upstream transport diagnostics keep fixed labels for nested native errors and never retain messages', () => {
  for (const [code, expected] of [['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'], ['UND_ERR_CONNECT_TIMEOUT', 'timeout'], ['ECONNRESET', 'connection'], ['CERT_HAS_EXPIRED', 'tls'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls']]) {
    const cause = Object.assign(new Error('https://private.invalid SECRET fixture-provider-key'), { code });
    assert.equal(upstreamTransportFailure(new TypeError('fetch failed', { cause })), expected);
  }
  assert.equal(upstreamTransportFailure(new Error('opaque'), true), 'timeout');
  assert.equal(upstreamTransportFailure(new DOMException('cancelled', 'AbortError')), 'timeout');
  const cycle = new Error('opaque'); cycle.cause = cycle;
  assert.equal(upstreamTransportFailure(cycle), 'transport');
  assert.equal(upstreamTransportFailure({ code: 'ENOTFOUND', secret: 'not-a-native-error' }), 'transport');
});

test('native transport retains diagnostic categories without retaining provider error messages or causes', async () => {
  for (const [code, expected] of [['ENOTFOUND', 'dns'], ['ECONNRESET', 'connection'], ['CERT_HAS_EXPIRED', 'tls'], ['ETIMEDOUT', 'timeout']]) {
    const failure = new UpstreamTransportError(Object.assign(new Error('fixture-secret https://private.invalid'), { code }));
    assert.equal(upstreamTransportFailure(failure), expected);
    assert.equal(failure.cause, undefined);
    assert.equal(failure.code, 'UPSTREAM_TRANSPORT_FAILED');
    assert.ok(!JSON.stringify(failure).includes('fixture-secret'));
    const response = errorResponse(failure);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { code: 'UPSTREAM_TRANSPORT_FAILED', message: '上游连接未完成。' });
  }
  assert.equal(upstreamTransportFailure(new UpstreamTransportError(new Error('opaque'), true)), 'timeout');
});
