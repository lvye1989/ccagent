import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { isolatedDatabase } from './database-fixture';
import { databaseUrl } from '../src/core/env';
import { databaseOptions } from '../src/core/db/options';

test('real runtime role and transaction pool preserve concurrent ledger writes and rollback', { timeout: 120000 }, async t => {
  const runtimeUrl = databaseUrl(), fixture = await isolatedDatabase();
  let runtime: ReturnType<typeof postgres> | undefined;
  try {
    const tables = await import('../src/core/db/schema');
    const { postLedger } = await import('../src/core/wallet');
    const ownerDb = drizzle(fixture.owner, { schema: tables });
    const id = randomUUID();
    await ownerDb.insert(tables.user).values({ id, name: 'Runtime pool fixture', email: `${id}@example.invalid`, emailVerified: true });
    if (!/^ccagent_test_[a-f0-9]{16}$/.test(fixture.schema)) throw new Error('REFUSE_UNSCOPED_GRANT');
    await fixture.owner.unsafe(`GRANT USAGE ON SCHEMA "${fixture.schema}" TO ccagent_runtime`);
    await fixture.owner.unsafe(`GRANT SELECT ON "${fixture.schema}".wallets TO ccagent_runtime`);
    await fixture.owner.unsafe(`GRANT EXECUTE ON FUNCTION "${fixture.schema}".post_ledger(text,text,text,bigint,bigint,jsonb) TO ccagent_runtime`);
    runtime = postgres(runtimeUrl, databaseOptions(4));
    const [identity] = await runtime`select current_user as role`;
    assert.equal(identity.role, 'ccagent_runtime');
    const db = drizzle(runtime, { schema: tables });
    const balance = async () => (await db.select().from(tables.wallets).where(eq(tables.wallets.userId, id)))[0]!.balance;
    for (let round = 0; round < 4; round++) {
      await Promise.all([
        ...Array.from({ length: 8 }, () => db.transaction(tx => postLedger(tx, id, `runtime-credit-${round}`, 'recharge', 1000n, 0n))),
        ...Array.from({ length: 12 }, () => balance()),
      ]);
      assert.equal(await balance(), BigInt(round + 1) * 1000n);
    }
    await assert.rejects(db.transaction(async tx => { await postLedger(tx, id, 'runtime-rollback', 'recharge', 1000n, 0n); throw new Error('EXPECTED_ROLLBACK'); }), /EXPECTED_ROLLBACK/);
    await assert.rejects(db.update(tables.wallets).set({ balance: 999999n }).where(eq(tables.wallets.userId, id)));
    assert.equal(await balance(), 4000n);
    const entries = await ownerDb.select().from(tables.ledger).where(eq(tables.ledger.userId, id));
    assert.equal(entries.length, 4); assert(!entries.some(entry => entry.reference === 'runtime-rollback'));
    t.diagnostic(`Runtime role verified on port ${new URL(runtimeUrl).port || '5432'}; 32 duplicate writes, 48 mixed reads, rollback and denied direct mutation; disposable schema only.`);
  } finally { await runtime?.end({ timeout: 5 }); await fixture.cleanup(); }
});
