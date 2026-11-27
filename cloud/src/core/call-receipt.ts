/** Only database-returned records enter this adapter; never forward supplier headers. */
export function callReceiptHeaders(record: { id: string; idempotencyKey: string; status: string; charged: bigint }) {
  return { 'x-ccagent-call-id': record.id, 'x-ccagent-request-id': record.idempotencyKey,
    'x-ccagent-billing-status': record.status, 'x-ccagent-charged-micro': record.charged.toString() };
}
