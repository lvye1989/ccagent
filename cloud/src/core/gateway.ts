import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { publishedRoute, quoteDefinition, routeInput, type UsageMetric } from './catalog';
import { database } from './db';
import { reservations, routes } from './db/schema';
import { readOwnedFile, savePrivateResult } from './files';
import { errorResponse, HttpError, readJson, requireSameOrigin } from './http';
import { requireServiceIdentity } from './keys';
import { measuredUsage, object, prepareUpstream, UsageStream, voiceDownloadUrl, type GatewayEndpoint } from './upstream';
import { authorizeUsage, finishUsage } from './wallet';

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);
const maximumResult = 64 * 1024 * 1024;
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 40) throw new HttpError(400, 'INPUT_TOO_DEEP', '请求嵌套层级过深。');
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item, depth + 1)]));
  return value;
}
async function requestInput(request: Request, userId: string) {
  let input = object(await readJson(request, 3 * 1024 * 1024));
  if (input.request_file_id !== undefined) {
    const reference = z.object({ request_file_id: z.string().uuid() }).strict().parse(input);
    const file = await readOwnedFile(userId, reference.request_file_id, ['request']);
    try { input = object(JSON.parse(await new Response(file.stream).text())); }
    catch { throw new HttpError(400, 'INVALID_FILE_JSON', '请求文件格式无效。'); }
  }
  return input;
}
async function resolveImages(input: unknown, userId: string, maximum: number) {
  let count = 0, imageParts = 0;
  const visit = async (value: unknown, depth: number): Promise<unknown> => {
    if (depth > 40) throw new HttpError(400, 'INPUT_TOO_DEEP', '请求嵌套层级过深。');
    if (typeof value === 'string' && value.startsWith('ccagent-file:')) {
      if (++count > maximum) throw new HttpError(400, 'TOO_MANY_IMAGES', '图片数量超出路由限制。');
      const reference = z.string().uuid().parse(value.slice('ccagent-file:'.length));
      const file = await readOwnedFile(userId, reference, ['image']);
      return `data:${file.record.contentType};base64,${Buffer.from(await new Response(file.stream).arrayBuffer()).toString('base64')}`;
    }
    if (Array.isArray(value)) { const result = []; for (const item of value) result.push(await visit(item, depth + 1)); return result; }
    if (value && typeof value === 'object') {
      if (['image_url', 'input_image'].includes(String(object(value).type)) && ++imageParts > maximum) throw new HttpError(400, 'TOO_MANY_IMAGES', '图片数量超出路由限制。');
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>; for (const [key, item] of Object.entries(value)) result[key] = await visit(item, depth + 1); return result;
    }
    return value;
  };
  return visit(input, 0);
}
async function bytes(response: Response, limit = maximumResult): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('UPSTREAM_BODY_MISSING');
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.length;
      if (size > limit) { await reader.cancel(); throw new Error('UPSTREAM_BODY_TOO_LARGE'); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
type Selection = Awaited<ReturnType<typeof publishedRoute>>;
function maximumQuantities(selection: Selection, input: Record<string, unknown>, body: Record<string, unknown>) {
  const options = routeInput.shape.options.parse(selection.route.options), result: Partial<Record<UsageMetric, bigint>> = {};
  // Reserve a documented upper budget; actual measured usage, never this budget, determines the bill.
  const output = BigInt(Number(body.max_output_tokens ?? body.max_tokens ?? options.maxOutputTokens));
  const serialized = JSON.stringify(body);
  const containsImage = /"(?:input_image|image_url|input_audio|video_url)"|ccagent-file:/.test(serialized);
  const textBound = BigInt(Buffer.byteLength(serialized, 'utf8')) * 2n + 1024n;
  const inputBound = containsImage || textBound > BigInt(options.contextWindow) ? BigInt(options.contextWindow) : textBound;
  for (const rate of selection.definition.rates) result[rate.metric] = rate.metric === 'requests' ? 1n : rate.metric === 'search_credits' ? 2n
    : rate.metric === 'output_tokens' || rate.metric === 'audio_output_tokens' ? output
    : rate.metric === 'input_characters' ? BigInt(Array.from(String(input.text || '')).length) : inputBound;
  return result;
}
function snapshot(selection: Selection, at: Date) {
  return { routeId: selection.route.id, provider: selection.route.provider, model: selection.route.upstreamModel, protocol: selection.route.protocol,
    priceId: selection.price.id, priceVersion: selection.price.version, sourceUrl: selection.price.sourceUrl, definition: selection.definition,
    currency: selection.currency, usdCny: selection.usdCny, markup: '1.3', tariffAt: at.toISOString() };
}

export function createGateway(options: { fetch?: typeof fetch; keepAlive?: (work: Promise<void>) => void } = {}) {
  const fetcher = options.fetch ?? fetch;
  async function replay(userId: string, reservation: typeof reservations.$inferSelect) {
    if (!['settled', 'released'].includes(reservation.status)) throw new HttpError(409, 'CALL_IN_PROGRESS', '同一调用正在执行或等待用量核验，请查询调用记录。');
    if (!reservation.resultBlobId) throw new HttpError(409, 'RESULT_UNAVAILABLE', '该调用已处理，结果暂不可重放；不会重复请求供应商。');
    const file = await readOwnedFile(userId, reservation.resultBlobId, ['result']);
    return new Response(file.stream, { headers: { 'content-type': file.record.contentType, 'cache-control': 'no-store', 'x-ccagent-call-id': reservation.id, 'x-ccagent-replay': 'true' } });
  }
  async function execute(request: Request, endpoint: GatewayEndpoint): Promise<Response> {
    // Browser requests must come from this application; native clients use the signed session cookie.
    if (request.headers.has('origin')) requireSameOrigin(request);
    if (request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'INVALID_ORIGIN', '请求来源无效。');
    const current = await requireServiceIdentity(request);
    const input = await requestInput(request, current.user.id);
    const routeId = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,79}$/).parse(input.model);
    const idempotencyKey = id.parse(request.headers.get('idempotency-key'));
    const taskId = id.parse(request.headers.get('x-ccagent-task-id') || idempotencyKey);
    const requestHash = createHash('sha256').update(JSON.stringify(canonical({ endpoint, input }))).digest('hex');
    const [existing] = await database().db.select().from(reservations).where(and(eq(reservations.userId, current.user.id), eq(reservations.idempotencyKey, idempotencyKey))).limit(1);
    if (existing) {
      if (existing.keyId !== current.keyId || existing.routeId !== routeId || existing.requestHash !== requestHash || existing.taskId !== taskId) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同的调用。');
      return replay(current.user.id, existing);
    }
    const selection = await publishedRoute(routeId);
    const { createdAt: _created, updatedAt: _updated, ...routeValue } = selection.route;
    const parsedRoute = routeInput.parse(routeValue);
    // Validate the complete request and all owner-bound files before freezing any funds.
    const prepared = prepareUpstream(endpoint, input, parsedRoute);
    if (endpoint === 'responses') prepared.body.prompt_cache_key = `ccagent:${createHash('sha256').update(current.user.id).digest('hex').slice(0, 32)}:${typeof input.prompt_cache_key === 'string' ? input.prompt_cache_key.slice(0, 100) : 'default'}`;
    const resolvedBody = await resolveImages(prepared.body, current.user.id, parsedRoute.options.maxImages);
    const at = new Date();
    const budget = quoteDefinition(selection.definition, selection.currency, maximumQuantities(selection, input, prepared.body), at, selection.usdCny || undefined, true);
    const authorized = await authorizeUsage({ userId: current.user.id, keyId: current.keyId, routeId, taskId, idempotencyKey, requestHash,
      authorized: budget.chargeMicro > 0n ? budget.chargeMicro : 1n, priceSnapshot: snapshot(selection, at) });
    if (authorized.replay) return replay(current.user.id, authorized.reservation);
    const reservation = authorized.reservation, secret = process.env[selection.route.credentialEnv]!;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), selection.route.timeoutMs);
    let attempts = 0;
    const pending = async (reason: string) => {
      await database().db.update(reservations).set({ status: 'pending', usage: { reason, attempts, platformRetryCosts: Math.max(0, attempts - 1) }, updatedAt: new Date() })
        .where(and(eq(reservations.id, reservation.id), eq(reservations.status, 'held')));
    };
    const complete = async (payload: unknown, raw: Uint8Array | string, contentType: string, interrupted = false) => {
      const quantities = measuredUsage(selection.route.protocol, payload, selection.definition.rates.map(rate => rate.metric));
      const usage = { quantities: quantities && Object.fromEntries(Object.entries(quantities).map(([name, value]) => [name, value!.toString()])),
        attempts, platformRetryCosts: Math.max(0, attempts - 1), interrupted };
      let resultId: string | null = null;
      try { resultId = (await savePrivateResult(current.user.id, raw, contentType)).id; }
      catch { /* A failed result upload never repeats the supplier call or prevents settlement. */ }
      if (resultId) await database().db.update(reservations).set({ resultBlobId: resultId }).where(eq(reservations.id, reservation.id));
      if (!quantities) { await pending('supplier_usage_unmeasured'); return; }
      const quote = quoteDefinition(selection.definition, selection.currency, quantities, at, selection.usdCny || undefined);
      const charged = quote.chargeMicro > reservation.authorized ? reservation.authorized : quote.chargeMicro;
      await finishUsage({ userId: current.user.id, reservationId: reservation.id, charged,
        usage: { ...usage, publicCostMicro: quote.publicCostMicro.toString(), calculatedChargeMicro: quote.chargeMicro.toString(),
          platformAbsorbedMicro: (quote.chargeMicro - charged).toString(), tariff: quote.tariff } });
    };
    let response: Response;
    try {
      while (true) {
        attempts++;
        try {
          response = await fetcher(prepared.url, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
            body: JSON.stringify(resolvedBody), signal: controller.signal, redirect: 'error' });
          if ((response.status === 429 || response.status >= 500) && attempts <= selection.route.retries && !controller.signal.aborted) { await response.body?.cancel(); continue; }
          break;
        } catch {
          if (attempts > selection.route.retries || controller.signal.aborted) throw new Error('UPSTREAM_TRANSPORT_FAILED');
        }
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status >= 400 && response.status < 500 && response.status !== 408) await finishUsage({ userId: current.user.id, reservationId: reservation.id, charged: 0n, release: true, usage: { reason: 'supplier_rejected', attempts } });
        else await pending('supplier_http_unknown');
        throw new HttpError(502, 'UPSTREAM_REQUEST_FAILED', '供应商暂未完成请求，请查看调用状态后重试。');
      }
      if (!prepared.streaming) {
        const raw = Buffer.from(await bytes(response)).toString('utf8').replaceAll(secret, '[redacted]');
        const payload: unknown = JSON.parse(raw);
        if (object(payload).error || object(payload).code && !['200'].includes(String(object(payload).code))) {
          await finishUsage({ userId: current.user.id, reservationId: reservation.id, charged: 0n, release: true, usage: { reason: 'supplier_application_rejected', attempts } });
          throw new HttpError(502, 'UPSTREAM_REQUEST_FAILED', '供应商未能完成请求。');
        }
        let returned = raw;
        if (endpoint === 'voice') {
          const url = voiceDownloadUrl(object(object(object(payload).output).audio).url);
          const download = await fetcher(url, { signal: controller.signal, redirect: 'error' });
          if (!download.ok) throw new Error('AUDIO_DOWNLOAD_FAILED');
          const audio = await bytes(download, 50 * 1024 * 1024);
          if (Buffer.from(audio.subarray(0, 4)).toString() !== 'RIFF' || Buffer.from(audio.subarray(8, 12)).toString() !== 'WAVE') throw new Error('AUDIO_FORMAT_MISMATCH');
          const saved = await savePrivateResult(current.user.id, audio, 'audio/wav', 'voice-result');
          returned = JSON.stringify({ model: routeId, audio: { file_id: saved.id, content_type: 'audio/wav', bytes: audio.length, expires_at: saved.expiresAt.toISOString() }, usage: object(payload).usage });
        }
        await complete(payload, returned, 'application/json');
        return new Response(returned, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-ccagent-call-id': reservation.id } });
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('UPSTREAM_STREAM_INVALID');
      const reader = response.body.getReader(), statistics = new UsageStream(), decoder = new TextDecoder(), encoder = new TextEncoder();
      let detached = false, retained = '', size = 0;
      const result: Uint8Array[] = [];
      const stream = new ReadableStream<Uint8Array>({
        start(destination) {
          const emit = (text: string) => {
            if (!text) return;
            const chunk = encoder.encode(text); result.push(chunk); statistics.push(chunk);
            if (!detached) { try { destination.enqueue(chunk); } catch { detached = true; } }
          };
          const work = (async () => {
            try {
              while (true) {
                const item = await reader.read(); if (item.done) break;
                size += item.value.length; if (size > maximumResult) throw new Error('UPSTREAM_RESULT_TOO_LARGE');
                retained = (retained + decoder.decode(item.value, { stream: true })).replaceAll(secret, '[redacted]');
                const cut = Math.max(0, retained.length - secret.length);
                emit(retained.slice(0, cut)); retained = retained.slice(cut);
              }
              emit((retained + decoder.decode()).replaceAll(secret, '[redacted]'));
              statistics.push(new Uint8Array(), true);
              await complete(statistics.usage, Buffer.concat(result), 'text/event-stream', detached || !statistics.terminal || statistics.failed);
              if (!detached) destination.close();
            } catch {
              controller.abort();
              try {
                if (statistics.usage) await complete(statistics.usage, Buffer.concat(result), 'text/event-stream', true);
                else await pending('stream_interrupted_without_verified_usage');
              } catch { /* The 24h maintenance job also finds the original held reservation. */ }
              if (!detached) { try { destination.error(new Error('服务连接中断，请查看调用记录。')); } catch {} }
            } finally { clearTimeout(timer); reader.releaseLock(); }
          })();
          options.keepAlive?.(work);
        },
        cancel() { detached = true; /* Continue bounded upstream reading to obtain real final usage. */ },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no', 'x-ccagent-call-id': reservation.id } });
    } catch (error) {
      clearTimeout(timer); controller.abort();
      try { await pending('supplier_result_unknown'); } catch {}
      throw error instanceof HttpError ? error : new HttpError(502, 'UPSTREAM_UNAVAILABLE', '服务暂未完成请求，冻结额度将等待核验，请查看调用记录。');
    } finally { if (!prepared.streaming) clearTimeout(timer); }
  }
  return { execute: async (request: Request, endpoint: GatewayEndpoint) => { try { return await execute(request, endpoint); } catch (error) { return errorResponse(error); } } };
}

export async function availableModels(request: Request) {
  await requireServiceIdentity(request);
  const candidates = await database().db.select({ id: routes.id }).from(routes).where(eq(routes.enabled, true));
  const data = [];
  for (const item of candidates) {
    try {
      const selected = await publishedRoute(item.id);
      data.push({ id: selected.route.id, object: 'model', owned_by: 'ccagent', name: selected.route.name, service: selected.route.service,
        protocol: selected.route.protocol, pricing: { currency: selected.currency, definition: selected.definition, markup: '1.3', usdCny: selected.usdCny,
          version: selected.price.version, sourceUrl: selected.price.sourceUrl }, limits: routeInput.shape.options.parse(selected.route.options) });
    } catch { /* Unready services are never sold through discovery. */ }
  }
  return { object: 'list', data };
}
