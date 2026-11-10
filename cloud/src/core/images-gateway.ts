import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { database } from './db';
import { reservations } from './db/schema';
import { publishedRoute, publicPricing, quoteDefinition, type PriceDefinition } from './catalog';
import { errorResponse, HttpError, json, readJson, requireSameOrigin } from './http';
import { requireServiceIdentity } from './keys';
import { authorizeUsage, finishUsage } from './wallet';
import { ownedFile, readOwnedFile, savePrivateResult } from './files';
import { resolveRouteCredential, type CredentialRoute } from './provider-credentials';
import { callIdentifierPattern } from './call-identifiers';
import { createKieClient, imageTaskInput, validateKieRoute, boundedImageBytes, type ImageResult, type ImageTaskInput, type ImageTaskStatus, type KieTransport } from './kie-images';

type Reservation = typeof reservations.$inferSelect;
type ImageState = { version: 1; status: ImageTaskStatus; upstreamTaskId?: string; images?: ImageResult[]; code?: string; failureStage?: 'read-reference' | 'upload-reference'; failureCode?: string; credits?: number; leaseId?: string; leaseUntil?: number };
const uploadFailureCodes = new Set(['FILE_NOT_FOUND', 'FILE_EXPIRED', 'FILE_NOT_READY', 'FILE_TYPE_MISMATCH', 'FILE_SIZE_MISMATCH', 'STORAGE_NOT_CONFIGURED', 'INVALID_IMAGE', 'UPSTREAM_HOST_NOT_ALLOWED', 'UPSTREAM_TRANSPORT_FAILED', 'UPSTREAM_REDIRECT_NOT_ALLOWED', 'UPSTREAM_RESPONSE_INVALID', 'INVALID_UPSTREAM_BODY', 'IMAGE_UPLOAD_RESPONSE_INVALID', 'IMAGE_UPLOAD_AUTH_FAILED', 'IMAGE_UPLOAD_RATE_LIMITED', 'IMAGE_UPLOAD_TOO_LARGE', 'IMAGE_UPLOAD_FAILED']);
type ImageSnapshot = { route: CredentialRoute & { protocol: string; upstreamModel: string }; resolution: ImageTaskInput['resolution']; parameters: { aspect_ratio: string; background: string }; definition: PriceDefinition; currency: 'CNY' | 'USD'; usdCny: string | null };
const identifier = z.string().regex(callIdentifierPattern);
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function stateFor(value: Reservation): ImageState {
  const state = record(record(value.usage).imageTask);
  return state.version === 1 ? state as ImageState : value.status === 'held' ? { version: 1, status: 'queued' } : { version: 1, status: 'unknown', code: 'IMAGE_STATE_UNCONFIRMED' };
}
function view(value: Reservation) {
  const state = stateFor(value);
  // A maintenance release is final; a late provider response must never recreate a charge.
  const status: ImageTaskStatus = value.status === 'released' && state.status !== 'failed' ? 'unknown' : value.status !== 'settled' && state.status === 'succeeded' ? 'processing' : state.status;
  return { id: value.id, call_id: value.idempotencyKey, status, poll_after_ms: ['queued', 'processing'].includes(status) ? 2500 : 0,
    images: value.status === 'settled' && state.status === 'succeeded' ? state.images ?? [] : [],
    ...(state.code ? { code: state.code } : {}), ...(value.status === 'released' && state.status !== 'failed' ? { code: 'IMAGE_CALL_CLOSED', message: '调用已关闭；结果未核实，不会重新扣款。' } : {}) };
}
function quantities(resolution: ImageTaskInput['resolution']) { return { output_images_1k: resolution === '1K' ? 1n : 0n, output_images_2k: resolution === '2K' ? 1n : 0n, output_images_4k: resolution === '4K' ? 1n : 0n }; }
function sameOrigin(request: Request) { if (request.headers.has('origin')) requireSameOrigin(request); if (request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'INVALID_ORIGIN', '请求来源无效。'); }

