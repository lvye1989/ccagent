import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { isolatedDatabase } from './database-fixture';

test('a busy refund never contacts the supplier or leaves a hold, and can succeed after release', { timeout: 120000 }, async t => {
  const fixture = await isolatedDatabase();
  const { database, closeDatabase } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  const { postLedger, walletFor } = await import('../src/core/wallet');
  const { createPaymentService } = await import('../src/core/payments');
  const { errorResponse } = await import('../src/core/http');
  const release = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>();
  let holding: Promise<unknown> | undefined, supplierCalls = 0;
  try {
    const payer = randomUUID(), actor = randomUUID(), orderId = Date.now().toString() + '0001';
    await database().db.insert(tables.user).values([payer, actor].map(id => ({ id, name: 'Busy refund fixture', email: `${id}@example.invalid`, emailVerified: true })));
    await database().db.transaction(tx => postLedger(tx, payer, 'fixture-credit', 'recharge', 1_000_000n, 0n));
    await database().db.insert(tables.orders).values({ id: orderId, userId: payer, amountFen: 100n, status: 'credited', merchantId: 'fixture', tradeNo: 'fixture-' + orderId, creditedAt: new Date() });
    const service = createPaymentService({ merchantId: 'fixture', key: 'fixture-only', origin: 'https://example.invalid', provider: {
      checkout: () => { throw new Error('UNEXPECTED_CHECKOUT'); },
      queryPaidOrder: async () => { throw new Error('UNEXPECTED_QUERY'); },
      refund: async () => { supplierCalls++; assert.equal((await walletFor(payer)).frozen, 1_000_000n); return { status: 'success' as const }; },
    } });
    holding = fixture.owner.begin(async tx => {
      await tx.unsafe(`select "${fixture.schema}".lock_wallet($1)`, [payer]); ready.resolve(); await release.promise;
    }).catch(error => { ready.reject(error); throw error; });
    await ready.promise;
    let busy: unknown;
    try { await service.requestRefund(orderId, actor, 'Fixture busy refund'); }
    catch (error) { busy = error; }
    const response = errorResponse(busy);
    assert.equal(response.status, 503); assert.equal((await response.json()).code, 'DATABASE_LOCK_BUSY');
    assert.equal(supplierCalls, 0);
    assert.equal((await database().db.select().from(tables.refunds).where(eq(tables.refunds.orderId, orderId))).length, 0);
    const before = await walletFor(payer); assert.equal(before.balance, 1_000_000n); assert.equal(before.frozen, 0n);
    release.resolve(); await holding;
    const result = await service.requestRefund(orderId, actor, 'Fixture recovered refund');
    assert.equal(result.status, 'success'); assert.equal(supplierCalls, 1);
    const after = await walletFor(payer); assert.equal(after.balance, 0n); assert.equal(after.frozen, 0n);
    await service.requestRefund(orderId, actor, 'Fixture repeated refund'); assert.equal(supplierCalls, 1);
    t.diagnostic('Actual runtime role and isolated funds; busy HTTP error is explicit, no supplier or partial refund state, then one simulated refund after release. No real payment requests.');
  } finally {
    release.resolve(); await holding?.catch(() => {}); await closeDatabase(); await fixture.cleanup();
  }
});
