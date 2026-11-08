import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedDatabase } from './database-fixture';
// Intentionally bind the application tables before creating the fixture.
import { database, closeDatabase } from '../src/core/db';
import { namespace } from '../src/core/db/schema';

test('an early application schema import fails before any application database access', { timeout: 120000 }, async () => {
  const fixture = await isolatedDatabase();
  try {
    assert.notEqual(namespace.schemaName, fixture.schema);
    assert.throws(() => database(), /DATABASE_SCHEMA_BINDING_MISMATCH/);
    const [row] = await fixture.owner.unsafe<{ count: number }[]>(`select count(*)::int as count from "${fixture.schema}"."user"`);
    assert.equal(row!.count, 0);
    console.log(JSON.stringify({ fixtureSchema: fixture.schema, staleBindingRejected: true, applicationQueries: 0 }));
  } finally { await closeDatabase(); await fixture.cleanup(); }
});