export function createImagesGateway(options: {
  transport?: KieTransport; now?: () => Date;
  fileMetadata?: typeof ownedFile; readFile?: typeof readOwnedFile; saveResult?: typeof savePrivateResult;
  settle?: typeof finishUsage;
} = {}) {
  const now = options.now ?? (() => new Date()), metadata = options.fileMetadata ?? ownedFile, readFile = options.readFile ?? readOwnedFile, saveResult = options.saveResult ?? savePrivateResult;
  const settle = options.settle ?? finishUsage;
  async function read(id: string, userId: string, keyId: string) {
    const [value] = await database().db.select().from(reservations).where(and(eq(reservations.id, id), eq(reservations.userId, userId), eq(reservations.keyId, keyId))).limit(1);
    if (!value || record(value.priceSnapshot).service !== 'image') throw new HttpError(404, 'IMAGE_TASK_NOT_FOUND', '图像任务不存在。');
    return value;
  }
  async function update(value: Reservation, state: ImageState, extra: Partial<Pick<Reservation, 'resultBlobId'>> = {}) {
    await database().db.update(reservations).set({ status: 'pending', usage: { imageTask: state }, updatedAt: now(), ...extra })
      .where(and(eq(reservations.id, value.id), inArray(reservations.status, ['held', 'pending'])));
  }
  async function start(request: Request) {
    sameOrigin(request); const current = await requireServiceIdentity(request);
    const input = imageTaskInput.parse(await readJson(request)), key = identifier.parse(request.headers.get('idempotency-key')),
      taskId = identifier.parse(request.headers.get('x-ccagent-task-id') || key);
    const requestHash = createHash('sha256').update(JSON.stringify(['images', input])).digest('hex');
    const [existing] = await database().db.select().from(reservations).where(and(eq(reservations.userId, current.user.id), eq(reservations.idempotencyKey, key))).limit(1);
    if (existing) {
      if (existing.keyId !== current.keyId || existing.routeId !== input.model || existing.requestHash !== requestHash || existing.taskId !== taskId) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同的调用。');
      return json(view(existing), 200);
    }
    const selected = await publishedRoute(input.model, 'image'); validateKieRoute(selected.route, input);
    const pricing = publicPricing(selected), expectedVersion = request.headers.get('x-ccagent-price-version'), expectedFingerprint = request.headers.get('x-ccagent-price-fingerprint');
    if (expectedVersion !== null && (!/^[1-9]\d{0,8}$/.test(expectedVersion) || Number(expectedVersion) !== pricing.version) || expectedFingerprint !== null && expectedFingerprint !== pricing.fingerprint) throw new HttpError(409, 'PRICE_CHANGED', '图像服务价格或配置已更新，请刷新目录并确认。');
    if (request.headers.has('x-ccagent-fallback-route')) throw new HttpError(400, 'IMAGE_FALLBACK_UNSUPPORTED', '异步图像任务不支持自动备用调用。');
    const configured = record(selected.route.options);
    if (input.input_images.length > Number(configured.maxImages ?? 16)) throw new HttpError(400, 'TOO_MANY_IMAGES', '参考图数量超过路由限制。');
    for (const reference of input.input_images) {
      const file = await metadata(current.user.id, z.string().uuid().parse(reference.slice('ccagent-file:'.length)), ['image']);
      if (file.size > 30 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.contentType)) throw new HttpError(400, 'INVALID_IMAGE', '参考图须为不超过 30 MB 的 PNG、JPEG 或 WebP。');
    }
    const route = { id: selected.route.id, provider: selected.route.provider, baseUrl: selected.route.baseUrl, credentialEnv: selected.route.credentialEnv, protocol: selected.route.protocol, upstreamModel: selected.route.upstreamModel };
    const image: ImageSnapshot = { route, resolution: input.resolution, parameters: { aspect_ratio: input.aspect_ratio, background: input.background }, definition: selected.definition, currency: selected.currency, usdCny: selected.usdCny };
    const at = now(), quote = quoteDefinition(image.definition, image.currency, quantities(input.resolution), at, image.usdCny ?? undefined);
    const secret = await resolveRouteCredential(route);
    const authorization = await authorizeUsage({ userId: current.user.id, keyId: current.keyId, routeId: input.model, taskId, idempotencyKey: key, requestHash,
      authorized: quote.chargeMicro > 0n ? quote.chargeMicro : 1n,
      priceSnapshot: { service: 'image', routeId: input.model, provider: route.provider, model: route.upstreamModel, protocol: route.protocol, priceId: selected.price.id, priceVersion: selected.price.version,
        sourceUrl: selected.price.sourceUrl, currency: image.currency, usdCny: image.usdCny, markup: '1.3', fingerprint: pricing.fingerprint, image } });
    if (authorization.replay) return json(view(authorization.reservation), 200);
    const value = authorization.reservation, client = createKieClient(secret, options.transport), controller = new AbortController(), timer = setTimeout(() => controller.abort(), selected.route.timeoutMs);
    let createSent = false, failureStage: ImageState['failureStage'];
    try {
      await update(value, { version: 1, status: 'queued' });
      const urls: string[] = [];
      for (const reference of input.input_images) {
        failureStage = 'read-reference';
        const file = await readFile(current.user.id, reference.slice('ccagent-file:'.length), ['image']);
        const bytes = await boundedImageBytes(new Response(file.stream), 30 * 1024 * 1024);
        failureStage = 'upload-reference';
        urls.push(await client.upload(bytes, file.record.contentType, `ccagent/${createHash('sha256').update(current.user.id).digest('hex').slice(0, 32)}/${value.id}`, controller.signal));
      }
      createSent = true;
      const result = await client.create(route.upstreamModel, input, urls, controller.signal);
      if (result.rejected) await settle({ userId: value.userId, reservationId: value.id, charged: 0n, release: true, usage: { imageTask: { version: 1, status: 'failed', code: 'IMAGE_SUPPLIER_REJECTED' } } });
      else await update(value, { version: 1, status: result.taskId ? 'queued' : 'unknown', ...(result.taskId ? { upstreamTaskId: result.taskId } : { code: 'IMAGE_CREATE_UNCONFIRMED' }) });
    } catch (error) {
      if (!createSent) {
        const failureCode = error instanceof HttpError && uploadFailureCodes.has(error.code) ? error.code : controller.signal.aborted ? 'IMAGE_UPLOAD_TIMEOUT' : 'IMAGE_INPUT_UNAVAILABLE';
        await settle({ userId: value.userId, reservationId: value.id, charged: 0n, release: true, usage: { imageTask: { version: 1, status: 'failed', code: 'IMAGE_INPUT_UPLOAD_FAILED', failureStage, failureCode } } });
      }
      else await update(value, { version: 1, status: 'unknown', code: 'IMAGE_CREATE_UNCONFIRMED' });
    } finally { clearTimeout(timer); }
    return json(view(await read(value.id, value.userId, value.keyId)), 202);
  }
  async function get(request: Request, id: string) {
    sameOrigin(request); const current = await requireServiceIdentity(request);
    z.string().uuid().parse(id); let value = await read(id, current.user.id, current.keyId), state = stateFor(value);
    if (['settled', 'released'].includes(value.status) || !state.upstreamTaskId) return json(view(value));
    if (value.reconcileAt <= now()) return json({ ...view(value), status: 'unknown', poll_after_ms: 0, code: 'IMAGE_RECONCILIATION_REQUIRED' });
    const image = record(value.priceSnapshot).image as ImageSnapshot;
    if (!image?.route || !image.resolution) throw new HttpError(503, 'IMAGE_SNAPSHOT_INVALID', '图像任务配置需要核验。');
    // Claim a bounded lease without holding a database transaction over supplier I/O.
    const lease = randomUUID(), leaseUntil = now().getTime() + 120_000;
    const [claimed] = await database().db.update(reservations).set({ usage: { imageTask: { ...state, leaseId: lease, leaseUntil } }, updatedAt: now() })
      .where(and(eq(reservations.id, value.id), inArray(reservations.status, ['held', 'pending']), sql`coalesce((${reservations.usage}->'imageTask'->>'leaseUntil')::bigint, 0) < ${now().getTime()}`)).returning();
    if (!claimed) { const latest = await read(value.id, value.userId, value.keyId); return json(['settled', 'released'].includes(latest.status) ? view(latest) : { ...view(latest), status: 'processing', poll_after_ms: 2500 }); }
    value = claimed; state = stateFor(value);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 65_000);
    let completedState: ImageState | undefined;
    try {
      if (state.status === 'succeeded' && state.images?.length) {
        completedState = state;
        const quote = quoteDefinition(image.definition, image.currency, quantities(image.resolution), value.createdAt, image.usdCny ?? undefined);
        await settle({ userId: value.userId, reservationId: value.id, charged: quote.chargeMicro > value.authorized ? value.authorized : quote.chargeMicro,
          usage: { imageTask: { ...state, leaseId: undefined, leaseUntil: undefined }, quantities: Object.fromEntries(Object.entries(quantities(image.resolution)).map(([name, quantity]) => [name, quantity.toString()])), publicCostMicro: quote.publicCostMicro.toString(), calculatedChargeMicro: quote.chargeMicro.toString() } });
        return json(view(await read(value.id, value.userId, value.keyId)));
      }
      const secret = await resolveRouteCredential(image.route), client = createKieClient(secret, options.transport), result = await client.query(state.upstreamTaskId!, controller.signal, { model: image.route.upstreamModel, resolution: image.resolution });
      if (result.state === 'fail') {
        await settle({ userId: value.userId, reservationId: value.id, charged: 0n, release: true, usage: { imageTask: { version: 1, status: 'failed', code: 'IMAGE_GENERATION_FAILED', upstreamTaskId: state.upstreamTaskId } } });
      } else if (result.state !== 'success') {
        await update(value, { version: 1, status: result.state === 'generating' ? 'processing' : 'queued', upstreamTaskId: state.upstreamTaskId });
      } else {
        const expectedCredits = { '1K': 6, '2K': 10, '4K': 16 }[image.resolution];
        if (result.credits !== undefined && result.credits !== expectedCredits) throw new Error('IMAGE_USAGE_UNCONFIRMED');
        const images: ImageResult[] = [];
        for (const url of result.urls) {
          const downloaded = await client.download(url, controller.signal), saved = await saveResult(value.userId, downloaded.data, downloaded.mime);
          images.push({ file_id: saved.id, mime_type: downloaded.mime, expires_at: saved.expiresAt.toISOString() });
        }
        const quote = quoteDefinition(image.definition, image.currency, quantities(image.resolution), value.createdAt, image.usdCny ?? undefined);
        const charge = quote.chargeMicro > value.authorized ? value.authorized : quote.chargeMicro;
        const completed: ImageState = { version: 1, status: 'succeeded', upstreamTaskId: state.upstreamTaskId, images, ...(result.credits === undefined ? {} : { credits: result.credits }) };
        await update(value, { ...completed, leaseId: lease, leaseUntil }, { resultBlobId: images[0]!.file_id });
        completedState = completed;
        await settle({ userId: value.userId, reservationId: value.id, charged: charge, usage: { imageTask: completed,
          quantities: Object.fromEntries(Object.entries(quantities(image.resolution)).map(([name, quantity]) => [name, quantity.toString()])), publicCostMicro: quote.publicCostMicro.toString(), calculatedChargeMicro: quote.chargeMicro.toString() } });
      }
    } catch {
      // Query/download failures do not prove generation failed and never create another supplier job.
      await update(value, completedState ? { ...completedState, leaseId: undefined, leaseUntil: undefined } : { version: 1, status: 'unknown', upstreamTaskId: state.upstreamTaskId, code: 'IMAGE_RESULT_UNCONFIRMED' });
    } finally { clearTimeout(timer); }
    return json(view(await read(value.id, value.userId, value.keyId)));
  }
  return { async start(request: Request) { try { return await start(request); } catch (error) { return errorResponse(error); } },
    async get(request: Request, id: string) { try { return await get(request, id); } catch (error) { return errorResponse(error); } } };
}
