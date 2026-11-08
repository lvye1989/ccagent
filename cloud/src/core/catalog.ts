import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { calculateCharge, type CostComponent } from '../../../src/platform/money';
import { priceDefinition, type PriceDefinition, type PriceTier, type UsageMetric } from '../../../src/platform/pricingDefinition';
export { priceDefinition, applyRequestPricing } from '../../../src/platform/pricingDefinition';
export type { PriceDefinition, UsageMetric } from '../../../src/platform/pricingDefinition';
import { database, type DatabaseReader } from './db';
import { audit, prices, routes } from './db/schema';
import { configurationValues } from './configuration';
import { HttpError } from './http';
import { lockAdministration } from './database-locks';
import { resolveRouteCredential, routeCredentialStatus, saveRouteCredential } from './provider-credentials';
import { assertUpstreamHost, validateTrustedUpstreamHost } from './upstream-hosts';

const httpsUrl = z.string().max(500).url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
}, 'Use an HTTPS URL without credentials, query or fragment');
export function validateServicePrice(route: { service: string; protocol: string; provider: string; options?: unknown }, definition: PriceDefinition): void {
  if (!['openai-chat', 'openai-responses', 'jev-decisions', 'tavily', 'bocha', 'dashscope-tts'].includes(route.protocol)) throw new HttpError(409, 'PROTOCOL_NOT_READY', '此协议尚未完成网关联调，暂不能开放。');
  const required: UsageMetric[] = route.protocol === 'tavily' ? ['search_credits'] : route.protocol === 'bocha' ? ['requests']
    : route.protocol === 'dashscope-tts' && definition.rates.some(rate => rate.metric === 'input_characters') ? ['input_characters'] : ['input_tokens', 'output_tokens'];
  if (['openai-chat', 'openai-responses'].includes(route.protocol) && ['deepseek', 'dashscope', 'qwen'].includes(route.provider)) required.push('cached_input_tokens');
  const configured = new Set(definition.rates.map(rate => rate.metric));
  if (required.some(metric => !configured.has(metric))) throw new HttpError(409, 'INCOMPLETE_SERVICE_PRICE', '请配置该服务全部计价项目；公开免费的项目也须明确填写零单价。');
  if (definition.tariff.kind === 'qwen-input-tiers') {
    if (route.protocol !== 'openai-chat' || !['qwen', 'dashscope'].includes(route.provider) || !['chat', 'vision'].includes(route.service)) throw new HttpError(409, 'TARIFF_MISMATCH', '输入阶梯及思考模式价格只适用于 Qwen Chat 路由。');
    const rate = definition.rates[0]!;
    if (route.options && 'tiers' in rate && rate.tiers.at(-1)!.upToInputTokens < routeInput.shape.options.parse(route.options).contextWindow) throw new HttpError(409, 'INCOMPLETE_PRICE_TIERS', '价格阶梯须覆盖路由的完整输入上下文上限。');
  }
}
export const routeInput = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,79}$/), name: z.string().trim().min(1).max(100),
  service: z.enum(['chat', 'vision', 'decision', 'search', 'voice']), protocol: z.enum(['openai-chat', 'openai-responses', 'anthropic', 'gemini', 'jev-decisions', 'tavily', 'bocha', 'dashscope-tts']),
  provider: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,49}$/), baseUrl: httpsUrl, upstreamModel: z.string().min(1).max(200).regex(/^[^\s\r\n\0]+$/),
  credentialEnv: z.string().regex(/^CCAGENT_PROVIDER_[A-Z0-9_]{1,64}$/).default('CCAGENT_PROVIDER_MANAGED'), enabled: z.boolean().default(false),
  timeoutMs: z.number().int().min(1000).max(180000).default(120000), retries: z.number().int().min(0).max(2).default(0),
  options: z.object({ contextWindow: z.number().int().min(128).max(4000000).default(131072), maxOutputTokens: z.number().int().min(1).max(1000000).default(8192),
    maxImages: z.number().int().min(0).max(600).default(20), fallbackRouteId: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,79}$/).nullable().default(null), fallbackEnabled: z.boolean().default(false),
  }).strict(),
}).strict().superRefine((value, context) => {
  const protocols: Record<string, string[]> = { chat: ['openai-chat', 'openai-responses', 'anthropic', 'gemini'], vision: ['openai-chat', 'openai-responses', 'anthropic', 'gemini'], decision: ['jev-decisions'], search: ['tavily', 'bocha'], voice: ['dashscope-tts'] };
  if (!protocols[value.service].includes(value.protocol)) context.addIssue({ code: 'custom', message: 'Service and protocol do not match' });
  if (value.options.fallbackRouteId === value.id) context.addIssue({ code: 'custom', message: 'Route cannot fall back to itself' });
  if (value.options.fallbackEnabled && !value.options.fallbackRouteId) context.addIssue({ code: 'custom', message: 'Enabled fallback requires a route' });
  if (value.options.maxOutputTokens > value.options.contextWindow) context.addIssue({ code: 'custom', message: 'Output limit exceeds context window' });
});
export const priceInput = z.object({ routeId: z.string().min(1).max(80), currency: z.enum(['CNY', 'USD']), definition: priceDefinition,
  sourceUrl: httpsUrl, effectiveAt: z.iso.datetime({ offset: true }), expectedRouteFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();

export function routeFingerprint(route: Pick<typeof routes.$inferSelect, 'provider' | 'protocol' | 'upstreamModel' | 'service' | 'baseUrl'>): string {
  return createHash('sha256').update(JSON.stringify([route.provider, route.protocol, route.upstreamModel, route.service, route.baseUrl])).digest('hex');
}
export function validateUpstreamHost(value: string): void {
  validateTrustedUpstreamHost(value);
}
export function selectedTariff(definition: PriceDefinition, at: Date, upperBound = false): 'peak' | 'off-peak' | 'constant' | 'qwen-input-tiers' {
  if (definition.tariff.kind === 'qwen-input-tiers') return 'qwen-input-tiers';
  if (definition.tariff.kind === 'constant') return 'constant';
  const beijing = new Date(at.getTime() + 8 * 60 * 60 * 1000);
  if (!Number.isFinite(beijing.getTime()) || beijing.getUTCFullYear() !== definition.tariff.calendarYear) throw new HttpError(503, 'PRICE_CALENDAR_EXPIRED', '服务价格日历需要更新。');
  if (upperBound) return 'peak';
  const weekday = beijing.getUTCDay(), hour = beijing.getUTCHours();
  return weekday >= 1 && weekday <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)) && !definition.tariff.holidays.includes(beijing.toISOString().slice(0, 10)) ? 'peak' : 'off-peak';
}
export function quoteDefinition(definition: PriceDefinition, currency: 'CNY' | 'USD', quantities: Partial<Record<UsageMetric, bigint>>, at: Date, usdCny?: string, upperBound = false, requestBody: Record<string, unknown> = {}) {
  const tariff = selectedTariff(definition, at, upperBound);
  const known = new Set(definition.rates.map(rate => rate.metric));
  if (Object.entries(quantities).some(([name, value]) => value !== undefined && value > 0n && !known.has(name as UsageMetric))) throw new HttpError(503, 'COST_COMPONENT_MISSING', '服务尚未配置完整计价项目。');
  let priceTier: PriceTier | undefined;
  let tierInput = 0n, thinking = false;
  if (definition.tariff.kind === 'qwen-input-tiers') {
    const input = quantities.input_tokens, cached = quantities.cached_input_tokens;
    if (input === undefined || cached === undefined || input < 0n || cached < 0n) throw new HttpError(503, 'USAGE_NOT_MEASURABLE', '服务用量尚不能核实。');
    // Budget quantities each allow the whole input to be cached or uncached; they are alternatives.
    tierInput = upperBound ? (input > cached ? input : cached) : input + cached;
    thinking = requestBody.enable_thinking === undefined ? definition.tariff.defaultThinking : z.boolean().parse(requestBody.enable_thinking);
    const first = definition.rates[0]!;
    if (!('tiers' in first)) throw new HttpError(503, 'COST_COMPONENT_MISSING', '输入阶梯价格配置无效。');
    const chosen = first.tiers.find(tier => tierInput <= BigInt(tier.upToInputTokens));
    if (!chosen) throw new HttpError(503, 'PRICE_TIER_UNAVAILABLE', '实际输入用量超出已配置价格阶梯，请核对供应商账单。');
    if (!upperBound) priceTier = { inputTokens: tierInput.toString(), upToInputTokens: chosen.upToInputTokens, thinking };
  }
  const components: CostComponent[] = definition.rates.map(rate => {
    const quantity = quantities[rate.metric];
    if (quantity === undefined || quantity < 0n) throw new HttpError(503, 'USAGE_NOT_MEASURABLE', '服务用量尚不能核实。');
    let publicPrice: string;
    if ('tiers' in rate) {
      const eligible = rate.tiers.filter((tier, index) => upperBound ? index === 0 || BigInt(rate.tiers[index - 1]!.upToInputTokens) < tierInput : tierInput <= BigInt(tier.upToInputTokens));
      const prices = eligible.map(tier => thinking && rate.metric === 'output_tokens' ? tier.thinkingPrice! : tier.price);
      const scaled = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole!) * 1000000000000n + BigInt(fraction.padEnd(12, '0')); };
      publicPrice = upperBound ? prices.reduce((a, b) => scaled(a) >= scaled(b) ? a : b) : prices[0]!;
    } else publicPrice = tariff === 'off-peak' ? rate.offPeakPrice! : rate.price;
    return { quantity, unitQuantity: rate.unitQuantity, publicPrice, currency };
  });
  return { ...calculateCharge(components, '1.3', usdCny), tariff, ...(priceTier ? { priceTier } : {}) };
}

