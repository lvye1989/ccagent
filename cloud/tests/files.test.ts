import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { del, head } from '@vercel/blob';
import { isolatedDatabase } from './database-fixture';

test('live private Vercel Blob and isolated Supabase file ownership, scoped uploads and expiry', { timeout: 180000 }, async t => {
  const fixture = await isolatedDatabase();
  const { database, closeDatabase } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  const { initializeUpload, completeUpload, readOwnedFile, ownedFile, deleteOwnedFile, savePrivateResult, cleanupExpiredFiles } = await import('../src/core/files');
  const userA = randomUUID(), userB = randomUUID(), paths = new Set<string>();
  const body = JSON.stringify({ text: 'isolated private upload verification' });
  let upload: Awaited<ReturnType<typeof initializeUpload>>;
  async function track(id: string, owner = userA) { const entry = await ownedFile(owner, id, undefined, true); paths.add(entry.pathname); return entry; }
  async function send(url: string, content: string, contentType = 'application/json') {
    return fetch(url, { method: 'PUT', body: content, headers: { 'content-type': contentType, 'x-content-type': contentType }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  }
  try {
    await database().db.insert(tables.user).values([{ id: userA, name: 'File A fixture', email: `${userA}@example.invalid`, emailVerified: true }, { id: userB, name: 'File B fixture', email: `${userB}@example.invalid`, emailVerified: true }]);
    await t.test('upload URL is a short-lived write-only delegation for a server-generated owner path', async () => {
      upload = await initializeUpload(userA, { purpose: 'request', contentType: 'application/json', size: Buffer.byteLength(body) });
      const record = await track(upload.id);
      assert.ok(upload.upload.validUntil <= Date.now() + 120000);
      assert.ok(new Date(upload.expiresAt).getTime() <= Date.now() + 900000);
      assert.equal(JSON.stringify(upload).includes(process.env.BLOB_READ_WRITE_TOKEN!), false);
      await assert.rejects(() => readOwnedFile(userA, upload.id), { status: 409 });
      await assert.rejects(() => completeUpload(userB, upload.id), { status: 404 });
      const tampered = new URL(upload.upload.url), otherPath = `ccagent/checks/${randomUUID()}.json`;
      paths.add(otherPath); tampered.searchParams.set('pathname', otherPath);
      const changed = await send(tampered.href, body); await changed.body?.cancel();
      assert.ok(changed.status >= 400, `Altered upload path must be rejected: ${changed.status}`);
      assert.ok(record.pathname.startsWith('ccagent/users/'));
    });
    await t.test('direct upload completes against real storage and verified metadata becomes readable', async () => {
      const response = await send(upload.upload.url, body);
      await response.body?.cancel();
      assert.equal(response.ok, true, `Direct PUT failed with status ${response.status}`);
      assert.equal((await completeUpload(userA, upload.id)).ready, true);
      assert.equal((await completeUpload(userA, upload.id)).ready, true);
      const file = await readOwnedFile(userA, upload.id, ['request']);
      assert.equal(await new Response(file.stream).text(), body);
    });
    await t.test('anonymous access and cross-account references cannot read the object', async () => {
      const record = await track(upload.id), metadata = await head(record.pathname);
      const anonymous = await fetch(metadata.url, { redirect: 'error', signal: AbortSignal.timeout(15000) }); await anonymous.body?.cancel();
      assert.ok([401, 403, 404].includes(anonymous.status));
      await assert.rejects(() => readOwnedFile(userB, upload.id), { status: 404 });
      await assert.rejects(() => readOwnedFile(userA, upload.id, ['image']), { status: 400 });
    });
    await t.test('decoded streams enforce exact file size even when transfer headers differ', async () => {
      const original = Buffer.byteLength(body);
      try {
        for (const size of [original - 1, original + 1]) {
          await database().db.update(tables.blobs).set({ size }).where(eq(tables.blobs.id, upload.id));
          const file = await readOwnedFile(userA, upload.id, ['request']);
          await assert.rejects(() => new Response(file.stream).arrayBuffer(), { code: 'FILE_SIZE_MISMATCH' });
        }
      } finally { await database().db.update(tables.blobs).set({ size: original }).where(eq(tables.blobs.id, upload.id)); }
    });
    await t.test('content type and byte-size restrictions are enforced by the storage delegation', async () => {
      const small = await initializeUpload(userA, { purpose: 'request', contentType: 'application/json', size: 2 }); await track(small.id);
      const tooLarge = await send(small.upload.url, 'too large'); await tooLarge.body?.cancel();
      assert.ok(tooLarge.status >= 400, `Oversized upload must be rejected: ${tooLarge.status}`);
      const wrongType = await send(small.upload.url, '{}', 'text/plain'); await wrongType.body?.cancel();
      assert.ok(wrongType.status >= 400, `Wrong MIME must be rejected: ${wrongType.status}`);
    });
    await t.test('server-generated results stay private, expire and are purged from the same store', async () => {
      const result = await savePrivateResult(userA, 'data: fixture\n\n', 'text/event-stream');
      const record = await track(result.id);
      const file = await readOwnedFile(userA, result.id, ['result']);
      assert.equal(await new Response(file.stream).text(), 'data: fixture\n\n');
      await database().db.update(tables.blobs).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(tables.blobs.id, result.id));
      await assert.rejects(() => readOwnedFile(userA, result.id), { status: 410 });
      await assert.rejects(() => readOwnedFile(userB, result.id), { status: 404 });
      const cleaned = await cleanupExpiredFiles(); assert.equal(cleaned.deleted, 1); assert.equal(cleaned.deferred, 0);
      await assert.rejects(() => head(record.pathname));
    });
    await t.test('explicit deletion blocks further reads and expiry cleanup covers pending or deleted uploads', async () => {
      await deleteOwnedFile(userA, upload.id);
      await assert.rejects(() => ownedFile(userA, upload.id), { status: 404 });
      await database().db.update(tables.blobs).set({ expiresAt: new Date(Date.now() - 1000) });
      const cleaned = await cleanupExpiredFiles(); assert.ok(cleaned.deleted >= 2); assert.equal(cleaned.deferred, 0);
      const rows = await database().db.select().from(tables.blobs); assert.ok(rows.every(row => row.status === 'purged'));
    });
  } finally {
    const cleanup = await Promise.allSettled([...paths].map(pathname => del(pathname, { abortSignal: AbortSignal.timeout(15000) })));
    try { await closeDatabase(); } finally { await fixture.cleanup(); }
    assert.ok(cleanup.every(result => result.status === 'fulfilled'), 'Temporary Blob cleanup must finish');
  }
});
