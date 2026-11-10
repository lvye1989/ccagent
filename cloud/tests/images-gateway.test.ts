import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { hashPassword } from 'better-auth/crypto';
import dns from 'node:dns/promises';
import { isolatedDatabase } from './database-fixture';
import type { KieTransport } from '../src/core/kie-images';

test('Kie asynchronous tasks preserve account isolation, idempotency and real isolated financial invariants', { timeout: 450000 }, async t => {
  const fixture = await isolatedDatabase();
  process.env.AUTH_URL = 'http://127.0.0.1:4310'; process.env.AUTH_SECRET = randomBytes(48).toString('base64');
  const { database, closeDatabase } = await import('../src/core/db'), tables = await import('../src/core/db/schema');
  const { createAuthentication } = await import('../src/core/auth'), { createKey, revokeKey } = await import('../src/core/keys');
  const { routeInput, saveRoute, createPriceVersion, priceDefinition, publicPricing, publishedRoute } = await import('../src/core/catalog');
  const { createImagesGateway } = await import('../src/core/images-gateway'), { postLedger, walletFor, finishUsage } = await import('../src/core/wallet');
  const { readOwnedFile } = await import('../src/core/files'), { releaseExpiredUsage } = await import('../src/core/maintenance');
  const { ownedCallStatus } = await import('../src/core/calls');
  const userId = randomUUID(), otherId = randomUUID(), password = randomBytes(24).toString('base64url'), secret = randomBytes(32).toString('base64url');
  const users = [userId, otherId].map(id => ({ id, name: 'Image fixture', email: `${id}@example.invalid`, emailVerified: true }));
  const auth = createAuthentication({ db: database().db, origin: process.env.AUTH_URL, secret: process.env.AUTH_SECRET, deliverMail: async () => { throw new Error('NO_REAL_MAIL'); } });
  const definition = priceDefinition.parse({ tariff: { kind: 'constant' }, rates: [
    { metric: 'output_images_1k', unitQuantity: '1', price: '0.21' }, { metric: 'output_images_2k', unitQuantity: '1', price: '0.35' }, { metric: 'output_images_4k', unitQuantity: '1', price: '0.56' },
  ] });
  const base = routeInput.parse({ id: 'kie-fixture-t2i', name: 'Kie fixture', service: 'image', protocol: 'kie-images', provider: 'kie', baseUrl: 'https://api.kie.ai/api/v1', upstreamModel: 'gpt-image-2-5-flare-text-to-image', retries: 0, options: { maxImages: 16 } });
  let cookie = '', otherCookie = '', key: Awaited<ReturnType<typeof createKey>>, otherKey: Awaited<ReturnType<typeof createKey>>, secondKey: Awaited<ReturnType<typeof createKey>>;
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr4kAAAAASUVORK5CYII=', 'base64');
  const bodies: Record<string, unknown>[] = [], calls: string[] = [], jobs = new Map<string, string>(); let creates = 0, downloads = 0, uploads = 0;
  let createMode: 'ok' | 'throw' | 'reject' = 'ok', queryState = 'success', consumed: number | undefined = 6, downloadMode: 'ok' | 'bad' = 'ok', failSettlement = false, wrongModel = false, wrongResolution = false;
  let rejectUpload = false, rejectReference = false;
  let blockQuery: Promise<void> | undefined, releaseQuery: (() => void) | undefined, queryEntered: (() => void) | undefined, blockCreate: Promise<void> | undefined, releaseCreate: (() => void) | undefined;
  const transport: KieTransport = async (url, init, allowedHosts) => {
    calls.push(url); assert.equal(init.redirect, 'error');
    if (url.includes('/file-stream-upload')) { uploads++; assert.deepEqual(allowedHosts, ['kieai.redpandaai.co']); assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${secret}`); assert.ok(init.body instanceof Uint8Array); if (rejectUpload) return Response.json({ code: 401, msg: secret }, { status: 401 }); return Response.json({ code: 200, data: { downloadUrl: 'https://api.kie.ai/reference.png' } }); }
    if (url.includes('/jobs/createTask')) {
      creates++; assert.deepEqual(allowedHosts, ['api.kie.ai']); assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${secret}`);
      bodies.push(JSON.parse(String(init.body))); if (createMode === 'throw') throw new Error(`secret ${secret}`); if (createMode === 'reject') return Response.json({ code: 402, msg: secret });
      const taskId = `task_${creates}`; jobs.set(taskId, String(bodies.at(-1)!.model)); await blockCreate; return Response.json({ code: 200, data: { taskId } });
    }
    if (url.includes('/jobs/recordInfo')) {
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${secret}`); queryEntered?.(); queryEntered = undefined; await blockQuery;
      const taskId = new URL(url).searchParams.get('taskId')!; assert.ok(jobs.has(taskId));
      return Response.json({ code: 200, data: { taskId, model: wrongModel ? 'unrelated-model' : jobs.get(taskId), ...(wrongResolution ? { param: JSON.stringify({ model: jobs.get(taskId), input: JSON.stringify({ resolution: '4K' }) }) } : {}), state: queryState, resultJson: JSON.stringify({ resultUrls: ['https://results.kie.example/result.png?signature=test'] }), ...(consumed === undefined ? {} : { creditsConsumed: consumed }) } });
    }
    downloads++; assert.equal(new Headers(init.headers).has('authorization'), false); assert.equal(allowedHosts, undefined);
    return new Response(downloadMode === 'ok' ? image : Buffer.from('<html>bad</html>'), { headers: { 'content-type': 'image/png' } });
  };
  const saveResult = async (owner: string, data: Uint8Array | string, mime: string) => {
    assert.equal(owner, userId); assert.equal(mime, 'image/png'); assert.equal(Buffer.from(data).equals(image), true);
    const id = randomUUID(), expiresAt = new Date(Date.now() + 900000), prefix = createHash('sha256').update(owner).digest('hex').slice(0, 32);
    await database().db.insert(tables.blobs).values({ id, userId: owner, pathname: `ccagent/users/${prefix}/result/${id}.png`, purpose: 'result', contentType: mime, size: image.length, status: 'ready', expiresAt });
    return { id, expiresAt };
  };
  const gateway = createImagesGateway({ transport, saveResult, settle: async input => { if (failSettlement && !input.release) { failSettlement = false; throw new Error('SYNTHETIC_TRANSIENT_SETTLEMENT'); } return finishUsage(input); }, readFile: (async (owner, id, purposes) => {
    if (rejectReference) { const { HttpError } = await import('../src/core/http'); throw new HttpError(503, 'FILE_SIZE_MISMATCH', secret); }
    const { ownedFile } = await import('../src/core/files'), record = await ownedFile(owner, id, purposes);
    return { record, stream: new ReadableStream({ start(controller) { controller.enqueue(image); controller.close(); } }) };
  }) as typeof readOwnedFile });
  const headers = (overrides: Record<string, string> = {}) => ({ cookie, authorization: `Bearer ${key.secret}`, ...overrides });
  const input = (extra: Record<string, unknown> = {}) => ({ model: base.id, prompt: 'Synthetic image generation fixture.', ...extra });
  const start = (id: string, body = input(), overrides: Record<string, string> = {}) => gateway.start(new Request(`${process.env.AUTH_URL}/v1/images/tasks`, { method: 'POST', headers: { ...headers(overrides), 'content-type': 'application/json', 'idempotency-key': id, 'x-ccagent-task-id': 'image-fixture' }, body: JSON.stringify(body) }));
  const get = (id: string, overrides: Record<string, string> = {}) => gateway.get(new Request(`${process.env.AUTH_URL}/v1/images/tasks/${id}`, { headers: headers(overrides) }), id);
  const reservation = async (id: string) => (await database().db.select().from(tables.reservations).where(eq(tables.reservations.idempotencyKey, id)))[0]!;
  try {
    await database().db.insert(tables.user).values(users);
    await database().db.insert(tables.account).values(await Promise.all(users.map(async user => ({ id: randomUUID(), userId: user.id, accountId: user.id, providerId: 'credential', password: await hashPassword(password) }))));
    for (const [index, user] of users.entries()) {
      const login = await auth.handler(new Request(`${process.env.AUTH_URL}/api/auth/sign-in/email`, { method: 'POST', headers: { origin: process.env.AUTH_URL!, 'content-type': 'application/json' }, body: JSON.stringify({ email: user.email, password }) }));
      assert.equal(login.status, 200); const value = login.headers.getSetCookie().find(item => item.startsWith('ccagent.session_token='))!.split(';')[0]!;
      if (!index) cookie = value; else otherCookie = value;
    }
    key = await createKey(userId, 'Image fixture'); otherKey = await createKey(otherId, 'Other image fixture'); secondKey = await createKey(userId, 'Second owner key');
    await database().db.transaction(tx => postLedger(tx, userId, 'fixture-image-credit', 'recharge', 100000000n, 0n));
    for (const route of [base, { ...base, id: 'kie-fixture-i2i', upstreamModel: 'gpt-image-2-5-sunburst-image-to-image' }]) {
      await saveRoute(userId, route, { apiKey: secret });
      await createPriceVersion(userId, { routeId: route.id, currency: 'CNY', definition, sourceUrl: 'https://kie.ai/gpt-image-2-5', effectiveAt: new Date(Date.now() - 1000).toISOString() });
      await saveRoute(userId, { ...route, enabled: true });
    }
    await t.test('authentication, exact protocol parameters and foreign references reject before freezing or contacting Kie', async () => {
      assert.equal((await start('no-login', input(), { cookie: '' })).status, 401);
      assert.equal((await start('no-key', input(), { authorization: '' })).status, 401);
      assert.equal((await start('wrong-key', input(), { authorization: `Bearer ${otherKey.secret}` })).status, 403);
      assert.equal((await start('bad-origin', input(), { origin: 'https://attacker.invalid' })).status, 403);
      for (const extra of [{ quality: 'high' }, { resolution: '4K', aspect_ratio: '27:16' }, { resolution: '2K', background: 'transparent' }, { input_images: [`ccagent-file:${randomUUID()}`] }]) assert.equal((await start(randomUUID(), input(extra))).status, 400);
      assert.equal((await start('foreign-reference', input({ model: 'kie-fixture-i2i', input_images: [`ccagent-file:${randomUUID()}`] }))).status, 404);
      assert.equal(creates, 0); assert.equal((await walletFor(userId)).frozen, 0n);
    });
    await t.test('one POST freezes the exact resolution budget and duplicate/changed-key/body cannot create again', async () => {
      const response = await start('once'); assert.equal(response.status, 202); const task = await response.json(); assert.equal(task.status, 'queued');
      assert.equal((await reservation('once')).authorized, 273000n); assert.equal((await walletFor(userId)).frozen, 273000n); assert.equal(creates, 1);
      assert.equal((await start('once')).status, 200); assert.equal(creates, 1);
      assert.equal((await start('once', input({ prompt: 'different' }))).status, 409);
      assert.equal((await start('once', input(), { authorization: `Bearer ${secondKey.secret}` })).status, 409);
      assert.equal(JSON.stringify(task).includes(secret), false); assert.equal(JSON.stringify(task).includes('task_1'), false);
    });
    await t.test('GET is bound to both account and key and makes no supplier calls for another owner', async () => {
      const task = await reservation('once'), before = calls.length;
      assert.equal((await get(task.id, { cookie: otherCookie, authorization: `Bearer ${otherKey.secret}` })).status, 404);
      assert.equal((await get(task.id, { authorization: `Bearer ${secondKey.secret}` })).status, 404); assert.equal(calls.length, before);
    });
    await t.test('simultaneous duplicate submissions create one provider task and expose the original queued operation', async () => {
      const before = creates; blockCreate = new Promise<void>(resolve => { releaseCreate = resolve; });
      const first = start('simultaneous');
      for (let attempt = 0; attempt < 1000 && creates === before; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(creates, before + 1); const duplicate = await start('simultaneous'); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).status, 'queued'); assert.equal(creates, before + 1);
      releaseCreate!(); blockCreate = undefined; assert.equal((await first).status, 202); await get((await reservation('simultaneous')).id);
    });
    await t.test('successful private PNG result settles only once and account bill hides supplier task handles', async () => {
      const task = await reservation('once'), response = await get(task.id), result = await response.json(); assert.equal(result.status, 'succeeded'); assert.equal(result.images[0].mime_type, 'image/png');
      assert.equal((await reservation('once')).charged, 273000n); assert.equal((await walletFor(userId)).frozen, 0n);
      const before = calls.length; assert.deepEqual(await (await get(task.id)).json(), result); assert.equal(calls.length, before);
      const bill = await ownedCallStatus(new Request(`${process.env.AUTH_URL}/api/account/calls/once`, { headers: { cookie } }), 'once'); assert.equal(JSON.stringify(bill, (_name, value) => typeof value === 'bigint' ? value.toString() : value).includes('task_1'), false);
      const finish = await database().db.select().from(tables.ledger).where(and(eq(tables.ledger.userId, userId), eq(tables.ledger.reference, `usage:${task.id}:finish`))); assert.equal(finish.length, 1);
    });
    await t.test('image editing validates owner file and uploads multipart once, forwarding only documented Kie fields', async () => {
      const id = randomUUID(), prefix = createHash('sha256').update(userId).digest('hex').slice(0, 32);
      await database().db.insert(tables.blobs).values({ id, userId, pathname: `ccagent/users/${prefix}/image/${id}.png`, purpose: 'image', contentType: 'image/png', size: image.length, status: 'ready', expiresAt: new Date(Date.now() + 900000) });
      // The developer machine uses proxy Fake-IP DNS (198.18/15). This isolated fixture supplies a public DNS answer; production still pins real public answers.
      const originalLookup = dns.lookup; let response: Response;
      try { dns.lookup = (async () => [{ address: '93.184.216.34', family: 4 }]) as unknown as typeof dns.lookup;
        response = await start('edit', input({ model: 'kie-fixture-i2i', input_images: [`ccagent-file:${id}`], background: 'transparent' }));
      } finally { dns.lookup = originalLookup; }
      assert.equal(response.status, 202); assert.equal((await response.json()).status, 'queued'); assert.equal(uploads, 1);
      const body = bodies.at(-1)! as { input: Record<string, unknown> }; assert.deepEqual(body.input.input_urls, ['https://api.kie.ai/reference.png']); assert.equal(body.input.background, 'transparent'); assert.equal('input_images' in body.input, false);
      await get((await reservation('edit')).id);
    });
    await t.test('reference failure records a safe stage/reason and releases funds without submitting generation', async () => {
      const id = randomUUID(), prefix = createHash('sha256').update(userId).digest('hex').slice(0, 32);
      await database().db.insert(tables.blobs).values({ id, userId, pathname: `ccagent/users/${prefix}/image/${id}.png`, purpose: 'image', contentType: 'image/png', size: image.length, status: 'ready', expiresAt: new Date(Date.now() + 900000) });
      const beforeCreates = creates;
      try {
        for (const stage of ['read-reference', 'upload-reference']) {
          rejectReference = stage === 'read-reference'; rejectUpload = stage === 'upload-reference';
          const response = await start(`failed-${stage}`, input({ model: 'kie-fixture-i2i', input_images: [`ccagent-file:${id}`] }));
          const result = await response.json(), saved = await reservation(`failed-${stage}`);
          assert.equal(result.status, 'failed'); assert.equal(result.code, 'IMAGE_INPUT_UPLOAD_FAILED');
          assert.equal(saved.status, 'released'); assert.equal(saved.charged, 0n); assert.equal(creates, beforeCreates);
          assert.deepEqual(saved.usage, { imageTask: { version: 1, status: 'failed', code: 'IMAGE_INPUT_UPLOAD_FAILED', failureStage: stage, failureCode: rejectReference ? 'FILE_SIZE_MISMATCH' : 'IMAGE_UPLOAD_AUTH_FAILED' } });
          assert(!JSON.stringify(saved.usage).includes(secret)); assert(!JSON.stringify(result).includes(secret));
          assert.equal('failureCode' in result, false);
        }
      } finally { rejectReference = false; rejectUpload = false; }
    });
    await t.test('immutable cost snapshot is used after prices change and route is paused; 4K does not send background', async () => {
      consumed = 16; await start('snapshot', input({ resolution: '4K', aspect_ratio: '16:9' })); assert.equal((bodies.at(-1)!.input as Record<string, unknown>).background, undefined);
      await createPriceVersion(userId, { routeId: base.id, currency: 'CNY', definition: priceDefinition.parse({ ...definition, rates: definition.rates.map(rate => ({ ...rate, price: '99' })) }), sourceUrl: 'https://kie.ai/gpt-image-2-5', effectiveAt: new Date(Date.now() - 1000).toISOString() });
      await saveRoute(userId, { ...base, enabled: false });
      assert.equal((await (await get((await reservation('snapshot')).id)).json()).status, 'succeeded'); assert.equal((await reservation('snapshot')).charged, 728000n);
      await createPriceVersion(userId, { routeId: base.id, currency: 'CNY', definition, sourceUrl: 'https://kie.ai/gpt-image-2-5', effectiveAt: new Date(Date.now() - 1000).toISOString() }); await saveRoute(userId, { ...base, enabled: true }); consumed = 6;
    });
    await t.test('uncertain create is pending and idempotent replay never sends a second task', async () => {
      createMode = 'throw'; const task = await (await start('uncertain')).json(); assert.equal(task.status, 'unknown'); const before = creates;
      assert.equal((await reservation('uncertain')).status, 'pending'); assert.equal((await (await start('uncertain')).json()).status, 'unknown'); await get(task.id); assert.equal(creates, before); createMode = 'ok';
    });
    await t.test('HTTP 200 business rejection and explicit asynchronous failure release instead of charging', async () => {
      createMode = 'reject'; const rejected = await (await start('reject')).json(); assert.equal(rejected.status, 'failed'); assert.equal((await reservation('reject')).status, 'released'); createMode = 'ok';
      await start('failed'); queryState = 'fail'; assert.equal((await (await get((await reservation('failed')).id)).json()).status, 'failed'); assert.equal((await reservation('failed')).charged, 0n); queryState = 'success';
    });
    await t.test('bad image or inconsistent credits remain pending without pretending success or repeating creation', async () => {
      await start('bad-image'); downloadMode = 'bad'; assert.equal((await (await get((await reservation('bad-image')).id)).json()).status, 'unknown'); assert.equal((await reservation('bad-image')).status, 'pending'); downloadMode = 'ok';
      await start('bad-credits'); consumed = 999; const before = downloads; assert.equal((await (await get((await reservation('bad-credits')).id)).json()).status, 'unknown'); assert.equal(downloads, before); consumed = 6;
    });
    await t.test('saved result resumes settlement after a transient failure without downloading or creating twice', async () => {
      await start('settlement-recovery'); const task = await reservation('settlement-recovery'), before = downloads; failSettlement = true;
      const initial = await (await get(task.id)).json(); assert.equal(initial.status, 'processing'); assert.equal(downloads, before + 1);
      const stored = await reservation('settlement-recovery'); assert.equal(stored.status, 'pending'); assert.ok(stored.resultBlobId); assert.ok(JSON.stringify(stored.usage).includes('file_id'));
      assert.equal((await (await get(task.id)).json()).status, 'succeeded'); assert.equal(downloads, before + 1); assert.equal((await reservation('settlement-recovery')).charged, 273000n);
    });
    await t.test('provider model and nested request resolution are checked against the immutable snapshot', async () => {
      await start('wrong-model'); wrongModel = true; const before = downloads;
      assert.equal((await (await get((await reservation('wrong-model')).id)).json()).status, 'unknown'); wrongModel = false; assert.equal(downloads, before);
      await start('wrong-resolution'); wrongResolution = true;
      assert.equal((await (await get((await reservation('wrong-resolution')).id)).json()).status, 'unknown'); wrongResolution = false; assert.equal(downloads, before);
      consumed = 10; await start('2k-cost', input({ resolution: '2K' })); assert.equal((await (await get((await reservation('2k-cost')).id)).json()).status, 'succeeded'); assert.equal((await reservation('2k-cost')).charged, 455000n); consumed = 6;
    });
    await t.test('concurrent polling has one provider fetch/download/settlement lease', async () => {
      await start('concurrent'); const task = await reservation('concurrent'), before = downloads;
      blockQuery = new Promise<void>(resolve => { releaseQuery = resolve; });
      const entered = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('QUERY_NOT_ENTERED')), 20000); queryEntered = () => { clearTimeout(timer); resolve(); }; });
      const first = get(task.id); await entered;
      const second = await get(task.id); assert.equal((await second.json()).status, 'processing'); releaseQuery!(); blockQuery = undefined;
      assert.equal((await (await first).json()).status, 'succeeded'); assert.equal(downloads, before + 1); assert.equal((await reservation('concurrent')).charged, 273000n);
    });
    await t.test('administrator connectivity probe requires explicit cost confirmation and tests real asynchronous image completion without a wallet charge', async () => {
      await database().db.insert(tables.userRoles).values({ userId, roleId: 'admin' });
      const { createRouteTests } = await import('../src/core/route-tests'), work: Promise<void>[] = [];
      const probe = createRouteTests({ imageTransport: transport, keepAlive: promise => { work.push(promise); } });
      const quoteRequest = new Request(`${process.env.AUTH_URL}/api/admin/routes/test?routeId=${base.id}`, { headers: { cookie } });
      const before = creates, beforeWallet = await walletFor(userId), prepared = await probe.get(quoteRequest); assert.equal(prepared.status, 200);
      const quote = (await prepared.json()).quote; assert.equal(quote.estimatedPublicCostMicro, '210000'); assert.equal(creates, before);
      const body = { routeId: base.id, testId: randomUUID(), confirmationFingerprint: quote.confirmationFingerprint, confirmPlatformCost: true };
      const post = () => probe.post(new Request(`${process.env.AUTH_URL}/api/admin/routes/test`, { method: 'POST', headers: { cookie, origin: process.env.AUTH_URL!, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
      assert.equal((await post()).status, 202); await Promise.all(work); assert.equal(creates, before + 1);
      const finished = await probe.get(new Request(`${process.env.AUTH_URL}/api/admin/routes/test?routeId=${base.id}&testId=${body.testId}`, { headers: { cookie } }));
      const result = (await finished.json()).test; assert.equal(result.status, 'succeeded', JSON.stringify({ status: result.status, code: result.code })); assert.equal(result.publicCostMicro, '210000'); assert.equal(result.userChargeMicro, '0'); assert.deepEqual(await walletFor(userId), beforeWallet);
      assert.equal((await post()).status, 200); assert.equal(creates, before + 1); assert.equal(JSON.stringify(result).includes(secret), false); assert.equal('upstreamTaskId' in result, false);
    });
    await t.test('price fingerprint and revocation reject before execution; maintenance keeps handles and late success cannot charge', async () => {
      const pricing = publicPricing(await publishedRoute(base.id)); assert.equal((await start('old-price', input(), { 'x-ccagent-price-version': String(pricing.version), 'x-ccagent-price-fingerprint': '0'.repeat(64) })).status, 409);
      await start('expired'); const expired = await reservation('expired'); await database().db.update(tables.reservations).set({ reconcileAt: new Date(Date.now() - 1000) }).where(eq(tables.reservations.id, expired.id));
      await releaseExpiredUsage(); const after = await reservation('expired'); assert.equal(after.status, 'released'); assert.ok(JSON.stringify(after.usage).includes('upstreamTaskId'));
      const before = calls.length; assert.equal((await (await get(expired.id)).json()).status, 'unknown'); assert.equal(calls.length, before); assert.equal((await reservation('expired')).charged, 0n);
      await revokeKey(userId, key.key.id); assert.equal((await get(expired.id)).status, 403);
    });
  } finally { releaseQuery?.(); releaseCreate?.(); blockQuery = undefined; blockCreate = undefined; await closeDatabase(); await fixture.cleanup(); }
});
