import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callReceiptHeaders } from '../src/core/call-receipt';
test('ledger response headers preserve committed request/call identity, state and exact micro-yuan', () => {
  const headers = callReceiptHeaders({ id: 'reservation-fixture', idempotencyKey: 'request-fixture', status: 'settled', charged: 9007199254740993n });
  assert.deepEqual(headers, { 'x-ccagent-call-id': 'reservation-fixture', 'x-ccagent-request-id': 'request-fixture', 'x-ccagent-billing-status': 'settled', 'x-ccagent-charged-micro': '9007199254740993' });
});
