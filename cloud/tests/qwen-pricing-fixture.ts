import { priceDefinition, type PriceDefinition } from '../../src/platform/pricingDefinition';

// Synthetic prices and small boundaries make tier mistakes visible in exact integer assertions.
export function definition(defaultThinking = false): PriceDefinition {
  return priceDefinition.parse({ tariff: { kind: 'qwen-input-tiers', defaultThinking, maxThinkingTokens: 32 }, rates: [
    { metric: 'input_tokens', unitQuantity: '100', tiers: [{ upToInputTokens: 128, price: '2' }, { upToInputTokens: 256, price: '6' }, { upToInputTokens: 1024, price: '10' }] },
    { metric: 'cached_input_tokens', unitQuantity: '100', tiers: [{ upToInputTokens: 128, price: '0.2' }, { upToInputTokens: 256, price: '0.6' }, { upToInputTokens: 1024, price: '1' }] },
    { metric: 'output_tokens', unitQuantity: '100', tiers: [{ upToInputTokens: 128, price: '4', thinkingPrice: '8' }, { upToInputTokens: 256, price: '12', thinkingPrice: '24' }, { upToInputTokens: 1024, price: '20', thinkingPrice: '40' }] },
  ] });
}
