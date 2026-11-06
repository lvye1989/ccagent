import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { isolatedDatabase } from './database-fixture';

test('versioned service catalogue, exact tariff quotes and route-price binding', { timeout: 150000 }, async t => {
  const fixture = await isolatedDatabase();
  const { database, closeDatabase } = await import('../src/core/db');
  const tables = await import('../src/core/db/schema');
  const { routeInput, priceDefinition, quoteDefinition, selectedTariff, saveRoute, createPriceVersion, publishedRoute, validateUpstreamHost } = await import('../src/core/catalog');
  const { saveConfiguration } = await import('../src/core/configuration');
  const actor = randomUUID(), credentialEnv = 'CCAGENT_PROVIDER_CATALOG_FIXTURE';
  delete process.env[credentialEnv];
  const sourceUrl = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
  const route = routeInput.parse({ id: 'catalog-fixture', name: 'Catalogue fixture', service: 'chat', protocol: 'openai-responses', provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com', upstreamModel: 'deepseek-flash', credentialEnv, options: {} });
  const constant = priceDefinition.parse({ rates: [{ metric: 'input_tokens', price: '2', unitQuantity: '1000000' }, { metric: 'cached_input_tokens', price: '0', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '0', unitQuantity: '1000000' }], tariff: { kind: 'constant' } });
  const temporal = priceDefinition.parse({ rates: [
    { metric: 'input_tokens', price: '2', offPeakPrice: '1', unitQuantity: '1000000' },
    { metric: 'cached_input_tokens', price: '0.04', offPeakPrice: '0.02', unitQuantity: '1000000' },
    { metric: 'output_tokens', price: '8', offPeakPrice: '4', unitQuantity: '1000000' },
  ], tariff: { kind: 'deepseek', calendarYear: 2026, holidays: ['2026-10-01'], calendarSourceUrl: 'https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html' } });
  try {
    await database().db.insert(tables.user).values({ id: actor, name: 'Catalogue fixture', email: `${actor}@example.invalid`, emailVerified: true });
    await t.test('protocol and secret-reference validation cannot turn a decision endpoint into chat or expose arbitrary env secrets', () => {
      assert.equal(routeInput.safeParse({ ...route, service: 'decision' }).success, false);
      assert.equal(routeInput.safeParse({ ...route, credentialEnv: 'AUTH_SECRET' }).success, false);
      assert.throws(() => validateUpstreamHost('https://169.254.169.254/metadata'), { status: 400 });
      assert.throws(() => validateUpstreamHost('https://unconfigured.example.invalid'), { status: 400 });
      assert.equal(routeInput.safeParse({ ...route, baseUrl: 'https://api.deepseek.com/?key=secret' }).success, false);
    });
    await t.test('DeepSeek peak boundaries, weekends and holiday dates select the published tariff', () => {
      for (const [date, expected] of [['2026-11-06T01:00:00Z', 'peak'], ['2026-11-06T03:59:59Z', 'peak'], ['2026-11-06T04:00:00Z', 'off-peak'],
        ['2026-11-06T06:00:00Z', 'peak'], ['2026-11-06T10:00:00Z', 'off-peak'], ['2026-11-07T01:00:00Z', 'off-peak'], ['2026-10-01T01:00:00Z', 'off-peak']]) {
        assert.equal(selectedTariff(temporal, new Date(date)), expected);
      }
      assert.equal(selectedTariff(temporal, new Date('2026-11-07T01:00:00Z'), true), 'peak');
      assert.throws(() => selectedTariff(temporal, new Date('2027-01-01T00:00:00Z')), { status: 503 });
    });
    await t.test('cache, output and public cost aggregate exactly before the 1.3 multiplier', () => {
      const quantities = { input_tokens: 1000000n, cached_input_tokens: 1000000n, output_tokens: 1000000n };
      const peak = quoteDefinition(temporal, 'CNY', quantities, new Date('2026-11-06T01:00:00Z'));
      assert.equal(peak.publicCostMicro, 10040000n); assert.equal(peak.chargeMicro, 13052000n);
      assert.equal(quoteDefinition(temporal, 'CNY', quantities, new Date('2026-11-07T01:00:00Z')).chargeMicro, 6526000n);
      assert.throws(() => quoteDefinition(constant, 'CNY', { input_tokens: 1n, image_input_tokens: 1n }, new Date()), { status: 503 });
      assert.throws(() => quoteDefinition(constant, 'CNY', {}, new Date()), { status: 503 });
    });
    await t.test('invalid calendars and unsafe upper-bound tariffs are rejected before publishing', () => {
      assert.equal(priceDefinition.safeParse({ ...temporal, tariff: { ...temporal.tariff, holidays: ['2026-02-30'] } }).success, false);
      assert.equal(priceDefinition.safeParse({ ...temporal, rates: [{ metric: 'input_tokens', price: '1', offPeakPrice: '2', unitQuantity: '1' }] }).success, false);
      assert.equal(priceDefinition.safeParse({ ...constant, rates: [...constant.rates, ...constant.rates] }).success, false);
    });
    await t.test('unpriced or uncredentialed routes cannot become enabled', async () => {
      await saveRoute(actor, route);
      await assert.rejects(() => publishedRoute(route.id), { status: 404 });
      await assert.rejects(() => saveRoute(actor, { ...route, enabled: true }), { status: 409 });
      const first = await createPriceVersion(actor, { routeId: route.id, currency: 'CNY', definition: constant, sourceUrl, effectiveAt: new Date(Date.now() - 5000).toISOString() });
      assert.equal(first.version, 1);
      await assert.rejects(() => saveRoute(actor, { ...route, enabled: true }), { status: 409 });
      process.env[credentialEnv] = 'fixture-value-never-sent-upstream';
      await saveRoute(actor, { ...route, enabled: true });
      assert.equal((await publishedRoute(route.id)).price.version, 1);
    });
    await t.test('new versions are append-only and a model change disables the old cost binding', async () => {
      const second = await createPriceVersion(actor, { routeId: route.id, currency: 'CNY', definition: constant, sourceUrl, effectiveAt: new Date(Date.now() - 1000).toISOString() });
      assert.equal(second.version, 2);
      assert.equal((await publishedRoute(route.id)).price.id, second.id);
      await assert.rejects(() => database().db.update(tables.prices).set({ currency: 'USD' }).where(eq(tables.prices.id, second.id)));
      const changed = { ...route, upstreamModel: 'different-fixture-model', enabled: true };
      const saved = await saveRoute(actor, changed);
      assert.equal(saved.enabled, false); assert.equal(saved.repricingRequired, true);
      await assert.rejects(() => publishedRoute(route.id), { status: 404 });
      await assert.rejects(() => saveRoute(actor, changed), { status: 409 });
      const third = await createPriceVersion(actor, { routeId: route.id, currency: 'CNY', definition: constant, sourceUrl, effectiveAt: new Date(Date.now() - 1000).toISOString() });
      assert.equal(third.version, 3);
      await saveRoute(actor, changed);
      assert.equal((await publishedRoute(route.id)).price.version, 3);
    });
    await t.test('USD price requires a configured settlement FX and quotes a stable explicit snapshot', async () => {
      const current = (await database().db.select().from(tables.routes).where(eq(tables.routes.id, route.id)))[0];
      const dollar = priceDefinition.parse({ rates: [{ metric: 'input_tokens', price: '2.5', unitQuantity: '1000000' }, { metric: 'cached_input_tokens', price: '0', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '0', unitQuantity: '1000000' }], tariff: { kind: 'constant' } });
      await createPriceVersion(actor, { routeId: route.id, currency: 'USD', definition: dollar, sourceUrl, effectiveAt: new Date(Date.now() - 1000).toISOString() });
      await assert.rejects(() => publishedRoute(route.id), { status: 503 });
      await saveConfiguration(actor, { changes: [{ key: 'settlement_usd_cny', value: '7.2', version: 0 }] });
      await saveRoute(actor, routeInput.parse({ ...route, upstreamModel: current.upstreamModel, enabled: true }));
      const selection = await publishedRoute(route.id);
      const quote = quoteDefinition(selection.definition, selection.currency, { input_tokens: 1000000n, cached_input_tokens: 0n, output_tokens: 0n }, new Date(), selection.usdCny || undefined);
      assert.equal(selection.usdCny, '7.2'); assert.equal(quote.chargeMicro, 23400000n);
      await saveConfiguration(actor, { changes: [{ key: 'settlement_usd_cny', value: '7.3', version: 1 }] });
      assert.equal(selection.usdCny, '7.2');
      assert.equal((await publishedRoute(route.id)).usdCny, '7.3');
    });
  } finally { delete process.env[credentialEnv]; await closeDatabase(); await fixture.cleanup(); }
});