export async function latestPrice(routeId: string, at = new Date(), reader: DatabaseReader = database().db) {
  const [price] = await reader.select().from(prices).where(and(eq(prices.routeId, routeId), lte(prices.effectiveAt, at))).orderBy(desc(prices.version)).limit(1);
  return price;
}
export async function publishedRoute(id: string, service?: string, reader: DatabaseReader = database().db) {
  return selectRoute(id, service, reader, false);
}
// Only administrator connection tests may inspect a fully configured paused route.
export async function testableRoute(id: string, reader: DatabaseReader = database().db) {
  return selectRoute(id, undefined, reader, true);
}
async function selectRoute(id: string, service: string | undefined, reader: DatabaseReader, allowPaused: boolean) {
  const [route] = await reader.select().from(routes).where(eq(routes.id, id));
  if (!route || (!allowPaused && !route.enabled) || (service && route.service !== service)) throw new HttpError(404, 'SERVICE_UNAVAILABLE', '该服务尚未开放。');
  await assertUpstreamHost(route.baseUrl, reader);
  if (!/^CCAGENT_PROVIDER_[A-Z0-9_]{1,64}$/.test(route.credentialEnv)) throw new HttpError(503, 'INVALID_CREDENTIAL_REFERENCE', '服务凭据配置需要更新。');
  await resolveRouteCredential(route, reader);
  const price = await latestPrice(id, new Date(), reader), config = await configurationValues(reader);
  const stored = price?.components as { routeFingerprint?: unknown; definition?: unknown } | undefined;
  if (!price || stored?.routeFingerprint !== routeFingerprint(route)) throw new HttpError(503, 'PRICE_NOT_CONFIGURED', '该服务尚未配置有效价格。');
  const definition = priceDefinition.parse(stored.definition);
  validateServicePrice(route, definition);
  const currency = z.enum(['CNY', 'USD']).parse(price.currency);
  if (currency === 'USD' && !config.settlement_usd_cny) throw new HttpError(503, 'FX_NOT_CONFIGURED', '美元服务尚未配置结算汇率。');
  selectedTariff(definition, new Date());
  return { route, price, definition, currency, usdCny: currency === 'USD' ? config.settlement_usd_cny : null, markup: '1.3' as const };
}
export function publicPricing(selection: Awaited<ReturnType<typeof publishedRoute>>) {
  const pricing = { currency: selection.currency, definition: selection.definition, markup: '1.3' as const, usdCny: selection.usdCny,
    version: selection.price.version, sourceUrl: selection.price.sourceUrl };
  const options = routeInput.shape.options.parse(selection.route.options);
  const fingerprint = createHash('sha256').update(JSON.stringify([selection.route.id, routeFingerprint(selection.route), pricing,
    { contextWindow: options.contextWindow, maxOutputTokens: options.maxOutputTokens, maxImages: options.maxImages }])).digest('hex');
  return { ...pricing, fingerprint };
}
export async function saveRoute(actorId: string, input: z.infer<typeof routeInput>, credential: { apiKey?: string; remove?: boolean } = {}) {
  await assertUpstreamHost(input.baseUrl);
  return database().db.transaction(async tx => {
    await lockAdministration(tx, 804714033);
    const [existing] = await tx.select().from(routes).where(eq(routes.id, input.id)).for('update');
    const changed = existing && routeFingerprint(existing) !== routeFingerprint(input);
    const destinationChanged = !!existing && (existing.provider !== input.provider || new URL(existing.baseUrl).href.replace(/\/$/, '') !== new URL(input.baseUrl).href.replace(/\/$/, ''));
    const hasNewKey = Boolean(credential.apiKey?.trim());
    await saveRouteCredential(actorId, input, { ...credential, ...(destinationChanged && !hasNewKey ? { remove: true } : {}) }, tx);
    // A changed provider/model/protocol never reuses the previous supplier price.
    const enabled = changed || credential.remove || destinationChanged && !hasNewKey ? false : input.enabled;
    if (input.options.fallbackEnabled) {
      const [target] = await tx.select().from(routes).where(eq(routes.id, input.options.fallbackRouteId!));
      if (!target || target.service !== input.service || target.protocol !== input.protocol) throw new HttpError(409, 'INCOMPATIBLE_FALLBACK', '备用须为另一条同服务类型、同协议的路由。');
      if (enabled) {
        try { await publishedRoute(target.id, input.service, tx); }
        catch { throw new HttpError(409, 'FALLBACK_NOT_READY', '启用前请完成备用路由的凭据、成本及开放配置。'); }
      }
      const graph = new Map((await tx.select({ id: routes.id, options: routes.options }).from(routes)).map(route => [route.id, routeInput.shape.options.parse(route.options)]));
      graph.set(input.id, input.options);
      const visited = new Set<string>(); let cursor: string | null = input.id;
      while (cursor) {
        if (visited.has(cursor)) throw new HttpError(409, 'FALLBACK_CYCLE', '备用路由不能形成循环。');
        visited.add(cursor); const next = graph.get(cursor); cursor = next?.fallbackEnabled ? next.fallbackRouteId : null;
      }
    }
    if (enabled) {
      const [price] = await tx.select().from(prices).where(and(eq(prices.routeId, input.id), lte(prices.effectiveAt, new Date()))).orderBy(desc(prices.version)).limit(1);
      const stored = price?.components as { routeFingerprint?: unknown; definition?: unknown } | undefined;
      if (!price || stored?.routeFingerprint !== routeFingerprint(input) || !(await routeCredentialStatus(input, tx)).configured) throw new HttpError(409, 'SERVICE_NOT_READY', '启用前请配置对应的供应商凭据和有效价格。');
      const fx = (await configurationValues(tx)).settlement_usd_cny;
      if (price.currency === 'USD' && !fx) throw new HttpError(409, 'FX_NOT_CONFIGURED', '启用美元服务前请配置结算汇率。');
      const definition = priceDefinition.parse(stored.definition);
      validateServicePrice(input, definition);
      selectedTariff(definition, new Date());
    }
    const value = { ...input, enabled, updatedAt: new Date() };
    if (existing) await tx.update(routes).set(value).where(eq(routes.id, input.id));
    else await tx.insert(routes).values(value);
    await tx.insert(audit).values({ id: randomUUID(), actorId, action: 'routes.save', objectId: input.id, result: 'success', metadata: { enabled, repricingRequired: !!changed,
      fallbackEnabled: input.options.fallbackEnabled, fallbackRouteId: input.options.fallbackRouteId } });
    return { saved: true, enabled, repricingRequired: !!changed };
  });
}
export async function createPriceVersion(actorId: string, input: z.infer<typeof priceInput>) {
  return database().db.transaction(async tx => {
    await lockAdministration(tx, 804714033);
    const [route] = await tx.select().from(routes).where(eq(routes.id, input.routeId)).for('update');
    if (!route) throw new HttpError(404, 'ROUTE_NOT_FOUND', '服务路由不存在。');
    if (input.expectedRouteFingerprint !== undefined && input.expectedRouteFingerprint !== routeFingerprint(route)) {
      throw new HttpError(409, 'ROUTE_CONFIGURATION_CHANGED', '路由已被其他管理员修改，请重新载入后配置成本。');
    }
    if (input.definition.tariff.kind === 'deepseek' && route.provider !== 'deepseek') throw new HttpError(400, 'TARIFF_MISMATCH', '峰谷价格策略与供应商不符。');
    if (input.definition.tariff.kind === 'qwen-input-tiers') validateServicePrice(route, input.definition);
    const [latest] = await tx.select({ version: prices.version }).from(prices).where(eq(prices.routeId, input.routeId)).orderBy(desc(prices.version)).limit(1);
    const version = (latest?.version ?? 0) + 1;
    const [price] = await tx.insert(prices).values({ id: randomUUID(), routeId: input.routeId, version, currency: input.currency,
      components: { routeFingerprint: routeFingerprint(route), definition: input.definition }, fx: null, markup: '1.3', sourceUrl: input.sourceUrl, effectiveAt: new Date(input.effectiveAt) }).returning({ id: prices.id, version: prices.version });
    await tx.insert(audit).values({ id: randomUUID(), actorId, action: 'prices.create_version', objectId: price.id, result: 'success', metadata: { routeId: input.routeId, version } });
    return price;
  });
}
