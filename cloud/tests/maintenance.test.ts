import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { isolatedDatabase } from './database-fixture';

test('scheduled maintenance releases only expired usage and preserves financial races', { timeout: 180000 }, async t => {
  const fixture = await isolatedDatabase();
  const { database, closeDatabase } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  const { createKey, revokeKey } = await import('../src/core/keys');
  const { postLedger, authorizeUsage, finishUsage, walletFor } = await import('../src/core/wallet');
  const { releaseExpiredUsage, requireMaintenanceIdentity } = await import('../src/core/maintenance');
  try {
    const userId = randomUUID(), routeId = randomUUID();
    await database().db.insert(tables.user).values({ id: userId, name: 'Maintenance fixture', email: `${userId}@example.invalid`, emailVerified: true });
    const key = await createKey(userId, 'maintenance');
    await database().db.insert(tables.routes).values({ id: routeId, name: 'fixture', provider: 'fixture', service: 'chat', protocol: 'openai-chat', baseUrl: 'https://example.invalid', upstreamModel: 'fixture', credentialEnv: 'TEST_ONLY' });
    await database().db.transaction(tx => postLedger(tx, userId, 'test-credit', 'recharge', 10000n, 0n));
    const hold = async (id: string) => (await authorizeUsage({ userId, keyId: key.key.id, routeId, taskId: 'maintenance', idempotencyKey: id, requestHash: 'a'.repeat(64), authorized: 500n, priceSnapshot: { fixture: true } })).reservation;
    const expired = await hold('expired'), fresh = await hold('fresh'), settled = await hold('settled'), race = await hold('race');
    await finishUsage({ userId, reservationId: settled.id, charged: 100n, usage: { measured: true } });
    for (const id of [expired.id, settled.id, race.id]) await database().db.update(tables.reservations).set({ reconcileAt: new Date(Date.now() - 1000) }).where(eq(tables.reservations.id, id));
    await t.test('maintenance requires a separate strong server credential', () => {
      delete process.env.CRON_SECRET;
      assert.throws(() => requireMaintenanceIdentity(new Request('https://example.invalid')), { status: 503 });
      process.env.CRON_SECRET = randomBytes(32).toString('base64url');
      assert.throws(() => requireMaintenanceIdentity(new Request('https://example.invalid', { headers: { authorization: `Bearer ccagent_${randomBytes(32).toString('base64url')}` } })), { status: 401 });
      requireMaintenanceIdentity(new Request('https://example.invalid', { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
    });
    await t.test('overlapping jobs and a measured settlement cannot double-release or double-charge', async () => {
      const results = await Promise.allSettled([releaseExpiredUsage(), releaseExpiredUsage(), finishUsage({ userId, reservationId: race.id, charged: 200n, usage: { measured: true } })]);
      assert.ok(results.slice(0, 2).every(item => item.status === 'fulfilled'));
      const [expiredRow] = await database().db.select().from(tables.reservations).where(eq(tables.reservations.id, expired.id));
      assert.equal(expiredRow.status, 'released'); assert.equal(expiredRow.charged, 0n);
      assert.deepEqual(expiredRow.usage, { reason: 'unmeasured_after_24h', platformAbsorbed: true, automatic: true });
      const [raceRow] = await database().db.select().from(tables.reservations).where(eq(tables.reservations.id, race.id));
      assert.ok(['settled', 'released'].includes(raceRow.status));
      const [{ count }] = await database().db.select({ count: sql<number>`count(*)::integer` }).from(tables.ledger).where(eq(tables.ledger.reference, `usage:${race.id}:finish`));
      assert.equal(count, 1);
      assert.equal((await walletFor(userId)).balance, 9900n - raceRow.charged);
      assert.equal((await walletFor(userId)).frozen, 500n);
      assert.deepEqual(await releaseExpiredUsage(), { examined: 0, released: 0, deferred: 0 });
    });
    await t.test('revocation and account disable do not strand previously frozen funds', async () => {
      await revokeKey(userId, key.key.id);
      await database().db.update(tables.user).set({ banned: true }).where(eq(tables.user.id, userId));
      await database().db.update(tables.reservations).set({ status: 'pending', reconcileAt: new Date(Date.now() - 1000) }).where(eq(tables.reservations.id, fresh.id));
      assert.equal((await releaseExpiredUsage()).released, 1);
      assert.equal((await walletFor(userId)).frozen, 0n);
      const [storedKey] = await database().db.select().from(tables.apiKeys).where(eq(tables.apiKeys.id, key.key.id));
      assert.equal(storedKey.frozen, 0n);
    });
  } finally { await closeDatabase(); await fixture.cleanup(); }
});
