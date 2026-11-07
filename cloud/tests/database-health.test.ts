import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { isolatedDatabase } from './database-fixture';

test('database health distinguishes pending migrations, digest conflicts and missing tables using the real runtime role', { timeout: 240000 }, async t => {
  const fixture = await isolatedDatabase({ migrationCount: 3 });
  const { databaseOverview } = await import('../src/core/admin-data');
  const { closeDatabase } = await import('../src/core/db');
  const check = () => {
    const result = spawnSync(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/check-database.ts'], { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(result.error, undefined); return { exit: result.status, body: JSON.parse(result.stdout.trim()) };
  };
  try {
    await t.test('three valid applied versions report pending rather than current and CLI exits nonzero', async () => {
      const overview = await databaseOverview();
      assert.equal(overview.connected, true); assert.equal(overview.structure.ready, false);
      assert.equal(overview.structure.migrations.state, 'pending'); assert.equal(overview.structure.migrations.applied, 3); assert.equal(overview.structure.migrations.expected, 4);
      assert.equal(overview.structure.tables.current, true); assert.ok(overview.counts);
      const result = check(); assert.equal(result.exit, 1); assert.equal(result.body.connected, true); assert.equal(result.body.structure.migrations.state, 'pending');
    });
    await t.test('applying the current fourth migration restores healthy structure and CLI success', async () => {
      await fixture.applyAll();
      const overview = await databaseOverview(); assert.equal(overview.structure.ready, true); assert.equal(overview.migrationVersions, 4);
      const result = check(); assert.equal(result.exit, 0); assert.equal(result.body.structure.ready, true); assert.equal(result.body.tableCount, 22);
    });
    await t.test('a journal digest mismatch is a conflict even when the count is correct', async () => {
      const [row] = await fixture.owner.unsafe(`select id,hash from "${fixture.schema}".__drizzle_migrations order by created_at desc limit 1`);
      await fixture.owner.unsafe(`update "${fixture.schema}".__drizzle_migrations set hash=$1 where id=$2`, ['f'.repeat(64), row!.id]);
      try {
        const overview = await databaseOverview(); assert.equal(overview.migrationVersions, 4); assert.equal(overview.structure.migrations.state, 'conflict'); assert.equal(overview.structure.ready, false);
        assert.equal(check().exit, 1);
      } finally { await fixture.owner.unsafe(`update "${fixture.schema}".__drizzle_migrations set hash=$1 where id=$2`, [row!.hash, row!.id]); }
    });
    await t.test('missing required table suppresses statistics rather than inventing zero or claiming healthy', async () => {
      await fixture.owner.unsafe(`drop table "${fixture.schema}".prices`);
      const overview = await databaseOverview(['orders.read', 'refunds.write', 'usage.read']);
      assert.equal(overview.connected, true); assert.equal(overview.structure.ready, false); assert.deepEqual(overview.structure.tables.missing, ['prices']);
      assert.equal(overview.counts, null); assert.deepEqual(overview.pending, {}); assert.equal(overview.lastMaintenanceChecked, false);
      const result = check(); assert.equal(result.exit, 1); assert.equal(result.body.connected, true); assert.deepEqual(result.body.structure.tables.missing, ['prices']);
    });
  } finally { await closeDatabase(); await fixture.cleanup(); }
});
