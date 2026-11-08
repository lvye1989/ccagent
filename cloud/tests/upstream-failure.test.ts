import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upstreamTransportFailure } from '../src/core/upstream-failure';

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
