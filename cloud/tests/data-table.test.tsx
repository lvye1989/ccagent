import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DataTable } from '../src/components/data-table';
import * as React from 'react';

test('table server rendering shows explicit-offset dates in Beijing time without changing ordinary text or CSV data', () => {
  const rows = [{ created_at: '2026-11-06 16:00:00+00', reconcile_at: '2026-11-07T15:59:59.999999Z', updated_at: new Date('2026-11-07T04:00:00Z'),
    name: '2026-11-06 16:00:00+00', revoked_at: null }];
  const html = renderToStaticMarkup(<DataTable rows={rows} />);
  assert(html.includes('2026/11/7 00:00:00')); assert(html.includes('2026/11/7 23:59:59')); assert(html.includes('2026/11/7 12:00:00'));
  assert(html.includes('2026-11-06 16:00:00+00')); assert(html.includes('—')); assert.equal(rows[0]!.created_at, '2026-11-06 16:00:00+00');
  const invalid = renderToStaticMarkup(<DataTable rows={[{ created_at: 'not-a-date', task_id: '2026-11-06T16:00:00Z' }]} />);
  assert(invalid.includes('not-a-date')); assert(invalid.includes('2026-11-06T16:00:00Z'));
});

test('table money columns and nested usage show exact yuan while preserving raw accounting inputs', () => {
  const rows = [{ roles: 'admin', user_balance: '9007199254740993', balance_delta: '-1', amount_fen: '12345', charged: '1', calls: '1000000',
    usage: { publicCostMicro: '2', platformAbsorbedMicro: '1', quantities: { input_tokens: '1000000' } } }];
  const html = renderToStaticMarkup(<DataTable rows={rows} />);
  assert(html.includes('用户余额（元）')); assert(html.includes('9007199254.740993'));
  assert(html.includes('余额变动（元）')); assert(html.includes('-0.000001'));
  assert(html.includes('充值金额（元）')); assert(html.includes('123.45')); assert(html.includes('0.000001'));
  assert(html.includes('公开成本（元）')); assert(html.includes('0.000002')); assert(html.includes('平台承担费用（元）'));
  assert(!html.includes('微元')); assert.equal(rows[0]!.user_balance, '9007199254740993'); assert.equal(rows[0]!.usage.publicCostMicro, '2');
  const unlimited = renderToStaticMarkup(<DataTable rows={[{ limit: null, frozen: null, charged: '1' }]} />);
  assert(unlimited.includes('不单独限制')); assert(unlimited.includes('—')); assert(unlimited.includes('0.000001'));
  const limited = renderToStaticMarkup(<DataTable rows={[{ limit: '100000000' }]} />);
  assert(limited.includes('100.00')); assert(!limited.includes('不单独限制'));
});
