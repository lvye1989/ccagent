import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { isolatedDatabase } from './database-fixture';

test('isolated wallet lock order permits competing authorizations and settlement', { timeout: 120000 }, async () => {
  const fixture = await isolatedDatabase();
  process.env.DB_MAX_CONNECTIONS = '4';
  const { database, closeDatabase } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  const { createKey } = await import('../src/core/keys');
  const { authorizeUsage, finishUsage, postLedger, walletFor } = await import('../src/core/wallet');
  try {
    const id = randomUUID(), routeId = randomUUID();
    await database().db.insert(tables.user).values({ id, name: 'Concurrency fixture', email: `${id}@example.invalid`, emailVerified: true });
    const key = await createKey(id, 'fixture');
    await database().db.insert(tables.routes).values({ id: routeId, name: 'fixture', provider: 'fixture', service: 'chat', protocol: 'openai', baseUrl: 'https://example.invalid', upstreamModel: 'fixture', credentialEnv: 'TEST_ONLY' });
    await database().db.transaction(tx => postLedger(tx, id, 'test-credit', 'recharge', 400n, 0n));
    const results = await Promise.allSettled(Array.from({ length: 3 }, (_, index) => authorizeUsage({ userId: id, keyId: key.key.id, routeId,
      taskId: 'parallel', idempotencyKey: `call-${index}`, requestHash: 'a'.repeat(64), authorized: 200n, priceSnapshot: { fixture: true } })));
    const unexpected = results.filter((item): item is PromiseRejectedResult => item.status === 'rejected').map(item => item.reason as Error & { status?: number; cause?: Error }).filter(error => error.status !== 402);
    assert.deepEqual(unexpected.map(error => error.cause?.message ?? error.message), []);
    const successes = results.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof authorizeUsage>>> => item.status === 'fulfilled');
    assert.equal(successes.length, 2);
    assert.equal((await walletFor(id)).frozen, 400n);
    for (const success of successes) await finishUsage({ userId: id, reservationId: success.value.reservation.id, charged: 100n, usage: {} });
    assert.equal((await walletFor(id)).balance, 200n);
    assert.equal((await walletFor(id)).frozen, 0n);
  } finally { await closeDatabase(); await fixture.cleanup(); }
});
