import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { calculateCharge, type CostComponent } from '../../../src/platform/money';
import { database } from './db';
import { audit, prices, routes } from './db/schema';
import { configurationValues } from './configuration';
import { HttpError } from './http';

const metric = z.enum(['input_tokens', 'cached_input_tokens', 'image_input_tokens', 'audio_input_tokens', 'video_input_tokens', 'output_tokens', 'audio_output_tokens', 'requests', 'input_characters', 'search_credits']);
export type UsageMetric = z.infer<typeof metric>;
const decimal = z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,12})?$/);
const httpsUrl = z.string().max(500).url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
}, 'Use an HTTPS URL without credentials, query or fragment');
const rate = z.object({ metric, price: decimal, unitQuantity: z.string().regex(/^[1-9]\d{0,9}$/), offPeakPrice: decimal.optional() }).strict();
export const priceDefinition = z.object({ rates: z.array(rate).min(1).max(10), tariff: z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('constant') }).strict(),
  z.object({ kind: z.literal('deepseek'), calendarYear: z.number().int().min(2026).max(2100), holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(60), calendarSourceUrl: httpsUrl }).strict(),
]) }).strict().superRefine((value, context) => {
  if (new Set(value.rates.map(rate => rate.metric)).size !== value.rates.length) context.addIssue({ code: 'custom', message: 'Duplicate usage metric' });
  if (value.tariff.kind === 'deepseek') {
    if (value.rates.some(rate => rate.offPeakPrice === undefined)) context.addIssue({ code: 'custom', message: 'Peak and off-peak rates are both required' });
    const scaled = (price: string) => { const [whole, fraction = ''] = price.split('.'); return BigInt(whole) * 1000000000000n + BigInt(fraction.padEnd(12, '0')); };
    for (const rate of value.rates) {
      if (rate.offPeakPrice !== undefined && decimal.safeParse(rate.price).success && decimal.safeParse(rate.offPeakPrice).success && scaled(rate.offPeakPrice) > scaled(rate.price)) {
        context.addIssue({ code: 'custom', message: 'Off-peak rate cannot exceed peak rate' });
      }
    }
    for (const date of value.tariff.holidays) {
      const parsed = new Date(`${date}T00:00:00Z`);
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || parsed.getUTCFullYear() !== value.tariff.calendarYear) context.addIssue({ code: 'custom', message: 'Invalid holiday calendar date' });
    }
  }
});
export type PriceDefinition = z.infer<typeof priceDefinition>;
export function validateServicePrice(route: { service: string; protocol: string; provider: string }, definition: PriceDefinition): void {
  if (!['openai-chat', 'openai-responses', 'jev-decisions', 'tavily', 'bocha', 'dashscope-tts'].includes(route.protocol)) throw new HttpError(409, 'PROTOCOL_NOT_READY', '此协议尚未完成网关联调，暂不能开放。');
  const required: UsageMetric[] = route.protocol === 'tavily' ? ['search_credits'] : route.protocol === 'bocha' ? ['requests']
    : route.protocol === 'dashscope-tts' && definition.rates.some(rate => rate.metric === 'input_characters') ? ['input_characters'] : ['input_tokens', 'output_tokens'];
  if (['openai-chat', 'openai-responses'].includes(route.protocol) && ['deepseek', 'dashscope', 'qwen'].includes(route.provider)) required.push('cached_input_tokens');
  const configured = new Set(definition.rates.map(rate => rate.metric));
  if (required.some(metric => !configured.has(metric))) throw new HttpError(409, 'INCOMPLETE_SERVICE_PRICE', '请配置该服务全部计价项目；公开免费的项目也须明确填写零单价。');
}
export const routeInput = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,79}$/), name: z.string().trim().min(1).max(100),
  service: z.enum(['chat', 'vision', 'decision', 'search', 'voice']), protocol: z.enum(['openai-chat', 'openai-responses', 'anthropic', 'gemini', 'jev-decisions', 'tavily', 'bocha', 'dashscope-tts']),
  provider: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,49}$/), baseUrl: httpsUrl, upstreamModel: z.string().min(1).max(200).regex(/^[^\s\r\n\0]+$/),
  credentialEnv: z.string().regex(/^CCAGENT_PROVIDER_[A-Z0-9_]{1,64}$/), enabled: z.boolean().default(false),
  timeoutMs: z.number().int().min(1000).max(180000).default(120000), retries: z.number().int().min(0).max(2).default(0),
  options: z.object({ contextWindow: z.number().int().min(128).max(4000000).default(131072), maxOutputTokens: z.number().int().min(1).max(1000000).default(8192),
    maxImages: z.number().int().min(0).max(600).default(20), fallbackRouteId: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,79}$/).nullable().default(null),
  }).strict(),
}).strict().superRefine((value, context) => {
  const protocols: Record<string, string[]> = { chat: ['openai-chat', 'openai-responses', 'anthropic', 'gemini'], vision: ['openai-chat', 'openai-responses', 'anthropic', 'gemini'], decision: ['jev-decisions'], search: ['tavily', 'bocha'], voice: ['dashscope-tts'] };
  if (!protocols[value.service].includes(value.protocol)) context.addIssue({ code: 'custom', message: 'Service and protocol do not match' });
  if (value.options.fallbackRouteId === value.id) context.addIssue({ code: 'custom', message: 'Route cannot fall back to itself' });
  if (value.options.maxOutputTokens > value.options.contextWindow) context.addIssue({ code: 'custom', message: 'Output limit exceeds context window' });
});
export const priceInput = z.object({ routeId: z.string().min(1).max(80), currency: z.enum(['CNY', 'USD']), definition: priceDefinition,
  sourceUrl: httpsUrl, effectiveAt: z.iso.datetime({ offset: true }) }).strict();

