import { requiredDatabaseContract } from './migration-contract';
import { createHash } from 'node:crypto';

export type AppliedMigration = { hash: string; createdAt: string };
export function inspectDatabaseStructure(applied: readonly AppliedMigration[], tables: readonly string[], schema = 'ccagent') {
  const expected = requiredDatabaseContract.migrations;
  const prefix = applied.length <= expected.length && applied.every((value, index) => {
    const target = expected[index];
    const hash = target && (schema === 'ccagent' ? target.hash : createHash('sha256').update(target.schemaParts.join(schema)).digest('hex'));
    return value.hash === hash && value.createdAt === target?.createdAt;
  });
  const migrationState = !prefix ? 'conflict' : applied.length === expected.length ? 'current' : 'pending';
  const existing = new Set(tables), required = new Set<string>(requiredDatabaseContract.tables);
  const missingTables = requiredDatabaseContract.tables.filter(name => !existing.has(name));
  const unexpectedTables = tables.filter(name => !required.has(name)).length;
  const tablesCurrent = !missingTables.length && !unexpectedTables;
  return { ready: migrationState === 'current' && tablesCurrent, migrations: { state: migrationState, applied: applied.length, expected: expected.length },
    tables: { current: tablesCurrent, actual: existing.size, expected: required.size, missing: missingTables, unexpected: unexpectedTables } };
}
