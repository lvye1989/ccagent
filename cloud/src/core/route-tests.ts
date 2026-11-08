import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requirePermission } from './auth';
import { applyRequestPricing, publicPricing, quoteDefinition, routeInput, selectedTariff, testableRoute } from './catalog';
import { database } from './db';
import { audit } from './db/schema';
import { lockAdministration } from './database-locks';
import { maximumQuantities } from './gateway';
import { errorResponse, HttpError, json, readJson, requireSameOrigin } from './http';
import { measuredUsage, object, prepareUpstream, voiceDownloadUrl, type GatewayEndpoint } from './upstream';
import { resolveRouteCredential } from './provider-credentials';
import { requestUpstream } from './upstream-hosts';

const routeId = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,79}$/), fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const submission = z.object({ routeId, testId: z.string().uuid(), confirmationFingerprint: fingerprint, confirmPlatformCost: z.literal(true) }).strict();
const startAction = 'routes.test.start', resultAction = 'routes.test.result', staleMs = 5 * 60_000;
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwJfETAYztCH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBZ22g4uTA8dYAAAAASUVORK5CYII=';
type Selection = Awaited<ReturnType<typeof testableRoute>>;
export type RouteTestResult = {
  id: string; routeId: string; status: 'running' | 'succeeded' | 'failed' | 'unknown'; startedAt: string; completedAt?: string; durationMs?: number;
  service: string; protocol: string; priceVersion: number; estimatedPublicCostMicro: string; publicCostMicro: string | null; platformPaid: true; userChargeMicro: '0';
  provider: string; upstreamModel: string; pricing: ReturnType<typeof publicPricing>; requestSent: boolean | null; executionStartedAt?: string; estimateExceeded?: boolean;
  confirmationFingerprint: string; responseValidated: boolean; usageVerified: boolean; quantities?: Record<string, string>; upstreamStatus?: number; code?: string; message: string;
  priceTier?: { inputTokens: string; upToInputTokens: number; thinking: boolean };
};
type StoredStart = { hash: string; result: RouteTestResult };

