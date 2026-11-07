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
