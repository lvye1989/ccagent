import { z } from 'zod';

export const usageMetric = z.enum(['input_tokens', 'cached_input_tokens', 'image_input_tokens', 'audio_input_tokens', 'video_input_tokens', 'output_tokens', 'audio_output_tokens', 'requests', 'input_characters', 'search_credits']);
export type UsageMetric = z.infer<typeof usageMetric>;
const decimal = z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,12})?$/);
const unitQuantity = z.string().regex(/^[1-9]\d{0,9}$/);
const httpsUrl = z.string().max(500).url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
}, 'Use an HTTPS URL without credentials, query or fragment');
const flatRate = z.object({ metric: usageMetric, price: decimal, unitQuantity, offPeakPrice: decimal.optional() }).strict();
const tier = z.object({ upToInputTokens: z.number().int().min(1).max(4000000), price: decimal, thinkingPrice: decimal.optional() }).strict();
const tieredRate = z.object({ metric: z.enum(['input_tokens', 'cached_input_tokens', 'output_tokens']), unitQuantity, tiers: z.array(tier).min(1).max(16) }).strict();
export const priceDefinition = z.object({
  rates: z.array(z.union([flatRate, tieredRate])).min(1).max(10),
  tariff: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('constant') }).strict(),
    z.object({ kind: z.literal('deepseek'), calendarYear: z.number().int().min(2026).max(2100), holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(60), calendarSourceUrl: httpsUrl }).strict(),
    z.object({ kind: z.literal('qwen-input-tiers'), defaultThinking: z.boolean(), maxThinkingTokens: z.number().int().min(1).max(4000000) }).strict(),
  ]),
}).strict().superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  if (new Set(value.rates.map(rate => rate.metric)).size !== value.rates.length) issue('Duplicate usage metric');
  if (value.tariff.kind === 'qwen-input-tiers') {
    if (value.rates.length !== 3 || ['input_tokens', 'cached_input_tokens', 'output_tokens'].some(metric => !value.rates.some(rate => rate.metric === metric))) issue('Qwen tiers require input, cached input and output rates');
    let boundaries: string | undefined;
    for (const rate of value.rates) {
      if (!('tiers' in rate)) { issue('Every Qwen rate requires input-token tiers'); continue; }
      const current = JSON.stringify(rate.tiers.map(tier => tier.upToInputTokens));
      if (boundaries !== undefined && boundaries !== current) issue('All metrics must use the same input-token boundaries');
      boundaries = current;
      for (const [index, tier] of rate.tiers.entries()) {
        if (index && tier.upToInputTokens <= rate.tiers[index - 1]!.upToInputTokens) issue('Input-token boundaries must strictly increase');
        if (rate.metric === 'output_tokens' ? tier.thinkingPrice === undefined : tier.thinkingPrice !== undefined) issue('Only output rates require an explicit thinking price');
      }
    }
    return;
  }
  if (value.rates.some(rate => 'tiers' in rate)) issue('Tiered rates require the Qwen input-tier policy');
  if (value.tariff.kind === 'deepseek') {
    const scaled = (price: string) => { const [whole, fraction = ''] = price.split('.'); return BigInt(whole!) * 1000000000000n + BigInt(fraction.padEnd(12, '0')); };
    for (const rate of value.rates) {
      if (!('price' in rate)) continue;
      if (rate.offPeakPrice === undefined) issue('Peak and off-peak rates are both required');
      else if (decimal.safeParse(rate.price).success && decimal.safeParse(rate.offPeakPrice).success && scaled(rate.offPeakPrice) > scaled(rate.price)) issue('Off-peak rate cannot exceed peak rate');
    }
    for (const date of value.tariff.holidays) {
      const parsed = new Date(`${date}T00:00:00Z`);
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || parsed.getUTCFullYear() !== value.tariff.calendarYear) issue('Invalid holiday calendar date');
    }
  }
});
export type PriceDefinition = z.infer<typeof priceDefinition>;
export type PriceTier = { inputTokens: string; upToInputTokens: number; thinking: boolean };

/** Pin the priced mode on the actual provider request, including the configured default. */
export function applyRequestPricing(definition: PriceDefinition, body: Record<string, unknown>): Record<string, unknown> {
  if (definition.tariff.kind !== 'qwen-input-tiers') return body;
  const thinking = body.enable_thinking === undefined ? definition.tariff.defaultThinking : z.boolean().parse(body.enable_thinking);
  if (body.thinking_budget !== undefined) z.number().int().min(0).max(definition.tariff.maxThinkingTokens).parse(body.thinking_budget);
  return { ...body, enable_thinking: thinking };
}

/** Format every tier for native clients; never flatten a tiered model to its first price. */
export function pricingRateLines(definition: PriceDefinition): string[] {
  return definition.rates.flatMap(rate => 'tiers' in rate ? rate.tiers.map((tier, index) =>
    `${rate.metric}：输入 ${index ? rate.tiers[index - 1]!.upToInputTokens : 0} < Token ≤ ${tier.upToInputTokens}，每 ${rate.unitQuantity} 单位 ${tier.price}${tier.thinkingPrice !== undefined ? `（思考 ${tier.thinkingPrice}）` : ''}`)
    : [`${rate.metric}：每 ${rate.unitQuantity} 单位 ${rate.price}${rate.offPeakPrice !== undefined ? `（低峰 ${rate.offPeakPrice}）` : ''}`]);
}
