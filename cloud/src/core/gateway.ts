import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { applyRequestPricing, publishedRoute, publicPricing, quoteDefinition, routeInput, selectedTariff, type UsageMetric } from './catalog';
import { database } from './db';
import { reservations, routes } from './db/schema';
import { readOwnedFile, savePrivateResult } from './files';
import { errorResponse, HttpError, readJson, requireSameOrigin } from './http';
import { requireServiceIdentity } from './keys';
import { measuredUsage, object, prepareUpstream, UsageStream, voiceDownloadUrl, type GatewayEndpoint } from './upstream';
import { upstreamTransportFailure, type UpstreamTransportFailure } from './upstream-failure';
import { authorizeUsage, finishUsage } from './wallet';
import { availableServiceDefaults, readServiceDefaults } from './service-defaults';
import { callIdentifierPattern } from './call-identifiers';
import { resolveRouteCredential } from './provider-credentials';
import { requestUpstream } from './upstream-hosts';

const id = z.string().regex(callIdentifierPattern);
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
async function resolveImages(input: unknown, userId: string, maximum: number, files = new Map<string, string>()) {
  let count = 0, imageParts = 0;
  const visit = async (value: unknown, depth: number): Promise<unknown> => {
    if (depth > 40) throw new HttpError(400, 'INPUT_TOO_DEEP', '请求嵌套层级过深。');
    if (typeof value === 'string' && value.startsWith('ccagent-file:')) {
      if (++count > maximum) throw new HttpError(400, 'TOO_MANY_IMAGES', '图片数量超出路由限制。');
      const reference = z.string().uuid().parse(value.slice('ccagent-file:'.length));
      if (!files.has(reference)) {
        const file = await readOwnedFile(userId, reference, ['image']);
        files.set(reference, `data:${file.record.contentType};base64,${Buffer.from(await new Response(file.stream).arrayBuffer()).toString('base64')}`);
      }
      return files.get(reference)!;
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
export function maximumQuantities(selection: Selection, input: Record<string, unknown>, body: Record<string, unknown>) {
  const options = routeInput.shape.options.parse(selection.route.options), result: Partial<Record<UsageMetric, bigint>> = {};
  // Reserve a documented upper budget; actual measured usage, never this budget, determines the bill.
  const thinking = selection.definition.tariff.kind === 'qwen-input-tiers' && body.enable_thinking === true ? BigInt(selection.definition.tariff.maxThinkingTokens) : 0n;
  const output = BigInt(Number(body.max_output_tokens ?? body.max_tokens ?? options.maxOutputTokens)) + thinking;
  const serialized = JSON.stringify(body);
  const containsImage = /"(?:input_image|image_url|input_audio|video_url)"|ccagent-file:/.test(serialized);
  const textBound = BigInt(Buffer.byteLength(serialized, 'utf8')) * 2n + 1024n;
  const inputBound = containsImage || textBound > BigInt(options.contextWindow) ? BigInt(options.contextWindow) : textBound;
  for (const rate of selection.definition.rates) result[rate.metric] = rate.metric === 'requests' ? 1n : rate.metric === 'search_credits' ? 2n
    : rate.metric === 'output_tokens' || rate.metric === 'audio_output_tokens' ? output
    : rate.metric === 'input_characters' ? BigInt(Array.from(String(input.text || '')).length) : inputBound;
  return result;
}
function snapshot(selection: Selection, at: Date, body: Record<string, unknown>) {
  return { routeId: selection.route.id, provider: selection.route.provider, model: selection.route.upstreamModel, protocol: selection.route.protocol,
    priceId: selection.price.id, priceVersion: selection.price.version, sourceUrl: selection.price.sourceUrl, definition: selection.definition,
    currency: selection.currency, usdCny: selection.usdCny, markup: '1.3', tariffAt: at.toISOString(), fingerprint: publicPricing(selection).fingerprint,
    ...(selection.definition.tariff.kind === 'qwen-input-tiers' ? { thinking: body.enable_thinking } : {}) };
}
function fallbackConsent(headers: Headers) {
  const route = headers.get('x-ccagent-fallback-route'), version = headers.get('x-ccagent-fallback-price-version'), fingerprint = headers.get('x-ccagent-fallback-price-fingerprint');
  if (route === null && version === null && fingerprint === null) return null;
  const primaryVersion = headers.get('x-ccagent-price-version'), primaryFingerprint = headers.get('x-ccagent-price-fingerprint');
  if (!route || !/^[a-z0-9][a-z0-9._:-]{0,79}$/.test(route) || !version || !/^[1-9]\d{0,8}$/.test(version) || !fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint)
    || !primaryVersion || !/^[1-9]\d{0,8}$/.test(primaryVersion) || !primaryFingerprint || !/^[a-f0-9]{64}$/.test(primaryFingerprint)) {
    throw new HttpError(400, 'INVALID_FALLBACK_CONSENT', '备用调用需要明确确认主、备用路由的价格版本与结算信息。');
  }
  return { routeId: route, version: Number(version), fingerprint, primaryVersion: Number(primaryVersion), primaryFingerprint };
}

export function createGateway(options: { fetch?: typeof fetch; keepAlive?: (work: Promise<void>) => void; now?: () => Date } = {}) {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  async function replay(userId: string, reservation: typeof reservations.$inferSelect) {
    if (!['settled', 'released'].includes(reservation.status)) throw new HttpError(409, 'CALL_IN_PROGRESS', '同一调用正在执行或等待用量核验，请查询调用记录。');
    if (!reservation.resultBlobId) throw new HttpError(409, 'RESULT_UNAVAILABLE', '该调用已处理，结果暂不可重放；不会重复请求供应商。');
    const file = await readOwnedFile(userId, reservation.resultBlobId, ['result']);
    const usage = object(reservation.usage), actual = typeof usage.executedRouteId === 'string' && /^[a-z0-9][a-z0-9._:-]{0,79}$/.test(usage.executedRouteId) ? usage.executedRouteId : reservation.routeId;
    return new Response(file.stream, { headers: { 'content-type': file.record.contentType, 'cache-control': 'no-store', 'x-ccagent-call-id': reservation.id, 'x-ccagent-replay': 'true',
      'x-ccagent-route-id': actual, 'x-ccagent-fallback': String(usage.fallbackUsed === true) } });
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
    const consent = fallbackConsent(request.headers);
    const requestHash = createHash('sha256').update(JSON.stringify(canonical({ endpoint, input, ...(consent ? { fallback: consent } : {}) }))).digest('hex');
    const [existing] = await database().db.select().from(reservations).where(and(eq(reservations.userId, current.user.id), eq(reservations.idempotencyKey, idempotencyKey))).limit(1);
    if (existing) {
      if (existing.keyId !== current.keyId || existing.routeId !== routeId || existing.requestHash !== requestHash || existing.taskId !== taskId) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同的调用。');
      return replay(current.user.id, existing);
    }
    const selection = await publishedRoute(routeId);
    const expectedPrice = request.headers.get('x-ccagent-price-version');
    if (expectedPrice !== null) {
      if (!/^[1-9]\d{0,8}$/.test(expectedPrice)) throw new HttpError(400, 'INVALID_PRICE_VERSION', '价格版本无效。');
      if (Number(expectedPrice) !== selection.price.version) throw new HttpError(409, 'PRICE_CHANGED', '服务价格已更新，请刷新目录并核对后再调用。');
    }
    const expectedFingerprint = request.headers.get('x-ccagent-price-fingerprint');
    if (expectedFingerprint !== null && !/^[a-f0-9]{64}$/.test(expectedFingerprint)) throw new HttpError(400, 'INVALID_PRICE_FINGERPRINT', '价格确认信息无效。');
    if (expectedFingerprint !== null && expectedFingerprint !== publicPricing(selection).fingerprint) throw new HttpError(409, 'PRICE_CHANGED', '服务价格、限制或结算汇率已更新，请刷新目录并核对后再调用。');
    const selections = [selection], primaryOptions = routeInput.shape.options.parse(selection.route.options);
    if (consent) {
      if (!primaryOptions.fallbackEnabled || primaryOptions.fallbackRouteId !== consent.routeId || consent.routeId === routeId) throw new HttpError(409, 'FALLBACK_CHANGED', '管理员备用配置已改变，请刷新目录并重新确认。');
      let backup: Selection;
      try { backup = await publishedRoute(consent.routeId, selection.route.service); }
      catch { throw new HttpError(409, 'FALLBACK_NOT_READY', '已确认的备用路由当前不可用，请刷新目录并核对。'); }
      if (backup.route.protocol !== selection.route.protocol) throw new HttpError(409, 'INCOMPATIBLE_FALLBACK', '备用协议与原请求不兼容。');
      if (backup.price.version !== consent.version || publicPricing(backup).fingerprint !== consent.fingerprint) throw new HttpError(409, 'FALLBACK_PRICE_CHANGED', '备用价格、限制或结算汇率已更新，请刷新目录并重新确认。');
      selections.push(backup);
    }
    // Validate both possible requests and all owner-bound files before freezing any funds.
    const imageFiles = new Map<string, string>();
    const plans = [];
    for (const selected of selections) {
      const { createdAt: _created, updatedAt: _updated, ...value } = selected.route;
      const parsed = routeInput.parse(value), prepared = prepareUpstream(endpoint, input, parsed);
      prepared.body = applyRequestPricing(selected.definition, prepared.body);
      const secret = await resolveRouteCredential(selected.route);
      if (endpoint === 'responses') prepared.body.prompt_cache_key = `ccagent:${createHash('sha256').update(current.user.id).digest('hex').slice(0, 32)}:${typeof input.prompt_cache_key === 'string' ? input.prompt_cache_key.slice(0, 100) : 'default'}`;
      plans.push({ selection: selected, prepared, body: await resolveImages(prepared.body, current.user.id, parsed.options.maxImages, imageFiles), secret });
    }
    const primary = plans[0]!; let active = primary, attempted = primary;
    const at = now(); let attemptedAt = at;
    let maximum = 1n;
    for (const plan of plans) {
      const quote = quoteDefinition(plan.selection.definition, plan.selection.currency, maximumQuantities(plan.selection, input, plan.prepared.body), at, plan.selection.usdCny || undefined, true, plan.prepared.body);
      if (quote.chargeMicro > maximum) maximum = quote.chargeMicro;
    }
    const authorized = await authorizeUsage({ userId: current.user.id, keyId: current.keyId, routeId, taskId, idempotencyKey, requestHash,
      authorized: maximum, priceSnapshot: { ...snapshot(selection, at, primary.prepared.body), ...(consent ? { fallback: snapshot(selections[1]!, at, plans[1]!.prepared.body), fallbackConsent: consent } : {}) } });
    if (authorized.replay) return replay(current.user.id, authorized.reservation);
    const reservation = authorized.reservation;
    const secrets = [...new Set(plans.map(plan => plan.secret))], secretLength = Math.max(...secrets.map(secret => secret.length));
    const redact = (text: string) => secrets.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), text);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), selection.route.timeoutMs);
    let backupTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = () => { clearTimeout(timer); if (backupTimer) clearTimeout(backupTimer); };
    const execution = () => ({ executedRouteId: attempted.selection.route.id, executedPriceId: attempted.selection.price.id, executedPriceVersion: attempted.selection.price.version,
      executionStartedAt: attemptedAt.toISOString(), fallbackUsed: attempted !== primary });
    let attempts = 0;
    let transportFailure: UpstreamTransportFailure | undefined;
    const pending = async (reason: string) => {
      await database().db.update(reservations).set({ status: 'pending', usage: { reason, attempts, ...(transportFailure ? { transportFailure } : {}), platformRetryCosts: Math.max(0, attempts - 1), ...execution() }, updatedAt: new Date() })
        .where(and(eq(reservations.id, reservation.id), eq(reservations.status, 'held')));
    };
    const complete = async (payload: unknown, raw: Uint8Array | string, contentType: string, interrupted = false) => {
      const selected = active.selection;
      const quantities = measuredUsage(selected.route.protocol, payload, selected.definition.rates.map(rate => rate.metric));
      const usage = { quantities: quantities && Object.fromEntries(Object.entries(quantities).map(([name, value]) => [name, value!.toString()])),
        attempts, platformRetryCosts: Math.max(0, attempts - 1), interrupted, ...execution() };
      let resultId: string | null = null;
      try { resultId = (await savePrivateResult(current.user.id, raw, contentType)).id; }
      catch { /* A failed result upload never repeats the supplier call or prevents settlement. */ }
      if (resultId) await database().db.update(reservations).set({ resultBlobId: resultId }).where(eq(reservations.id, reservation.id));
      if (!quantities) { await pending('supplier_usage_unmeasured'); return; }
      const quote = quoteDefinition(selected.definition, selected.currency, quantities, attemptedAt, selected.usdCny || undefined, false, active.prepared.body);
      const charged = quote.chargeMicro > reservation.authorized ? reservation.authorized : quote.chargeMicro;
      await finishUsage({ userId: current.user.id, reservationId: reservation.id, charged,
        usage: { ...usage, publicCostMicro: quote.publicCostMicro.toString(), calculatedChargeMicro: quote.chargeMicro.toString(),
          platformAbsorbedMicro: (quote.chargeMicro - charged).toString(), tariff: quote.tariff, ...(quote.priceTier ? { priceTier: quote.priceTier } : {}) } });
    };
    let response: Response | undefined;
    try {
      for (const [index, plan] of plans.entries()) {
        active = plan;
        if (index) backupTimer = setTimeout(() => controller.abort(), plan.selection.route.timeoutMs);
        let phaseAttempts = 0;
        while (true) {
          const startedAt = now(); selectedTariff(plan.selection.definition, startedAt);
          attempted = plan; attemptedAt = startedAt;
          attempts++; phaseAttempts++;
          try {
            const result = await requestUpstream(plan.prepared.url, { method: 'POST', headers: { authorization: `Bearer ${plan.secret}`, 'content-type': 'application/json' },
              body: JSON.stringify(plan.body), signal: controller.signal, redirect: 'error' }, fetcher);
            transportFailure = undefined;
            if ((result.status === 429 || result.status >= 500) && !controller.signal.aborted) {
              if (phaseAttempts <= plan.selection.route.retries) { await result.body?.cancel(); continue; }
              if (index + 1 < plans.length) { await result.body?.cancel(); break; }
            }
            response = result; break;
          } catch (error) {
            transportFailure = upstreamTransportFailure(error, controller.signal.aborted);
            if (controller.signal.aborted) throw new Error('UPSTREAM_TRANSPORT_FAILED');
            if (phaseAttempts <= plan.selection.route.retries) continue;
            if (index + 1 < plans.length) break;
            throw new Error('UPSTREAM_TRANSPORT_FAILED');
          }
        }
        if (response) break;
      }
      if (!response) throw new Error('UPSTREAM_RESPONSE_MISSING');
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status >= 400 && response.status < 500 && response.status !== 408) await finishUsage({ userId: current.user.id, reservationId: reservation.id, charged: 0n, release: true, usage: { reason: 'supplier_rejected', attempts, ...execution() } });
        else await pending('supplier_http_unknown');
        throw new HttpError(502, 'UPSTREAM_REQUEST_FAILED', '供应商暂未完成请求，请查看调用状态后重试。');
      }
      if (!active.prepared.streaming) {
        const raw = redact(Buffer.from(await bytes(response)).toString('utf8'));
        const payload: unknown = JSON.parse(raw);
        if (object(payload).error || object(payload).code && !['200'].includes(String(object(payload).code))) {
          await finishUsage({ userId: current.user.id, reservationId: reservation.id, charged: 0n, release: true, usage: { reason: 'supplier_application_rejected', attempts, ...execution() } });
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
        return new Response(returned, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-ccagent-call-id': reservation.id,
          'x-ccagent-route-id': active.selection.route.id, 'x-ccagent-fallback': String(active !== primary) } });
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
                retained = redact(retained + decoder.decode(item.value, { stream: true }));
                const cut = Math.max(0, retained.length - secretLength);
                emit(retained.slice(0, cut)); retained = retained.slice(cut);
              }
              emit(redact(retained + decoder.decode()));
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
            } finally { clearTimers(); reader.releaseLock(); }
          })();
          options.keepAlive?.(work);
        },
        cancel() { detached = true; /* Continue bounded upstream reading to obtain real final usage. */ },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no', 'x-ccagent-call-id': reservation.id,
        'x-ccagent-route-id': active.selection.route.id, 'x-ccagent-fallback': String(active !== primary) } });
    } catch (error) {
      clearTimers(); controller.abort();
      try {
        if (!attempts) await finishUsage({ userId: current.user.id, reservationId: reservation.id, charged: 0n, release: true, usage: { reason: 'request_not_sent', attempts } });
        else await pending('supplier_result_unknown');
      } catch {}
      throw error instanceof HttpError ? error : new HttpError(502, 'UPSTREAM_UNAVAILABLE', '服务暂未完成请求，冻结额度将等待核验，请查看调用记录。');
    } finally { if (!active.prepared.streaming) clearTimers(); }
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
        protocol: selected.route.protocol, pricing: publicPricing(selected), limits: routeInput.shape.options.parse(selected.route.options) });
    } catch { /* Unready services are never sold through discovery. */ }
  }
  const configured = await readServiceDefaults();
  return { object: 'list', data, defaults: availableServiceDefaults(configured.routes, data) };
}
