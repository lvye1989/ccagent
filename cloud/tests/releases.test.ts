import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { hashPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { isolatedDatabase } from './database-fixture';

test('version releases require administrator authority and reach every signed-in account without duplicate publications', { timeout: 240000 }, async () => {
  const fixture = await isolatedDatabase();
  process.env.AUTH_URL = 'http://127.0.0.1:4310'; process.env.AUTH_SECRET = randomBytes(48).toString('base64url');
  const { database, closeDatabase } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  const { authentication } = await import('../src/core/auth');
  const { GET, POST } = await import('../src/app/api/admin/releases/route');
  const { GET: getClient } = await import('../src/app/api/account/releases/route');
  const { publishRelease } = await import('../src/core/releases');
  const users = [randomUUID(), randomUUID()].map(id => ({ id, name: 'Release fixture', email: `${id}@example.invalid`, emailVerified: true }));
  const password = randomBytes(24).toString('base64url'), cookies: string[] = [];
  const request = (method = 'GET', body?: unknown, cookie = cookies[0], origin = process.env.AUTH_URL!) => new Request(`${process.env.AUTH_URL}/api/admin/releases`, { method, headers: { cookie: cookie || '', origin, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    await database().db.insert(tables.user).values(users);
    await database().db.insert(tables.account).values(await Promise.all(users.map(async user => ({ id: randomUUID(), userId: user.id, accountId: user.id, providerId: 'credential', password: await hashPassword(password) }))));
    await database().db.insert(tables.userRoles).values({ userId: users[0]!.id, roleId: 'admin' });
    for (const user of users) {
      const login = await authentication().handler(new Request(`${process.env.AUTH_URL}/api/auth/sign-in/email`, { method: 'POST', headers: { origin: process.env.AUTH_URL!, 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) }));
      assert.equal(login.status, 200); cookies.push(login.headers.getSetCookie().find(value => value.startsWith('ccagent.session_token='))!.split(';')[0]!);
    }
    assert.equal((await GET(request('GET', undefined, ''))).status, 401);
    assert.equal((await GET(request('GET', undefined, cookies[1]))).status, 403);
    assert.equal((await getClient(request('GET', undefined, ''))).status, 401);
    assert.equal((await (await getClient(request('GET', undefined, cookies[1]))).json()).release, null);
    const input = { id: randomUUID(), revision: 0, version: '0.1.4', title: '新版本', notes: '第一行\n第二行 <script>literal</script>', downloadUrl: 'https://downloads.example.invalid/app.exe' };
    assert.equal((await POST(request('POST', input, cookies[1]))).status, 403);
    assert.equal((await POST(request('POST', input, cookies[0], 'https://attacker.invalid'))).status, 403);
    for (const downloadUrl of ['javascript:alert(1)', 'file:///C:/test.exe', 'http://insecure.invalid/a.exe', 'https://user:secret@example.invalid/a.exe']) assert.equal((await POST(request('POST', { ...input, downloadUrl }))).status, 400);
    const first = await POST(request('POST', input)); assert.equal(first.status, 200); const published = await first.json();
    assert.equal(published.revision, 1); assert.equal(published.release.notes, input.notes);
    for (const cookie of cookies) assert.deepEqual((await (await getClient(request('GET', undefined, cookie))).json()).release, published.release);
    assert.deepEqual(await (await POST(request('POST', input))).json(), published, 'Lost response replay does not republish or change unread identity');
    assert.equal((await POST(request('POST', { ...input, notes: 'different' }))).status, 409);
    assert.equal((await POST(request('POST', { ...input, id: randomUUID() }))).status, 409);
    const concurrent = await Promise.allSettled([1, 2].map(number => publishRelease(users[0]!.id, { ...input, id: randomUUID(), revision: 1, version: `0.1.${number + 4}` })));
    assert.equal(concurrent.filter(item => item.status === 'fulfilled').length, 1);
    const audits = await database().db.select().from(tables.audit).where(eq(tables.audit.action, 'release.publish'));
    assert.equal(audits.length, 2);
    await database().db.update(tables.user).set({ banned: true }).where(eq(tables.user.id, users[1]!.id));
    assert.equal((await getClient(request('GET', undefined, cookies[1]))).status, 403);
  } finally { await closeDatabase(); await fixture.cleanup(); }
});
