import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { test } from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { isolatedDatabase } from './database-fixture';
import { databaseUrl } from '../src/core/env';
import { databaseOptions } from '../src/core/db/options';
import { grantRuntimeAccess } from '../src/core/db/runtime-permissions';

test('runtime bootstrap repairs financial grants when role provisioning follows migrations', { timeout: 120000 }, async t => {
  const runtimeUrl = databaseUrl(), fixture = await isolatedDatabase();
  let runtime: postgres.Sql | undefined;
  try {
    const tables = await import('../src/core/db/schema'), owner = fixture.owner, namespace = `"${fixture.schema}"`;
    const db = drizzle(owner, { schema: tables }), userId = randomUUID(), keyId = randomUUID();
    await db.insert(tables.user).values({ id: userId, name: 'Bootstrap fixture', email: `${userId}@example.invalid`, emailVerified: true });
    await db.insert(tables.apiKeys).values({ id: keyId, userId, name: 'Bootstrap fixture', prefix: 'fixture', hash: createHash('sha256').update(keyId).digest('hex') });
    await db.insert(tables.routes).values({ id: 'bootstrap-fixture', name: 'Bootstrap fixture', service: 'chat', protocol: 'openai-chat', provider: 'deepseek', baseUrl: 'https://example.invalid', upstreamModel: 'fixture', credentialEnv: 'CCAGENT_PROVIDER_BOOTSTRAP_FIXTURE', enabled: false });
    await owner.unsafe(`select ${namespace}.post_ledger($1,'bootstrap-credit','recharge',1000000,0,'{}')`, [userId]);
    const signatures = ['post_ledger(text,text,text,bigint,bigint,jsonb)', 'authorize_usage(text,text,text,text,text,text,bigint,jsonb)', 'finish_usage(text,text,bigint,jsonb,boolean)', 'acquire_mutex(bigint)', 'lock_wallet(text)'];
    for (const signature of signatures) await owner.unsafe(`REVOKE ALL ON FUNCTION ${namespace}.${signature} FROM ccagent_runtime`);
    runtime = postgres(runtimeUrl, databaseOptions(1));
    await assert.rejects(() => runtime!.unsafe(`select ${namespace}.authorize_usage($1,$2,'bootstrap-fixture','bootstrap-task','bootstrap-call',$3,100000,'{}')`, [userId, keyId, '0'.repeat(64)]), (error: { code?: string }) => error.code === '42501');
    await grantRuntimeAccess(owner, fixture.schema); await grantRuntimeAccess(owner, fixture.schema);
    for (const signature of signatures) {
      const [access] = await owner`select has_function_privilege('ccagent_runtime', ${fixture.schema + '.' + signature}, 'EXECUTE') as allowed,
        has_function_privilege('anon', ${fixture.schema + '.' + signature}, 'EXECUTE') as anonymous`;
      assert.equal(access!.allowed, true); assert.equal(access!.anonymous, false);
    }
    const [held] = await runtime.unsafe(`select ${namespace}.authorize_usage($1,$2,'bootstrap-fixture','bootstrap-task','bootstrap-call',$3,100000,'{}') as value`, [userId, keyId, '0'.repeat(64)]);
    assert.equal(held!.value.replay, false);
    await runtime.unsafe(`select ${namespace}.finish_usage($1,$2,1234,'{"fixture":true}',false)`, [userId, held!.value.reservation.id]);
    const [wallet] = await runtime.unsafe(`select balance::text,frozen::text from ${namespace}.wallets where user_id=$1`, [userId]);
    assert.equal(wallet!.balance, '998766'); assert.equal(wallet!.frozen, '0');
    await assert.rejects(() => runtime!.unsafe(`update ${namespace}.wallets set balance=999999999 where user_id=$1`, [userId]), (error: { code?: string }) => error.code === '42501');
    t.diagnostic('Real runtime role, missing-execute failure, idempotent repair, authorization and settlement; isolated schema and noncash fixture funds only.');
  } finally { await runtime?.end({ timeout: 5 }); await fixture.cleanup(); }
});
