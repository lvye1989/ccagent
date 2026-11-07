import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { isolatedDatabase } from './database-fixture';
import { databaseUrl } from '../src/core/env';
import { databaseOptions } from '../src/core/db/options';
import { grantRuntimeAccess } from '../src/core/db/runtime-permissions';

test('all financial entrypoints wait on the account lock while other accounts proceed', { timeout: 120000 }, async t => {
  const runtimeUrl = databaseUrl(), fixture = await isolatedDatabase();
  let runtime: postgres.Sql | undefined;
  let closeRuntimeDatabase: (() => Promise<void>) | undefined;
  const release = Promise.withResolvers<void>(), held = Promise.withResolvers<number>();
  let holding: Promise<unknown> | undefined, operations: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    const tables = await import('../src/core/db/schema'), owner = fixture.owner, namespace = `"${fixture.schema}"`;
    const { closeDatabase } = await import('../src/core/db'); closeRuntimeDatabase = closeDatabase;
    const { authorizeUsage } = await import('../src/core/wallet');
    const db = drizzle(owner, { schema: tables }), userId = randomUUID(), otherId = randomUUID(), keyId = randomUUID();
    await db.insert(tables.user).values([userId, otherId].map(id => ({ id, name: 'Account lock fixture', email: `${id}@example.invalid`, emailVerified: true })));
    await db.insert(tables.apiKeys).values({ id: keyId, userId, name: 'Fixture', prefix: 'fixture', hash: createHash('sha256').update(keyId).digest('hex') });
    await db.insert(tables.routes).values({ id: 'lock-fixture', name: 'Fixture', service: 'chat', protocol: 'openai-chat', provider: 'deepseek', baseUrl: 'https://example.invalid', upstreamModel: 'fixture', credentialEnv: 'CCAGENT_PROVIDER_LOCK_FIXTURE', enabled: false });
    await owner.unsafe(`select (${namespace}.post_ledger($1,'initial-credit','recharge',2000,0,'{}')).id`, [userId]);
    const [initial] = await owner.unsafe(`select ${namespace}.authorize_usage($1,$2,'lock-fixture','lock-task','initial-call',$3,100,'{}') as value`, [userId, keyId, '0'.repeat(64)]);
    await grantRuntimeAccess(owner, fixture.schema);
    runtime = postgres(runtimeUrl, databaseOptions(4));
    const [access] = await owner`select has_function_privilege('anon', ${fixture.schema + '.lock_wallet(text)'}, 'EXECUTE') as anonymous,
      has_function_privilege('ccagent_runtime', ${fixture.schema + '.lock_wallet(text)'}, 'EXECUTE') as runtime`;
    assert.equal(access!.anonymous, false); assert.equal(access!.runtime, true);
    holding = owner.begin(async tx => {
      await tx.unsafe(`select ${namespace}.lock_wallet($1)`, [userId]);
      const [backend] = await tx`select pg_backend_pid() as pid`; held.resolve(backend!.pid);
      await release.promise;
    }).catch(error => { held.reject(error); throw error; });
    await held.promise;
    operations = Promise.allSettled([
      runtime.unsafe(`select (${namespace}.post_ledger($1,'concurrent-credit','recharge',50,0,'{}')).id`, [userId]),
      runtime.unsafe(`select ${namespace}.authorize_usage($1,$2,'lock-fixture','lock-task','concurrent-call',$3,200,'{}')`, [userId, keyId, '1'.repeat(64)]),
      runtime.unsafe(`select ${namespace}.finish_usage($1,$2,70,'{}',false)`, [userId, initial!.value.reservation.id]),
    ]);
    const deadline = Date.now() + 3500;
    let waiting = 0;
    while (Date.now() < deadline) {
      const [locks] = await owner`select count(*)::int as count from pg_stat_activity
        where wait_event_type='Timeout' and wait_event='PgSleep'
        and query like ${'%' + fixture.schema + '%'} and usename='ccagent_runtime'`;
      waiting = locks!.count;
      if (waiting === 3) break;
      await delay(100);
    }
    assert.equal(waiting, 3, 'all three entrypoints wait before protected writes without joining a blocking lock queue');
    await runtime.unsafe(`select (${namespace}.post_ledger($1,'other-credit','recharge',500,0,'{}')).id`, [otherId]);
    const [other] = await owner.unsafe(`select balance::text from ${namespace}.wallets where user_id=$1`, [otherId]);
    assert.equal(other!.balance, '500', 'an unrelated account completes while all three same-account calls wait');
    release.resolve(); await holding;
    const results = await operations;
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'fulfilled']);
    const [wallet] = await owner.unsafe(`select balance::text,frozen::text from ${namespace}.wallets where user_id=$1`, [userId]);
    assert.equal(wallet!.balance, '1980'); assert.equal(wallet!.frozen, '200');
    const [key] = await owner.unsafe(`select spent::text,frozen::text from ${namespace}.api_keys where id=$1`, [keyId]);
    assert.equal(key!.spent, '70'); assert.equal(key!.frozen, '200');
    await owner.begin(async tx => {
      await tx.unsafe(`select ${namespace}.lock_wallet($1)`, [userId]);
      await tx.unsafe(`select (${namespace}.post_ledger($1,'must-rollback','recharge',50,0,'{}')).id`, [userId]);
      throw new Error('EXPECTED_ROLLBACK');
    }).then(() => assert.fail('rollback expected'), error => assert.match(error.message, /EXPECTED_ROLLBACK/));
    const [unchanged] = await runtime.unsafe(`select balance::text from ${namespace}.wallets where user_id=$1`, [userId]);
    assert.equal(unchanged!.balance, '1980');
    const busyRelease = Promise.withResolvers<void>(), busyReady = Promise.withResolvers<void>();
    const busyHolding = owner.begin(async tx => {
      await tx.unsafe(`select ${namespace}.lock_wallet($1)`, [userId]); busyReady.resolve(); await busyRelease.promise;
    }).catch(error => { busyReady.reject(error); throw error; });
    try {
      await busyReady.promise;
      const start = Date.now();
      await assert.rejects(() => authorizeUsage({ userId, keyId, routeId: 'lock-fixture', taskId: 'lock-task', idempotencyKey: 'busy-must-not-write', requestHash: '2'.repeat(64), authorized: 100n, priceSnapshot: {} }),
        { status: 503, code: 'DATABASE_LOCK_BUSY' });
      assert(Date.now() - start < 12000, 'known busy result must precede the client query timeout');
      const [created] = await owner.unsafe(`select count(*)::int as count from ${namespace}.reservations where idempotency_key='busy-must-not-write'`);
      assert.equal(created!.count, 0);
      const [afterBusy] = await owner.unsafe(`select balance::text,frozen::text from ${namespace}.wallets where user_id=$1`, [userId]);
      assert.equal(afterBusy!.balance, '1980'); assert.equal(afterBusy!.frozen, '200');
    } finally { busyRelease.resolve(); await busyHolding; }
    t.diagnostic('Real runtime role; bounded acquisition before writes, another account completes, nested acquisition, rollback release and busy rejection without a reservation or balance change. Fixture funds only.');
  } finally {
    release.resolve(); await holding?.catch(() => {}); await operations;
    await closeRuntimeDatabase?.();
    await runtime?.end({ timeout: 5 }); await fixture.cleanup();
  }
});
