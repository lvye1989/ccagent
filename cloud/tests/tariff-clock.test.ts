import assert from 'node:assert/strict';
import { test } from 'node:test';
import { priceDefinition, selectedTariff } from '../src/core/catalog';

const calendar = (year: number) => priceDefinition.parse({ rates: [{ metric: 'input_tokens', price: '2', offPeakPrice: '1', unitQuantity: '1000000' }],
  tariff: { kind: 'deepseek', calendarYear: year, holidays: [], calendarSourceUrl: 'https://example.invalid/synthetic-calendar' } });

test('DeepSeek calendar starts at Beijing New Year rather than UTC New Year', () => {
  assert.equal(selectedTariff(calendar(2026), new Date('2025-12-31T16:00:00Z')), 'off-peak');
  assert.equal(selectedTariff(calendar(2027), new Date('2026-12-31T16:00:00Z')), 'off-peak');
});
test('DeepSeek old calendar expires exactly at Beijing midnight', () => {
  assert.equal(selectedTariff(calendar(2026), new Date('2026-12-31T15:59:59.999Z')), 'off-peak');
  assert.throws(() => selectedTariff(calendar(2026), new Date('2026-12-31T16:00:00Z')), { code: 'PRICE_CALENDAR_EXPIRED' });
});
test('Beijing weekday peak boundaries remain correct after the calendar year conversion', () => {
  const value = calendar(2026);
  for (const [at, expected] of [['2026-11-09T00:59:59Z', 'off-peak'], ['2026-11-09T01:00:00Z', 'peak'], ['2026-11-09T04:00:00Z', 'off-peak'], ['2026-11-09T06:00:00Z', 'peak'], ['2026-11-09T10:00:00Z', 'off-peak']] as const) assert.equal(selectedTariff(value, new Date(at)), expected);
});
