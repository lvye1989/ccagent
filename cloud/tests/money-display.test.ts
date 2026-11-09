import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayMoneyValue, formatFenYuan, formatMicroYuan, moneyColumnLabel, parseYuanToMicro, presentMoneyDetails } from '../src/core/money-display';

test('yuan display preserves tiny fees, signed ledger movements and integers beyond Number precision', () => {
  assert.equal(formatMicroYuan('1'), '0.000001');
  assert.equal(formatMicroYuan('-1'), '-0.000001');
  assert.equal(formatMicroYuan('-1234567'), '-1.234567');
  assert.equal(formatMicroYuan(100000n), '0.10');
  assert.equal(formatMicroYuan('9007199254740993'), '9007199254.740993');
  assert.equal(formatMicroYuan('9223372036854775807'), '9223372036854.775807');
  assert.throws(() => formatMicroYuan(Number.MAX_SAFE_INTEGER + 1));
});
test('yuan input parses exactly and never rounds excess precision, exponent notation or negative limits', () => {
  assert.equal(parseYuanToMicro('0'), '0');
  assert.equal(parseYuanToMicro(' 12.340001 '), '12340001');
  assert.equal(parseYuanToMicro('0.000001'), '1');
  assert.equal(parseYuanToMicro('9223372036854.775807'), '9223372036854775807');
  for (const value of ['0.0000001', '1e2', 'NaN', '1,000', '-1', '+1', '01.00', '', '9223372036854.775808']) assert.throws(() => parseYuanToMicro(value));
  assert.throws(() => parseYuanToMicro('9000000000.000001', { maxMicro: 9_000_000_000_000_000n }));
  assert.equal(parseYuanToMicro('-0.000001', { allowNegative: true }), '-1');
  assert.equal(parseYuanToMicro('-0', { allowNegative: true }), '0');
});
test('payment fen and monetary column projections use yuan without mutating original records', () => {
  assert.equal(formatFenYuan('1'), '0.01');
  assert.equal(formatFenYuan('12345'), '123.45');
  assert.equal(formatFenYuan('-1'), '-0.01');
  assert.equal(displayMoneyValue('amount_fen', '1250'), '12.50');
  assert.equal(displayMoneyValue('balance_delta', '-1'), '-0.000001');
  assert.equal(displayMoneyValue('user_balance', '1000000'), '1.00');
  assert.equal(displayMoneyValue('limit', null), null);
  assert.equal(displayMoneyValue('calls', '1000000'), '1000000');
  assert.equal(moneyColumnLabel('user_balance'), '用户余额（元）');
  assert.equal(moneyColumnLabel('constructor'), undefined);
});
test('nested cost and audit details identify yuan while keeping quantities and original supplier prices', () => {
  const original = { quantities: { input_tokens: '1000000' }, publicCostMicro: '1', userChargeMicro: '0', previousLimit: '100000000',
    entries: [{ balanceDelta: '-5', amountFen: '100' }], components: { price: '2.5', currency: 'USD', unitQuantity: '1000000' } };
  assert.deepEqual(presentMoneyDetails(original), { quantities: { input_tokens: '1000000' }, '公开成本（元）': '0.000001', '用户扣费（元）': '0.00', '原累计额度（元）': '100.00',
    entries: [{ '余额变动（元）': '-0.000005', '充值金额（元）': '1.00' }], components: { price: '2.5', currency: 'USD', unitQuantity: '1000000' } });
  assert.equal(original.publicCostMicro, '1'); assert.equal(original.entries[0]!.balanceDelta, '-5');
});