export function routeFingerprint(route: Pick<typeof routes.$inferSelect, 'provider' | 'protocol' | 'upstreamModel' | 'service' | 'baseUrl'>): string {
  return createHash('sha256').update(JSON.stringify([route.provider, route.protocol, route.upstreamModel, route.service, route.baseUrl])).digest('hex');
}
export function validateUpstreamHost(value: string): void {
  const url = new URL(value);
  const allowed = new Set(['api.deepseek.com', 'openrouter.ai', 'api.tavily.com', 'api.bochaai.com', 'dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com',
    ...(process.env.CCAGENT_ALLOWED_UPSTREAM_HOSTS || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean)]);
  if (!allowed.has(url.hostname.toLowerCase()) || (url.port && url.port !== '443')) throw new HttpError(400, 'UPSTREAM_HOST_NOT_ALLOWED', '该上游主机尚未加入服务器允许列表。');
}
export function selectedTariff(definition: PriceDefinition, at: Date, upperBound = false): 'peak' | 'off-peak' | 'constant' {
  if (definition.tariff.kind === 'constant') return 'constant';
  if (!Number.isFinite(at.getTime()) || at.getUTCFullYear() !== definition.tariff.calendarYear) throw new HttpError(503, 'PRICE_CALENDAR_EXPIRED', '服务价格日历需要更新。');
  if (upperBound) return 'peak';
  const weekday = at.getUTCDay(), hour = at.getUTCHours();
  return weekday >= 1 && weekday <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)) && !definition.tariff.holidays.includes(at.toISOString().slice(0, 10)) ? 'peak' : 'off-peak';
}
export function quoteDefinition(definition: PriceDefinition, currency: 'CNY' | 'USD', quantities: Partial<Record<UsageMetric, bigint>>, at: Date, usdCny?: string, upperBound = false) {
  const tariff = selectedTariff(definition, at, upperBound);
  const known = new Set(definition.rates.map(rate => rate.metric));
  if (Object.entries(quantities).some(([name, value]) => value !== undefined && value > 0n && !known.has(name as UsageMetric))) throw new HttpError(503, 'COST_COMPONENT_MISSING', '服务尚未配置完整计价项目。');
  const components: CostComponent[] = definition.rates.map(rate => {
    const quantity = quantities[rate.metric];
    if (quantity === undefined || quantity < 0n) throw new HttpError(503, 'USAGE_NOT_MEASURABLE', '服务用量尚不能核实。');
    return { quantity, unitQuantity: rate.unitQuantity, publicPrice: tariff === 'off-peak' ? rate.offPeakPrice! : rate.price, currency };
  });
  return { ...calculateCharge(components, '1.3', usdCny), tariff };
}

