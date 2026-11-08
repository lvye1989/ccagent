import './load-env';
import postgres from 'postgres';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { databaseSchema, databaseUrl } from '../src/core/env';
import { databaseOptions } from '../src/core/db/options';
import { requiredDatabaseContract } from '../src/core/db/migration-contract';

// Read-only lifecycle verification. Never removes schemas, deployments or files.
const schemas = [...new Set(process.argv.slice(2))];
if (!schemas.length || schemas.some(schema => !/^ccagent_test_[a-f0-9]{16}$/.test(schema))) throw new Error('EXPLICIT_TEST_SCHEMA_NAMES_REQUIRED');
const client = postgres(databaseUrl(true), databaseOptions(1));
try {
  const present = await client<{ nspname: string }[]>`select nspname from pg_namespace where nspname = any(${schemas}::text[])`;
  const activity = await client<{ active: number; open_transactions: number; idle: number }[]>`select
    count(*) filter (where state='active')::int as active,
    count(*) filter (where state like 'idle in transaction%' or xact_start is not null)::int as open_transactions,
    count(*) filter (where state='idle' and xact_start is null)::int as idle from pg_stat_activity
    where pid <> pg_backend_pid() and exists (select 1 from unnest(${schemas}::text[]) as s(name) where query like '%' || name || '%')`;
  const migrations = await client.unsafe<{ count: number }[]>(`select count(*)::int as count from "${databaseSchema()}".__drizzle_migrations`);
  const filesRemoved = schemas.every(schema => !existsSync(path.resolve('..', 'output', 'playwright', `hosted-fixture-${schema}.json`))
    && !existsSync(path.resolve('..', 'output', 'playwright', `${schema}.stop`)));
  const result = { checkedAt: new Date().toISOString(), schemas, remainingSchemas: present.length, activeFixtureQueries: activity[0]!.active,
    openFixtureTransactions: activity[0]!.open_transactions, idleFixtureBackends: activity[0]!.idle,
    developmentMigrationCount: migrations[0]!.count, syntheticCredentialsAndStopFilesRemoved: filesRemoved };
  const passed = !result.remainingSchemas && !result.activeFixtureQueries && !result.openFixtureTransactions && result.developmentMigrationCount === requiredDatabaseContract.migrations.length && filesRemoved;
  console.log(JSON.stringify({ ...result, passed }));
  if (!passed) process.exitCode = 1;
} catch {
  console.error('TEST_CLEANUP_VERIFICATION_FAILED');
  process.exitCode = 1;
} finally { await client.end({ timeout: 5 }); }
