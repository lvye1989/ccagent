import './load-env';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { databaseSchema, databaseUrl } from '../src/core/env';
import { databaseOptions } from '../src/core/db/options';
import { requiredDatabaseContract } from '../src/core/db/migration-contract';
import { assertMigrationContract } from './lib/migration-contract';

assertMigrationContract(requiredDatabaseContract);
const schema = databaseSchema();
if (schema !== 'ccagent') throw new Error('Use the isolated test migration helper for test schemas');
const client = postgres(databaseUrl(true), databaseOptions(1));
try {
  await migrate(drizzle(client), { migrationsFolder: './migrations', migrationsSchema: schema, migrationsTable: '__drizzle_migrations' });
  const versions = await client`select count(*)::integer as count from ccagent.__drizzle_migrations`;
  console.log(JSON.stringify({ migrated: true, schema, appliedVersions: versions[0].count }));
} catch (error) {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  console.error(JSON.stringify({ migrated: false, code: cause instanceof Error && 'code' in cause ? String(cause.code) : 'MIGRATION_FAILED',
    message: cause instanceof Error ? cause.message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted]') : 'Unknown migration failure' }));
  process.exitCode = 1;
} finally { await client.end({ timeout: 5 }); }
