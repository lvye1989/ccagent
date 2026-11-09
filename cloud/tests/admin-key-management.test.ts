import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { hashPassword } from 'better-auth/crypto';
import { isolatedDatabase } from './database-fixture';

test('isolated administrator API Key CRUD preserves owner, limits, secrets and financial history', { timeout: 300000 }, async t => {
  const fixture = await isolatedDatabase();
  process.env.AUTH_URL = 'http://127.0.0.1:4310'; process.env.AUTH_SECRET = randomBytes(48).toString('base64');
  const { database, closeDatabase } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  const { authentication } = await import('../src/core/auth');
  const collection = await import('../src/app/api/admin/keys/route');
  const item = await import('../src/app/api/admin/keys/[id]/route');
  const { hashKey, requireServiceIdentity, listKeys } = await import('../src/core/keys');
  const { authorizeUsage, finishUsage, postLedger, walletFor } = await import('../src/core/wallet');
  const admin = randomUUID(), ordinary = randomUUID(), unverified = randomUUID();
  const password = randomBytes(24).toString('base64url'), origin = process.env.AUTH_URL;
  let adminCookie = '', userCookie = '', keyId = '', secret = '', reservationId = '';
  const request = (path: string, method = 'GET', body?: unknown, cookie = '', source = origin) => new Request(origin + path, {
    method, headers: { origin: source, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const context = (id = keyId) => ({ params: Promise.resolve({ id }) });
  const mutate = (body: unknown, cookie = adminCookie, source = origin) => item.PUT(request('/api/admin/keys/' + keyId, 'PUT', body, cookie, source), context());
  const createBody = () => ({ userId: ordinary, name: '管理员创建的办公 Key', limitYuan: '2.123456' });
  const create = (body: unknown = createBody(), cookie = adminCookie, source = origin) => collection.POST(request('/api/admin/keys', 'POST', body, cookie, source));
  const stored = async () => (await database().db.select().from(tables.apiKeys).where(eq(tables.apiKeys.id, keyId)))[0];
  const authorize = (task: string) => authorizeUsage({ userId: ordinary, keyId, routeId: 'admin-key-fixture', taskId: task,
    idempotencyKey: randomUUID(), requestHash: randomBytes(32).toString('hex'), authorized: 1000000n, priceSnapshot: {} });
  try {
    await database().db.insert(tables.user).values([admin, ordinary, unverified].map(id => ({ id, email: `${id}@example.invalid`, name: 'Key management fixture', emailVerified: id !== unverified })));
    await database().db.insert(tables.userRoles).values({ userId: admin, roleId: 'admin' });
    await database().db.insert(tables.account).values(await Promise.all([admin, ordinary].map(async id => ({ id: randomUUID(), userId: id, accountId: id, providerId: 'credential', password: await hashPassword(password) }))));
    for (const id of [admin, ordinary]) {
      const response = await authentication().handler(request('/api/auth/sign-in/email', 'POST', { email: `${id}@example.invalid`, password }));
      assert.equal(response.status, 200);
      const cookie = response.headers.getSetCookie().find(value => value.startsWith('ccagent.session_token='))!.split(';')[0];
      if (id === admin) adminCookie = cookie; else userCookie = cookie;
    }
    await t.test('only keys.write may query/create/edit/delete; mutations reject cross-site origins', async () => {
      assert.equal((await collection.GET(request('/api/admin/keys'))).status, 401);
      assert.equal((await collection.GET(request('/api/admin/keys', 'GET', undefined, userCookie))).status, 403);
      assert.equal((await create(createBody(), userCookie)).status, 403);
      assert.equal((await create(createBody(), adminCookie, 'https://evil.invalid')).status, 403);
      assert.equal((await item.GET(request('/api/admin/keys/unknown', 'GET', undefined, userCookie), context('unknown'))).status, 403);
      assert.equal((await item.PUT(request('/api/admin/keys/unknown', 'PUT', { action: 'revoke' }, userCookie), context('unknown'))).status, 403);
      assert.equal((await item.DELETE(request('/api/admin/keys/unknown', 'DELETE', undefined, userCookie), context('unknown'))).status, 403);
      for (const method of ['PUT', 'DELETE']) {
        const response = method === 'PUT' ? await item.PUT(request('/api/admin/keys/unknown', method, { action: 'revoke' }, adminCookie, 'https://evil.invalid'), context('unknown'))
          : await item.DELETE(request('/api/admin/keys/unknown', method, undefined, adminCookie, 'https://evil.invalid'), context('unknown'));
        assert.equal(response.status, 403);
      }
    });
    await t.test('email lookup is exact and creating a Key requires an existing verified enabled owner', async () => {
      const response = await collection.GET(request('/api/admin/keys?email=' + encodeURIComponent(`${ordinary}@EXAMPLE.INVALID`), 'GET', undefined, adminCookie));
      assert.equal(response.status, 200); assert.equal((await response.json()).user.id, ordinary);
      assert.equal((await collection.GET(request('/api/admin/keys?email=absent%40example.invalid', 'GET', undefined, adminCookie))).status, 404);
      assert.equal((await collection.GET(request('/api/admin/keys?email=' + encodeURIComponent(`${ordinary}@example.invalid`) + '&q=x', 'GET', undefined, adminCookie))).status, 400);
      assert.equal((await create({ ...createBody(), userId: randomUUID() })).status, 404);
      assert.equal((await create({ ...createBody(), userId: unverified })).status, 400);
      await database().db.update(tables.user).set({ banned: true }).where(eq(tables.user.id, ordinary));
      assert.equal((await create()).status, 400);
      await database().db.update(tables.user).set({ banned: false }).where(eq(tables.user.id, ordinary));
    });
    await t.test('administrator creation targets the chosen owner and returns the full Key only once', async () => {
      const response = await create(); assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json(); keyId = body.key.id; secret = body.secret;
      assert.match(secret, /^ccagent_[A-Za-z0-9_-]{43}$/); assert.equal(body.key.userId, ordinary); assert.equal(body.key.limit, '2123456');
      assert.equal(body.key.hash, undefined); assert.notEqual(body.key.userId, admin);
      const row = await stored(); assert.equal(row.hash, hashKey(secret)); assert.ok(!JSON.stringify(row, (_, value) => typeof value === 'bigint' ? String(value) : value).includes(secret));
      const detail = await item.GET(request('/api/admin/keys/' + keyId, 'GET', undefined, adminCookie), context());
      const detailText = await detail.text(); assert.equal(detail.status, 200); assert.ok(!detailText.includes(secret)); assert.ok(!detailText.includes(row.hash));
      const list = await collection.GET(request('/api/admin/keys?user=' + ordinary + '&q=' + encodeURIComponent('办公') + '&pageSize=1', 'GET', undefined, adminCookie));
      const listed = await list.json(); assert.equal(list.status, 200); assert.equal(listed.total, 1); assert.equal(listed.rows[0].id, keyId); assert.ok(!JSON.stringify(listed).includes(secret));
      const headers = new Headers({ cookie: userCookie, authorization: 'Bearer ' + secret });
      assert.equal((await requireServiceIdentity(new Request(origin + '/v1/chat/completions', { headers }))).keyId, keyId);
      await assert.rejects(() => requireServiceIdentity(new Request(origin + '/v1/chat/completions', { headers: { cookie: adminCookie, authorization: 'Bearer ' + secret } })), { code: 'INVALID_API_KEY' });
    });
    await t.test('editing preserves ownership, accepts exact yuan precision and rejects malformed amounts', async () => {
      const response = await mutate({ action: 'update', name: '已修改名称', limitYuan: '5.000001' });
      assert.equal(response.status, 200); const row = await stored(); assert.equal(row.name, '已修改名称'); assert.equal(row.limit, 5000001n); assert.equal(row.userId, ordinary);
      for (const value of ['1.0000001', '-1', '1e3', '9000000000.000001']) assert.equal((await mutate({ action: 'update', name: 'bad', limitYuan: value })).status, 400);
      assert.equal((await mutate({ action: 'update', name: 'bad', limitYuan: '2', enabled: true })).status, 400);
      assert.equal((await stored()).name, '已修改名称');
      assert.equal((await mutate({ action: 'limit', limit: '6000000' })).status, 200, 'legacy micro-yuan update remains compatible');
    });
    await t.test('spent plus frozen is the minimum limit and successful deletion retains in-flight records', async () => {
      await database().db.insert(tables.routes).values({ id: 'admin-key-fixture', name: 'Synthetic fixture', service: 'chat', protocol: 'openai-chat', provider: 'fixture',
        baseUrl: 'https://api.deepseek.com', upstreamModel: 'synthetic', credentialEnv: 'CCAGENT_PROVIDER_FIXTURE' });
      await database().db.transaction(tx => postLedger(tx, ordinary, 'key-fixture-credit', 'recharge', 10000000n, 0n));
      const held = await authorize('before-key-delete'); reservationId = held.reservation.id;
      assert.equal((await stored()).frozen, 1000000n);
      const below = await mutate({ action: 'update', name: 'must-not-change', limitYuan: '0.999999' });
      assert.equal(below.status, 400); assert.equal((await below.json()).code, 'LIMIT_BELOW_USAGE'); assert.equal((await stored()).name, '已修改名称');
      assert.equal((await mutate({ action: 'update', name: '保留历史', limitYuan: null })).status, 200);
      assert.equal((await stored()).limit, null);
      const removed = await item.DELETE(request('/api/admin/keys/' + keyId, 'DELETE', undefined, adminCookie), context());
      assert.equal(removed.status, 200); assert.deepEqual(await removed.json(), { deleted: true, revoked: true, financialHistoryRetained: true });
      const revoked = await stored(); assert.equal(revoked.enabled, false); assert.ok(revoked.revokedAt); assert.equal(revoked.frozen, 1000000n);
      await assert.rejects(() => requireServiceIdentity(new Request(origin + '/v1/chat/completions', { headers: { cookie: userCookie, authorization: 'Bearer ' + secret } })), { code: 'INVALID_API_KEY' });
      await assert.rejects(() => authorize('after-key-delete'), { code: 'KEY_DISABLED' });
      await finishUsage({ userId: ordinary, reservationId, charged: 500001n, usage: { synthetic: true } });
      assert.equal((await stored()).spent, 500001n); assert.equal((await stored()).frozen, 0n); assert.equal((await walletFor(ordinary)).available, 9499999n);
      const history = await database().db.select().from(tables.reservations).where(eq(tables.reservations.id, reservationId));
      assert.equal(history.length, 1); assert.equal(history[0].status, 'settled'); assert.equal(history[0].keyId, keyId);
      assert.equal((await mutate({ action: 'update', name: '仍不可恢复', limitYuan: '10' })).status, 200); assert.equal((await stored()).enabled, false);
      assert.equal((await listKeys(ordinary)).length, 1);
    });
    await t.test('revocation stays permanent and neither audit nor read APIs contain the secret or hash', async () => {
      const before = (await stored()).revokedAt!.toISOString();
      assert.equal((await mutate({ action: 'revoke' })).status, 200); assert.equal((await stored()).revokedAt!.toISOString(), before);
      const audits = await database().db.select().from(tables.audit);
      const encoded = JSON.stringify(audits); assert.ok(!encoded.includes(secret)); assert.ok(!encoded.includes(hashKey(secret)));
      assert.ok(audits.some(row => row.action === 'keys.create' && row.actorId === admin && row.objectId === keyId));
      assert.ok(audits.some(row => row.action === 'keys.update')); assert.ok(audits.some(row => row.action === 'keys.delete' && (row.metadata as any).logicalDelete));
      const response = await collection.GET(request('/api/admin/keys?status=revoked', 'GET', undefined, adminCookie));
      const body = await response.json(); assert.equal(body.total, 1); assert.ok(!JSON.stringify(body).includes(secret));
      assert.equal((await item.GET(request('/api/admin/keys/absent', 'GET', undefined, adminCookie), context('absent'))).status, 404);
    });
  } finally { await closeDatabase(); await fixture.cleanup(); }
});