function requestFor(selection: Selection) {
  const { createdAt, updatedAt, ...stored } = selection.route, route = routeInput.parse(stored), limit = Math.min(64, route.options.maxOutputTokens);
  let endpoint: GatewayEndpoint, input: Record<string, unknown>;
  if (route.service === 'chat' || route.service === 'vision') {
    const vision = route.service === 'vision';
    if (vision && route.options.maxImages < 1) throw new HttpError(409, 'TEST_IMAGE_LIMIT', '该读图路由未允许图片输入，请先保存有效的图片数量限制。');
    if (route.protocol === 'openai-chat') {
      endpoint = 'chat'; input = { messages: [{ role: 'user', content: vision ? [{ type: 'text', text: 'Describe the image in one word.' }, { type: 'image_url', image_url: { url: image } }] : 'Reply with OK.' }], max_tokens: limit, stream: false };
    } else if (route.protocol === 'openai-responses') {
      endpoint = 'responses'; input = { input: vision ? [{ role: 'user', content: [{ type: 'input_text', text: 'Describe the image in one word.' }, { type: 'input_image', image_url: image }] }] : 'Reply with OK.', max_output_tokens: limit, stream: false };
    } else throw new HttpError(409, 'TEST_PROTOCOL_UNSUPPORTED', '此协议尚未开放连接检测。');
  } else if (route.service === 'decision') {
    endpoint = 'decisions'; input = { state: { test: 'CCAGENT connectivity' }, questions: { connectivity: { type: 'choice', instructions: 'Choose ok for this connectivity test.', criteria: { ok: 'The test input is valid.', failed: 'The test input is invalid.' } } } };
  } else if (route.service === 'search') {
    endpoint = 'search'; input = { query: 'Vercel documentation', max_results: 1, search_depth: 'basic' };
  } else { endpoint = 'voice'; input = { text: '连接测试。' }; }
  const prepared = prepareUpstream(endpoint, input, route);
  prepared.body = applyRequestPricing(selection.definition, prepared.body);
  return { route, input, prepared, endpoint };
}
function planFor(selection: Selection, at: Date) {
  const request = requestFor(selection), pricing = publicPricing(selection);
  const estimate = quoteDefinition(selection.definition, selection.currency, maximumQuantities(selection, request.input, request.prepared.body), at, selection.usdCny || undefined, true, request.prepared.body);
  const confirmationFingerprint = createHash('sha256').update(JSON.stringify({ templateVersion: 1, route: request.route, pricing, body: request.prepared.body })).digest('hex');
  const timeoutMs = Math.min(request.route.timeoutMs, 30000);
  return { selection, ...request, confirmationFingerprint, timeoutMs, estimatedPublicCostMicro: estimate.publicCostMicro.toString(),
    quote: { routeId: selection.route.id, name: selection.route.name, provider: selection.route.provider, upstreamModel: selection.route.upstreamModel, service: selection.route.service,
      protocol: selection.route.protocol, enabled: selection.route.enabled, pricing, confirmationFingerprint, estimatedPublicCostMicro: estimate.publicCostMicro.toString(), platformPaid: true as const,
      userChargeMicro: '0' as const, timeoutMs, singleAttempt: true, fallback: false, description: selection.route.service === 'vision' ? '一张内置 64×64 纯色图片及简短描述请求'
        : selection.route.service === 'decision' ? '一个固定状态与一项类型化选择问题' : selection.route.service === 'search' ? '一次基础搜索，最多一条结果'
        : selection.route.service === 'voice' ? '合成“连接测试。”，核对 WAV 响应后丢弃音频' : `一条固定简短提示，${selection.definition.tariff.kind === 'qwen-input-tiers' ? '回答' : '输出'}上限 ${Math.min(64, request.route.options.maxOutputTokens)} Token` } };
}
async function ownedStart(id: string, expectedRoute: string) {
  const [row] = await database().db.select().from(audit).where(and(eq(audit.id, id), eq(audit.action, startAction), eq(audit.objectId, expectedRoute))).limit(1);
  return row;
}
async function resultFor(start: typeof audit.$inferSelect, at: Date): Promise<RouteTestResult> {
  const [finished] = await database().db.select().from(audit).where(and(eq(audit.id, start.id + ':result'), eq(audit.action, resultAction), eq(audit.objectId, start.objectId))).limit(1);
  if (finished) return finished.metadata as RouteTestResult;
  const result = (start.metadata as StoredStart).result;
  return at.getTime() - start.createdAt.getTime() < staleMs ? result : { ...result, status: 'unknown', code: 'TEST_RESULT_UNCONFIRMED', message: '检测结果尚未确认，请核对供应商记录；相同检测编号不会再次请求上游。' };
}
async function boundedBytes(response: Response, maximum: number) {
  const reader = response.body?.getReader(); if (!reader) throw new Error('MISSING_BODY');
  let size = 0; const chunks: Uint8Array[] = [];
  try { while (true) { const value = await reader.read(); if (value.done) break; size += value.value.length; if (size > maximum) { await reader.cancel(); throw new Error('BODY_TOO_LARGE'); } chunks.push(value.value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
function validResponse(protocol: string, payload: unknown) {
  const root = object(payload);
  if (root.error) return false;
  if (protocol === 'openai-chat') { const first = object(Array.isArray(root.choices) ? root.choices[0] : undefined), message = object(first.message); return typeof message.content === 'string' && !!message.content.trim() || typeof message.reasoning_content === 'string' && !!message.reasoning_content.trim(); }
  if (protocol === 'openai-responses') return root.status !== 'failed' && (typeof root.output_text === 'string' && !!root.output_text.trim() || Array.isArray(root.output) && root.output.length > 0);
  if (protocol === 'jev-decisions') { const answer = object(object(root.answers).connectivity); return answer.type === 'choice' && ['ok', 'failed'].includes(String(answer.choice)); }
  if (protocol === 'tavily') return Array.isArray(root.results);
  if (protocol === 'bocha') return (root.code === undefined || String(root.code) === '200') && Array.isArray(object(object(root.data).webPages ?? root.webPages).value);
  return typeof object(object(root.output).audio).url === 'string';
}
function rejection(status: number, payload: unknown) {
  const code = String(object(object(payload).error).code ?? object(payload).code ?? '');
  // Supplier text, headers, output and arbitrary error codes never enter browser or audit data.
  const known: Record<string, string> = { Arrearage: '供应商账户欠费，请先充值后再检测。', Unpurchased: '供应商尚未开通该模型，请先开通权限。',
    invalid_api_key: '供应商拒绝了服务端凭据，请通过安全配置渠道核对。', InvalidApiKey: '供应商拒绝了服务端凭据，请通过安全配置渠道核对。', insufficient_quota: '供应商余额或配额不足。' };
  return { code: Object.hasOwn(known, code) ? code : `UPSTREAM_HTTP_${status}`, message: known[code] || (status === 401 || status === 403 ? '供应商拒绝凭据或模型权限。' : status === 429 ? '供应商限流或配额不足，请核对后再主动检测。' : '供应商返回失败状态，请核对供应商服务和配置。') };
}

export function createRouteTests(options: { fetch?: typeof fetch; keepAlive?: (work: Promise<void>) => void; now?: () => Date } = {}) {
  const fetcher = options.fetch ?? fetch, now = options.now ?? (() => new Date());
  async function execute(actorId: string, plan: ReturnType<typeof planFor>, initial: RouteTestResult, secret: string) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), plan.timeoutMs);
    const startedAt = now(); let sent = false, status: number | undefined, result: RouteTestResult = initial;
    try {
      selectedTariff(plan.selection.definition, startedAt); sent = true;
      const response = await requestUpstream(plan.prepared.url, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(plan.prepared.body), redirect: 'error', signal: controller.signal }, fetcher);
      status = response.status;
      let payload: unknown; try { payload = JSON.parse((await boundedBytes(response, 2 * 1024 * 1024)).toString('utf8')); } catch { if (!response.ok) payload = {}; else throw new Error('INVALID_RESPONSE'); }
      if (!response.ok) result = { ...initial, status: 'failed', ...rejection(response.status, payload) };
      else if (!validResponse(plan.route.protocol, payload)) result = { ...initial, status: 'unknown', code: 'TEST_RESPONSE_UNVERIFIED', message: '已收到响应，但格式或测试结果未能核实，请核对供应商记录。' };
      else {
        if (plan.endpoint === 'voice') {
          const audio = await fetcher(voiceDownloadUrl(object(object(object(payload).output).audio).url), { redirect: 'error', signal: controller.signal });
          if (!audio.ok) { await audio.body?.cancel(); throw new Error('AUDIO_UNAVAILABLE'); }
          const bytes = await boundedBytes(audio, 2 * 1024 * 1024);
          if (bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WAVE') throw new Error('INVALID_AUDIO');
        }
        const quantities = measuredUsage(plan.route.protocol, payload, plan.selection.definition.rates.map(rate => rate.metric));
        if (!quantities) result = { ...initial, status: 'unknown', responseValidated: true, code: 'TEST_USAGE_UNVERIFIED', message: '连接与响应格式正常，但用量尚不能核实，请核对供应商账单。' };
        else { const cost = quoteDefinition(plan.selection.definition, plan.selection.currency, quantities, startedAt, plan.selection.usdCny || undefined, false, plan.prepared.body);
          result = { ...initial, status: 'succeeded', responseValidated: true, usageVerified: true, quantities: Object.fromEntries(Object.entries(quantities).map(([key, value]) => [key, value!.toString()])), publicCostMicro: cost.publicCostMicro.toString(), ...(cost.priceTier ? { priceTier: cost.priceTier } : {}), estimateExceeded: cost.publicCostMicro > BigInt(initial.estimatedPublicCostMicro), message: '连接检测通过，响应格式与用量已核实；费用由平台承担。' }; }
      }
    } catch (error) {
      result = { ...initial, status: sent ? 'unknown' : 'failed', ...(sent ? {} : { publicCostMicro: '0' }), code: !sent && error instanceof HttpError ? error.code : controller.signal.aborted ? 'TEST_TIMEOUT' : 'TEST_RESULT_UNCONFIRMED',
        message: !sent && error instanceof HttpError ? error.message : controller.signal.aborted ? '检测超时，结果尚未确认；请查询原检测记录，不会自动重试。' : '检测结果尚未确认，请核对供应商记录；不会自动重试或切换备用。' };
    } finally { clearTimeout(timer); }
    const completedAt = now(); result = { ...result, requestSent: sent, ...(sent ? { executionStartedAt: startedAt.toISOString() } : {}), ...(status === undefined ? {} : { upstreamStatus: status }), completedAt: completedAt.toISOString(), durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()) };
    await database().db.insert(audit).values({ id: initial.id + ':result', actorId, action: resultAction, objectId: initial.routeId, result: result.status, metadata: result }).onConflictDoNothing();
  }
  async function get(request: Request) {
    try {
      await requirePermission(request.headers, 'routes.write');
      const input = z.object({ routeId, testId: z.string().uuid().optional() }).strict().parse(Object.fromEntries(new URL(request.url).searchParams));
      if (input.testId) { const start = await ownedStart(input.testId, input.routeId); if (!start) throw new HttpError(404, 'TEST_NOT_FOUND', '没有找到该检测记录。'); return json({ test: await resultFor(start, now()) }); }
      const plan = planFor(await testableRoute(input.routeId), now());
      const [last] = await database().db.select().from(audit).where(and(eq(audit.action, startAction), eq(audit.objectId, input.routeId))).orderBy(desc(audit.createdAt), desc(audit.id)).limit(1);
      return json({ quote: plan.quote, lastTest: last ? await resultFor(last, now()) : null });
    } catch (error) { return errorResponse(error); }
  }
  async function post(request: Request) {
    try {
      requireSameOrigin(request); const current = await requirePermission(request.headers, 'routes.write'), input = submission.parse(await readJson(request));
      const hash = createHash('sha256').update(JSON.stringify([input.routeId, input.confirmationFingerprint, 1])).digest('hex');
      const claimed = await database().db.transaction(async tx => {
        await lockAdministration(tx, 804714033);
        const [existing] = await tx.select().from(audit).where(eq(audit.id, input.testId)).limit(1);
        if (existing) {
          if (existing.action !== startAction || existing.actorId !== current.user.id || existing.objectId !== input.routeId || (existing.metadata as StoredStart).hash !== hash) throw new HttpError(409, 'TEST_ID_CONFLICT', '相同检测编号不能用于其他配置、路由或操作者。');
          return { existing };
        }
        const active = await tx.execute<{ id: string }>(sql`select started.id from ${audit} started left join ${audit} finished on finished.id=started.id || ':result'
          where started.action=${startAction} and started.object_id=${input.routeId} and started.created_at > ${new Date(now().getTime() - staleMs).toISOString()}::timestamptz and finished.id is null limit 1`);
        if (active.length) throw new HttpError(409, 'TEST_IN_PROGRESS', '该路由已有检测正在执行或等待确认，请先查询原检测记录。');
        const plan = planFor(await testableRoute(input.routeId, tx), now());
        if (input.confirmationFingerprint !== plan.confirmationFingerprint) throw new HttpError(409, 'TEST_CONFIGURATION_CHANGED', '已保存配置或价格已改变，请重新准备检测并确认费用。');
        const secret = await resolveRouteCredential(plan.route, tx);
        const result: RouteTestResult = { id: input.testId, routeId: input.routeId, status: 'running', startedAt: now().toISOString(), service: plan.route.service, protocol: plan.route.protocol,
          priceVersion: plan.selection.price.version, confirmationFingerprint: plan.confirmationFingerprint, estimatedPublicCostMicro: plan.estimatedPublicCostMicro, publicCostMicro: null,
          provider: plan.route.provider, upstreamModel: plan.route.upstreamModel, pricing: publicPricing(plan.selection), requestSent: null,
          platformPaid: true, userChargeMicro: '0', responseValidated: false, usageVerified: false, message: '已发起一次检测，正在等待上游结果。' };
        await tx.insert(audit).values({ id: input.testId, actorId: current.user.id, action: startAction, objectId: input.routeId, result: 'running', metadata: { hash, result }, createdAt: now() });
        return { plan, result, secret };
      });
      if ('existing' in claimed && claimed.existing) { const result = await resultFor(claimed.existing, now()); return json({ test: result, replay: true }, result.status === 'running' ? 202 : 200); }
      const work = execute(current.user.id, claimed.plan!, claimed.result!, claimed.secret!);
      void work.catch(() => { console.error('ROUTE_TEST_FINALIZATION_FAILED'); }); options.keepAlive?.(work);
      return json({ test: claimed.result, replay: false }, 202);
    } catch (error) { return errorResponse(error); }
  }
  return { get, post };
}
