import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyRequestPricing, priceDefinition, quoteDefinition, routeInput, validateServicePrice } from '../src/core/catalog';
import { pricingRateLines } from '../../src/platform/pricingDefinition';
import { serviceRouteSchema } from '../../src/platform/serviceState';
import { blankQwenTierDraft, qwenTierDefinition, qwenTierDraft } from '../src/components/qwen-tier-editor';
import { definition } from './qwen-pricing-fixture';

const at = new Date('2026-11-07T08:00:00Z');
const amounts = (input: bigint, cached: bigint, output = 10n) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output });

test('Qwen tier quote boundaries modes validation and native catalogue preservation', async t => {
  await t.test('cached input counts toward the whole-request tier; inclusive boundaries are exact', () => {
    const first = quoteDefinition(definition(), 'CNY', amounts(100n, 28n), at);
    assert.equal(first.publicCostMicro, 2456000n); assert.equal(first.chargeMicro, 3192800n);
    assert.deepEqual(first.priceTier, { inputTokens: '128', upToInputTokens: 128, thinking: false });
    const next = quoteDefinition(definition(), 'CNY', amounts(101n, 28n), at);
    assert.equal(next.publicCostMicro, 7428000n); assert.equal(next.chargeMicro, 9656400n);
    assert.equal(next.priceTier!.upToInputTokens, 256);
    assert.equal(quoteDefinition(definition(), 'CNY', amounts(128n, 128n), at).priceTier!.upToInputTokens, 256);
    assert.equal(quoteDefinition(definition(), 'CNY', amounts(129n, 128n), at).priceTier!.upToInputTokens, 1024);
  });
  await t.test('thinking uses its output price for the measured complete output without double counting reasoning', () => {
    const quote = quoteDefinition(definition(), 'CNY', amounts(101n, 28n), at, undefined, false, { enable_thinking: true });
    assert.equal(quote.publicCostMicro, 8628000n); assert.equal(quote.chargeMicro, 11216400n);
    assert.equal(quote.priceTier!.thinking, true);
    assert.equal(quoteDefinition(definition(true), 'CNY', amounts(101n, 28n), at).chargeMicro, quote.chargeMicro);
    assert.equal(quoteDefinition(definition(true), 'CNY', amounts(101n, 28n), at, undefined, false, { enable_thinking: false }).chargeMicro, 9656400n);
  });
  await t.test('budgets cover every reachable tier even when later prices decrease', () => {
    const price = definition();
    for (const rate of price.rates) if ('tiers' in rate) { rate.tiers[2]!.price = '0.01'; if (rate.metric === 'output_tokens') rate.tiers[2]!.thinkingPrice = '0.02'; }
    for (const thinking of [false, true]) {
      const budget = quoteDefinition(price, 'CNY', amounts(1024n, 1024n), at, undefined, true, { enable_thinking: thinking });
      for (const total of [0n, 1n, 128n, 129n, 256n, 257n, 1024n]) for (const cached of [0n, total / 2n, total]) for (const output of [0n, 1n, 10n]) {
        assert(quoteDefinition(price, 'CNY', amounts(total - cached, cached, output), at, undefined, false, { enable_thinking: thinking }).chargeMicro <= budget.chargeMicro);
      }
    }
    const bounded = quoteDefinition(definition(), 'CNY', amounts(128n, 128n), at, undefined, true);
    assert.equal(bounded.chargeMicro, 4180800n); // cached/uncached budgets are alternatives for selecting the tier.
  });
  await t.test('missing usage and input beyond the last priced tier cannot select a cheaper fallback', () => {
    assert.throws(() => quoteDefinition(definition(), 'CNY', { input_tokens: 1n, output_tokens: 1n }, at), { code: 'USAGE_NOT_MEASURABLE' });
    assert.throws(() => quoteDefinition(definition(), 'CNY', amounts(1025n, 0n), at), { code: 'PRICE_TIER_UNAVAILABLE' });
    assert.throws(() => quoteDefinition(definition(), 'USD', amounts(1n, 0n), at));
    assert.equal(quoteDefinition(definition(), 'USD', amounts(100n, 28n), at, '7.2').chargeMicro, 22988160n);
  });
  await t.test('mode and optional thinking budget are validated before dispatch without shortening defaults', () => {
    assert.deepEqual(applyRequestPricing(definition(true), { max_tokens: 16 }), { max_tokens: 16, enable_thinking: true });
    assert.deepEqual(applyRequestPricing(definition(true), { enable_thinking: false, thinking_budget: 4 }), { enable_thinking: false, thinking_budget: 4 });
    for (const value of ['false', 0, null]) assert.throws(() => applyRequestPricing(definition(), { enable_thinking: value }));
    for (const value of [33, -1, 0.5, '8']) assert.throws(() => applyRequestPricing(definition(true), { thinking_budget: value }));
  });
  await t.test('incomplete mixed unsorted or mismatched tier definitions are rejected', () => {
    const mutations: ((price: any) => void)[] = [p => p.rates.pop(), p => p.rates.push(p.rates[0]), p => p.rates[0].tiers[1].upToInputTokens = 128,
      p => p.rates[1].tiers[0].upToInputTokens = 127, p => delete p.rates[2].tiers[1].thinkingPrice, p => p.rates[0].tiers[0].thinkingPrice = '1',
      p => p.rates[0] = { metric: 'input_tokens', price: '1', unitQuantity: '100' }, p => p.tariff.kind = 'constant', p => delete p.tariff.maxThinkingTokens];
    for (const mutate of mutations) { const price = structuredClone(definition()); mutate(price); assert.equal(priceDefinition.safeParse(price).success, false); }
    const route = routeInput.parse({ id: 'qwen-pricing', name: 'Qwen fixture', provider: 'qwen', protocol: 'openai-chat', service: 'chat', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', upstreamModel: 'synthetic-qwen', credentialEnv: 'CCAGENT_PROVIDER_FIXTURE', options: { contextWindow: 1024, maxOutputTokens: 64 } });
    validateServicePrice(route, definition());
    assert.throws(() => validateServicePrice({ ...route, options: { ...route.options, contextWindow: 1025 } }, definition()), { code: 'INCOMPLETE_PRICE_TIERS' });
    assert.throws(() => validateServicePrice({ ...route, protocol: 'openai-responses' }, definition()), { code: 'TARIFF_MISMATCH' });
  });
  await t.test('native catalogue and editor roundtrip retain every tier, unit and explicit zero', () => {
    const route = serviceRouteSchema.parse({ id: 'qwen', name: 'Qwen', service: 'chat', protocol: 'openai-chat', pricing: { currency: 'CNY', definition: definition(), markup: '1.3', version: 1, sourceUrl: 'https://example.invalid/pricing' }, limits: { contextWindow: 1024, maxOutputTokens: 16, maxImages: 0 } });
    assert.deepEqual(route.pricing.definition, definition());
    assert.deepEqual(qwenTierDefinition(qwenTierDraft(definition(true))), definition(true));
    const zero = definition(); const cached = zero.rates.find(rate => rate.metric === 'cached_input_tokens')!;
    if ('tiers' in cached) cached.tiers[0]!.price = '0';
    assert.deepEqual(qwenTierDefinition(qwenTierDraft(zero)), zero);
    assert.throws(() => qwenTierDefinition(blankQwenTierDraft()));
    const lines = pricingRateLines(route.pricing.definition);
    assert.equal(lines.length, 9); assert(lines.some(line => line.includes('256 < Token ≤ 1024'))); assert(lines.some(line => line.includes('思考 40')));
  });
});

