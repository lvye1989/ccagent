/** Public KIE GPT Image 2.5 contract. No provider credential belongs in client state. */
export const kieImageModels = [
  ['gpt-image-2-5-flare-text-to-image', 'GPT Image 2.5 Flare · 文生图'],
  ['gpt-image-2-5-flare-image-to-image', 'GPT Image 2.5 Flare · 图生图'],
  ['gpt-image-2-5-sunburst-text-to-image', 'GPT Image 2.5 Sunburst · 文生图'],
  ['gpt-image-2-5-sunburst-image-to-image', 'GPT Image 2.5 Sunburst · 图生图'],
] as const;
export const kieImagePriceSource = 'https://kie.ai/gpt-image-2-5';
export const kieImageBaseUrl = 'https://api.kie.ai/api/v1';
export const kieImageMetrics = ['output_images_1k', 'output_images_2k', 'output_images_4k'] as const;
export const kieImageUsdCents = [3, 5, 8] as const;
export function imageConfigurationOnly(service: string | undefined, protocol: string | undefined) {
  return service === 'image' && protocol !== 'kie-images';
}

/** Decimal arithmetic retains the configured FX exactly; never guesses a rate. */
export function kieImageCnyRates(usdCny: string) {
  if (!/^[1-9]\d{0,2}(?:\.\d{1,6})?$/.test(usdCny)) throw new Error('INVALID_USD_CNY');
  const [whole, fraction = ''] = usdCny.split('.');
  const scaledFx = BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  return kieImageMetrics.map((metric, index) => {
    const amount = scaledFx * BigInt(kieImageUsdCents[index]!);
    const price = `${amount / 100000000n}.${String(amount % 100000000n).padStart(8, '0')}`.replace(/\.?0+$/, '');
    return { metric, price, unitQuantity: '1' };
  });
}
