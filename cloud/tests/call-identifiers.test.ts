import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { del } from '@vercel/blob';
import { hashPassword } from 'better-auth/crypto';
import { isolatedDatabase } from './database-fixture';
import { databaseSchema } from '../src/core/env';

test('accepted call identifiers remain recoverable without weakening ownership or repeating paid work', { timeout: 300000 }, async t => {
  const originalSchema = databaseSchema(), fixture = await isolatedDatabase();
  const credentialEnv = 'CCAGENT_PROVIDER_CALL_IDENTIFIER_FIXTURE';
  process.env.AUTH_URL = 'http://127.0.0.1:4310'; process.env.AUTH_SECRET = randomBytes(48).toString('base64url');
  process.env[credentialEnv] = randomBytes(32).toString('hex');
  const userId = randomUUID(), otherId = randomUUID(), password = randomBytes(24).toString('base64url');
  let close = async () => {}, verifiedBinding = false, fingerprint: (() => Promise<Record<string, string>>) | undefined;
  let originalFingerprint: Record<string, string> | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const { database, closeDatabase } = await import('../src/core/db'), tables = await import('../src/core/db/schema');
    close = closeDatabase;
    const checkedTables = [tables.user, tables.session, tables.account, tables.userRoles, tables.wallets, tables.ledger, tables.apiKeys,
      tables.routes, tables.prices, tables.orders, tables.reservations, tables.audit, tables.blobs];
    for (const table of checkedTables) assert.equal(getTableConfig(table).schema, fixture.schema);
    const [identity] = await database().client<{ role: string }[]>`select current_user as role`;
    assert.equal(identity!.role, 'ccagent_runtime'); verifiedBinding = true;
    console.log(JSON.stringify({ fixtureSchema: fixture.schema, tableSchema: tables.namespace.schemaName, runtimeRole: identity!.role, realProviders: false, actualMoney: false }));
    fingerprint = async () => {
      const result: Record<string, string> = {};
      for (const table of checkedTables) {
        const name = getTableConfig(table).name;
        const [row] = await fixture.owner.unsafe<{ digest: string }[]>(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as digest from "${originalSchema}"."${name}" t`);
        result[name] = row!.digest;
      }
      return result;
    };
    originalFingerprint = await fingerprint();
    cleanup = async () => {
      const files = await database().db.select({ pathname: tables.blobs.pathname }).from(tables.blobs).where(eq(tables.blobs.userId, userId));
      const prefix = `ccagent/users/${createHash('sha256').update(userId).digest('hex').slice(0, 32)}/`;
      for (const file of files) assert.ok(file.pathname.startsWith(prefix));
      const results = await Promise.allSettled(files.map(file => del(file.pathname, { abortSignal: AbortSignal.timeout(15000) })));
      assert.ok(results.every(result => result.status === 'fulfilled'), 'Only this fixture owner files must be cleaned');
    };
    const { authentication } = await import('../src/core/auth');
    const { createKey, revokeKey } = await import('../src/core/keys');
    const { walletFor, postLedger } = await import('../src/core/wallet');
    const { routeInput, saveRoute, createPriceVersion, priceDefinition } = await import('../src/core/catalog');
    const { createGateway } = await import('../src/core/gateway');
    const { GET: callStatus } = await import('../src/app/api/account/calls/[id]/route');
    const { GET: queryCallStatus } = await import('../src/app/api/account/calls/route');
    const hash = await hashPassword(password);
    for (const id of [userId, otherId]) {
      await database().db.insert(tables.user).values({ id, name: 'Synthetic call identifier fixture', email: `${id}@example.invalid`, emailVerified: true });
      await database().db.insert(tables.account).values({ id: randomUUID(), userId: id, accountId: id, providerId: 'credential', password: hash });
    }
    const login = async (id: string) => {
      const response = await authentication().handler(new Request(process.env.AUTH_URL + '/api/auth/sign-in/email', { method: 'POST',
        headers: { origin: process.env.AUTH_URL!, 'content-type': 'application/json' }, body: JSON.stringify({ email: `${id}@example.invalid`, password }) }));
      assert.equal(response.status, 200);
      return response.headers.getSetCookie().find(value => value.startsWith('ccagent.session_token='))!.split(';')[0]!;
    };
    const cookie = await login(userId), otherCookie = await login(otherId), key = await createKey(userId, 'Synthetic call identifier key');
    await database().db.transaction(tx => postLedger(tx, userId, 'synthetic-call-identifier-credit', 'recharge', 1000000n, 0n));
    const route = routeInput.parse({ id: 'call-identifier-fixture', name: 'Synthetic call identifier route', service: 'chat', protocol: 'openai-responses', provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1', upstreamModel: 'synthetic-call-identifier', credentialEnv, options: { contextWindow: 4096, maxOutputTokens: 64 } });
    await saveRoute(userId, route);
    await createPriceVersion(userId, { routeId: route.id, currency: 'CNY', definition: priceDefinition.parse({ tariff: { kind: 'constant' }, rates: [
      { metric: 'input_tokens', price: '1', unitQuantity: '1000000' }, { metric: 'cached_input_tokens', price: '0', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '1', unitQuantity: '1000000' },
    ] }), sourceUrl: 'https://example.invalid/synthetic-call-price', effectiveAt: new Date(Date.now() - 1000).toISOString() });
    await saveRoute(userId, { ...route, enabled: true });
    let suppliers = 0, measurable = true;
    const gateway = createGateway({ fetch: async () => {
      suppliers++;
      return Response.json({ id: 'synthetic', object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'IDENTIFIER_OK' }] }],
        ...(measurable ? { usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens: 4 } } : {}) });
    } });
    const execute = (id: string) => gateway.execute(new Request(process.env.AUTH_URL + '/v1/responses', { method: 'POST',
      headers: { cookie, authorization: `Bearer ${key.secret}`, 'content-type': 'application/json', 'idempotency-key': id },
      body: JSON.stringify({ model: route.id, input: 'Synthetic call trace only.', max_output_tokens: 16 }) }), 'responses');
    const status = (id: string, ownerCookie = cookie) => callStatus(new Request(process.env.AUTH_URL + '/api/account/calls/' + encodeURIComponent(id),
      { headers: ownerCookie ? { cookie: ownerCookie } : {} }), { params: Promise.resolve({ id }) });
    const queryStatus = (id: string, ownerCookie = cookie) => queryCallStatus(new Request(process.env.AUTH_URL + '/api/account/calls?' + new URLSearchParams({ id }),
      { headers: ownerCookie ? { cookie: ownerCookie } : {} }));

    await t.test('punctuation prefixes and the full 200-character boundary query and replay their original paid call', async () => {
      for (const id of ['ordinary', '_resume', '.resume', ':resume', '-resume', 'r'.repeat(200)]) {
        const before = suppliers, response = await execute(id); assert.equal(response.status, 200); await response.arrayBuffer();
        const lookup = await status(id); assert.equal(lookup.status, 200, `Accepted call must be recoverable: ${id.slice(0, 12)}`);
        const saved = await lookup.json(); assert.equal(saved.requestId, id); assert.equal(saved.status, 'settled'); assert.equal(saved.charged, '32');
        assert.deepEqual(await (await queryStatus(id)).json(), saved);
        assert.equal(saved.resultAvailable, true); assert.equal(suppliers, before + 1);
        const wallet = await walletFor(userId), replay = await execute(id); assert.equal(replay.status, 200); assert.equal(replay.headers.get('x-ccagent-replay'), 'true');
        await replay.arrayBuffer(); assert.equal(suppliers, before + 1); assert.deepEqual(await walletFor(userId), wallet);
      }
    });
    await t.test('exact dot identifiers retain dispatch compatibility and recover through the query endpoint', async () => {
      for (const id of ['.', '..']) {
        assert.notEqual(new URL(process.env.AUTH_URL + '/api/account/calls/' + encodeURIComponent(id)).pathname, '/api/account/calls/' + id);
        const before = suppliers, response = await execute(id); assert.equal(response.status, 200); await response.arrayBuffer();
        const lookup = await queryStatus(id); assert.equal(lookup.status, 200); const saved = await lookup.json();
        assert.equal(saved.requestId, id); assert.equal(saved.status, 'settled'); assert.equal(suppliers, before + 1);
        const wallet = await walletFor(userId), replay = await execute(id); assert.equal(replay.status, 200); assert.equal(replay.headers.get('x-ccagent-replay'), 'true');
        await replay.arrayBuffer(); assert.equal(suppliers, before + 1); assert.deepEqual(await walletFor(userId), wallet);
      }
    });
    await t.test('malformed or ambiguous identifiers are rejected without a reservation or supplier request', async () => {
      const before = suppliers, wallet = await walletFor(userId), rows = await database().db.select({ id: tables.reservations.id }).from(tables.reservations);
      for (const id of ['', 'x'.repeat(201), 'bad/id', 'bad id', 'bad?id']) {
        assert.equal((await execute(id)).status, 400);
        assert.equal((await status(id)).status, 400);
        assert.equal((await queryStatus(id)).status, 400);
      }
      for (const query of ['', 'id=ordinary&id=_resume', 'id=ordinary&userId=' + otherId]) assert.equal((await queryCallStatus(new Request(process.env.AUTH_URL + '/api/account/calls?' + query, { headers: { cookie } }))).status, 400);
      assert.equal(suppliers, before); assert.deepEqual(await walletFor(userId), wallet);
      assert.deepEqual(await database().db.select({ id: tables.reservations.id }).from(tables.reservations), rows);
    });
    await t.test('an uncertain punctuation-prefixed call is traceable and never becomes another paid request', async () => {
      measurable = false;
      const response = await execute('_unmeasured'); assert.equal(response.status, 200); await response.arrayBuffer();
      const lookup = await status('_unmeasured'); assert.equal(lookup.status, 200); const saved = await lookup.json();
      assert.equal(saved.status, 'pending'); assert.equal(saved.charged, '0'); assert.ok(BigInt(saved.authorized) > 0n);
      assert.deepEqual(await (await queryStatus('_unmeasured')).json(), saved);
      const before = suppliers, wallet = await walletFor(userId), repeated = await execute('_unmeasured');
      assert.equal(repeated.status, 409); assert.equal(suppliers, before); assert.deepEqual(await walletFor(userId), wallet);
    });
    await t.test('recovery remains login-owned after Key revocation and never exposes another account record', async () => {
      assert.equal((await status('ordinary', '')).status, 401);
      assert.equal((await queryStatus('ordinary', '')).status, 401);
      assert.equal((await status('_resume', otherCookie)).status, 404);
      assert.equal((await queryStatus('.', otherCookie)).status, 404);
      await revokeKey(userId, key.key.id);
      const response = await status('ordinary'); assert.equal(response.status, 200); const saved = await response.json();
      assert.equal('userId' in saved || 'keyId' in saved || 'requestHash' in saved || 'resultId' in saved, false);
      assert.equal(saved.status, 'settled');
      assert.deepEqual(await (await queryStatus('ordinary')).json(), saved);
    });
  } finally {
    try {
      if (verifiedBinding) await cleanup?.();
      if (originalFingerprint && fingerprint) {
        assert.deepEqual(await fingerprint(), originalFingerprint, 'Complete development rows must remain unchanged');
        console.log(JSON.stringify({ fixtureSchema: fixture.schema, developmentTablesChecked: Object.keys(originalFingerprint).length, developmentRowsUnchanged: true }));
      }
    } finally { await close(); await fixture.cleanup(); delete process.env[credentialEnv]; }
  }
});