export async function latestPrice(routeId: string, at = new Date()) {
  const [price] = await database().db.select().from(prices).where(and(eq(prices.routeId, routeId), lte(prices.effectiveAt, at))).orderBy(desc(prices.version)).limit(1);
  return price;
}
export async function publishedRoute(id: string, service?: string) {
  const [route] = await database().db.select().from(routes).where(eq(routes.id, id));
  if (!route || !route.enabled || (service && route.service !== service)) throw new HttpError(404, 'SERVICE_UNAVAILABLE', '该服务尚未开放。');
  validateUpstreamHost(route.baseUrl);
  if (!/^CCAGENT_PROVIDER_[A-Z0-9_]{1,64}$/.test(route.credentialEnv)) throw new HttpError(503, 'INVALID_CREDENTIAL_REFERENCE', '服务凭据配置需要更新。');
  if (!process.env[route.credentialEnv]) throw new HttpError(503, 'UPSTREAM_NOT_CONFIGURED', '服务供应商尚未配置。');
  const price = await latestPrice(id), config = await configurationValues();
  const stored = price?.components as { routeFingerprint?: unknown; definition?: unknown } | undefined;
  if (!price || stored?.routeFingerprint !== routeFingerprint(route)) throw new HttpError(503, 'PRICE_NOT_CONFIGURED', '该服务尚未配置有效价格。');
  const definition = priceDefinition.parse(stored.definition);
  validateServicePrice(route, definition);
  const currency = z.enum(['CNY', 'USD']).parse(price.currency);
  if (currency === 'USD' && !config.settlement_usd_cny) throw new HttpError(503, 'FX_NOT_CONFIGURED', '美元服务尚未配置结算汇率。');
  selectedTariff(definition, new Date());
  return { route, price, definition, currency, usdCny: currency === 'USD' ? config.settlement_usd_cny : null, markup: '1.3' as const };
}
export async function saveRoute(actorId: string, input: z.infer<typeof routeInput>) {
  validateUpstreamHost(input.baseUrl);
  const fx = input.enabled ? (await configurationValues()).settlement_usd_cny : '';
  return database().db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(804714033)`);
    const [existing] = await tx.select().from(routes).where(eq(routes.id, input.id)).for('update');
    const changed = existing && routeFingerprint(existing) !== routeFingerprint(input);
    // A changed provider/model/protocol never reuses the previous supplier price.
    const enabled = changed ? false : input.enabled;
    if (enabled) {
      const [price] = await tx.select().from(prices).where(and(eq(prices.routeId, input.id), lte(prices.effectiveAt, new Date()))).orderBy(desc(prices.version)).limit(1);
      const stored = price?.components as { routeFingerprint?: unknown; definition?: unknown } | undefined;
      if (!price || stored?.routeFingerprint !== routeFingerprint(input) || !process.env[input.credentialEnv]) throw new HttpError(409, 'SERVICE_NOT_READY', '启用前请配置对应的供应商凭据和有效价格。');
      if (price.currency === 'USD' && !fx) throw new HttpError(409, 'FX_NOT_CONFIGURED', '启用美元服务前请配置结算汇率。');
      const definition = priceDefinition.parse(stored.definition);
      validateServicePrice(input, definition);
      selectedTariff(definition, new Date());
    }
    const value = { ...input, enabled, updatedAt: new Date() };
    if (existing) await tx.update(routes).set(value).where(eq(routes.id, input.id));
    else await tx.insert(routes).values(value);
    await tx.insert(audit).values({ id: randomUUID(), actorId, action: 'routes.save', objectId: input.id, result: 'success', metadata: { enabled, repricingRequired: !!changed } });
    return { saved: true, enabled, repricingRequired: !!changed };
  });
}
export async function createPriceVersion(actorId: string, input: z.infer<typeof priceInput>) {
  return database().db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(804714033)`);
    const [route] = await tx.select().from(routes).where(eq(routes.id, input.routeId)).for('update');
    if (!route) throw new HttpError(404, 'ROUTE_NOT_FOUND', '服务路由不存在。');
    if (input.definition.tariff.kind === 'deepseek' && route.provider !== 'deepseek') throw new HttpError(400, 'TARIFF_MISMATCH', '峰谷价格策略与供应商不符。');
    const [latest] = await tx.select({ version: prices.version }).from(prices).where(eq(prices.routeId, input.routeId)).orderBy(desc(prices.version)).limit(1);
    const version = (latest?.version ?? 0) + 1;
    const [price] = await tx.insert(prices).values({ id: randomUUID(), routeId: input.routeId, version, currency: input.currency,
      components: { routeFingerprint: routeFingerprint(route), definition: input.definition }, fx: null, markup: '1.3', sourceUrl: input.sourceUrl, effectiveAt: new Date(input.effectiveAt) }).returning({ id: prices.id, version: prices.version });
    await tx.insert(audit).values({ id: randomUUID(), actorId, action: 'prices.create_version', objectId: price.id, result: 'success', metadata: { routeId: input.routeId, version } });
    return price;
  });
}
