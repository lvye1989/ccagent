import { readMigrationFiles } from 'drizzle-orm/migrator';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as tables from '../../src/core/db/schema';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function currentMigrationContract() {
  const journal = JSON.parse(readFileSync('migrations/meta/_journal.json', 'utf8')) as { entries: { tag: string }[] };
  return {
    tables: [...Object.values(tables).filter(value => is(value, PgTable)).map(value => getTableName(value as PgTable)), '__drizzle_migrations'].sort(),
    migrations: readMigrationFiles({ migrationsFolder: 'migrations' }).map((value, index) => {
      const tag = journal.entries[index]!.tag;
      if (!/^\d{4}_[a-z0-9_]+$/.test(tag)) throw new Error('INVALID_MIGRATION_TAG');
      const body = readFileSync(path.join('migrations', `${tag}.sql`), 'utf8');
      // Keep quotes in the pieces; only the schema identifier/string changes, exactly as in the isolated migrator.
      const schemaParts = body.split(/(?<=")ccagent(?=")|(?<=')ccagent(?=')/);
      return { hash: value.hash, createdAt: String(value.folderMillis), schemaParts };
    }),
  };
}
export function assertMigrationContract(expected: unknown) {
  if (JSON.stringify(expected) !== JSON.stringify(currentMigrationContract())) throw new Error('MIGRATION_CONTRACT_OUTDATED');
}
