import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GatewayPriceEditor, type GatewayPrice } from '../src/components/gateway-price-editor';
import { KieImageGuide, kieImageRequestExample } from '../src/components/kie-image-guide';
import { imageConfigurationOnly, kieImageCnyRates, kieImageMetrics, kieImageModels } from '../src/components/kie-image-configuration';
import { priceDefinition, usageMetric } from '../../src/platform/pricingDefinition';

test('KIE image public cost converts the saved FX exactly into three per-image CNY fields', () => {
  const rates = kieImageCnyRates('6.7188');
  assert.deepEqual(rates, [
    { metric: 'output_images_1k', price: '0.201564', unitQuantity: '1' },
    { metric: 'output_images_2k', price: '0.33594', unitQuantity: '1' },
    { metric: 'output_images_4k', price: '0.537504', unitQuantity: '1' },
  ]);
  assert.deepEqual(kieImageCnyRates('7.123456').map(rate => rate.price), ['0.21370368', '0.3561728', '0.56987648']);
  assert.deepEqual(kieImageCnyRates('100').map(rate => rate.price), ['3', '5', '8']);
  for (const invalid of ['', '0', 'NaN', '-1', '6,7', '06.7188', '1e2', '7.1234567']) assert.throws(() => kieImageCnyRates(invalid));
  const definition = priceDefinition.parse({ rates, tariff: { kind: 'constant' } });
  assert.deepEqual(definition.rates, rates);
  for (const metric of kieImageMetrics) assert.equal(usageMetric.parse(metric), metric);
});

test('KIE is executable while existing image placeholders remain configuration-only', () => {
  assert.equal(imageConfigurationOnly('image', 'kie-images'), false);
  for (const protocol of ['openai-images', 'dashscope-images']) assert.equal(imageConfigurationOnly('image', protocol), true);
  assert.equal(imageConfigurationOnly('chat', 'openai-chat'), false);
  assert.equal(kieImageModels.length, 4);
  assert.equal(new Set(kieImageModels.map(([id]) => id)).size, 4);
});

test('image price editor renders saved actual yuan values and preserves historical prices on reload', () => {
  const initial: GatewayPrice = { version: 4, currency: 'CNY', sourceUrl: 'https://kie.ai/gpt-image-2-5', components: {
    definition: { rates: kieImageCnyRates('6.7188'), tariff: { kind: 'constant' } },
  } };
  const html = renderToStaticMarkup(<GatewayPriceEditor routeId="kie-flare" expectedRouteFingerprint={'a'.repeat(64)} initial={initial} service="image" protocol="kie-images" upstreamModel={kieImageModels[0][0]} onSaved={() => {}} />);
  for (const value of ['0.201564', '0.33594', '0.537504']) assert(html.includes(`value="${value}"`));
  for (const label of ['1K 输出图片（张）', '2K 输出图片（张）', '4K 输出图片（张）']) assert(html.includes(label));
  assert(!html.includes('当前不可开放'));
  assert(html.includes('按后台默认汇率填入人民币单价'));
  const old = structuredClone(initial);
  (old.components.definition as { rates: { price: string }[] }).rates[0]!.price = '0.123456';
  const reloaded = renderToStaticMarkup(<GatewayPriceEditor routeId="kie-flare" expectedRouteFingerprint={'b'.repeat(64)} initial={old} service="image" protocol="kie-images" onSaved={() => {}} />);
  assert(reloaded.includes('value="0.123456"'));
  const qwen = renderToStaticMarkup(<GatewayPriceEditor routeId="qwen-image" expectedRouteFingerprint={'a'.repeat(64)} initial={null} service="image" protocol="dashscope-images" upstreamModel="qwen-image-3.0" onSaved={() => {}} />);
  assert(qwen.includes('当前不可开放')); assert(qwen.includes('输入图片（张）')); assert(!qwen.includes('按后台默认汇率填入人民币单价'));
});

test('platform image example uses owned file references and task polling without supplier secrets', () => {
  const text = kieImageRequestExample('kie-flare-text', kieImageModels[0][0]);
  const edit = kieImageRequestExample('kie-flare-edit', kieImageModels[1][0]);
  assert(text.startsWith('POST /v1/images/tasks')); assert(text.includes('GET /v1/images/tasks/'));
  assert(!text.includes('input_images')); assert(edit.includes('ccagent-file:'));
  for (const value of [text, edit]) { assert(!value.includes('input_urls')); assert(!value.includes('Bearer')); assert(!value.includes('api.kie.ai')); }
  const guide = renderToStaticMarkup(<KieImageGuide routeId={'<script>unsafe</script>'} upstreamModel={kieImageModels[1][0]} />);
  assert(!guide.includes('<script>unsafe</script>')); assert(guide.includes('&lt;script&gt;'));
  for (const parameter of ['aspect_ratio', 'resolution', 'background', 'input_images']) assert(guide.includes(parameter));
  assert(guide.includes('不会取消已提交的上游生成任务'));
});
