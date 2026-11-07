import './load-env';
import postgres from 'postgres';
import { databaseSchema, databaseUrl } from '../src/core/env';
import { databaseOptions } from '../src/core/db/options';
import { inspectDatabaseStructure, type AppliedMigration } from '../src/core/db/migration-state';
import { requiredDatabaseContract } from '../src/core/db/migration-contract';
import { assertMigrationContract } from './lib/migration-contract';

assertMigrationContract(requiredDatabaseContract);
const client = postgres(databaseUrl(), databaseOptions(1));
let connected = false;
try {
  await client`select 1 as connected`;
  connected = true;
  const tables = await client<{ table_name: string }[]>`select table_name from information_schema.tables where table_schema = ${databaseSchema()} and table_type='BASE TABLE'`;
  const names = tables.map(table => table.table_name);
  const applied = names.includes('__drizzle_migrations') ? await client.unsafe<AppliedMigration[]>(`select hash,created_at::text as "createdAt" from "${databaseSchema()}".__drizzle_migrations order by created_at`) : [];
  const structure = inspectDatabaseStructure(applied, names, databaseSchema());
  console.log(JSON.stringify({ connected, checked: true, schema: databaseSchema(), tableCount: names.length, structure,
    authSecretConfigured: (process.env.AUTH_SECRET?.length || 0) >= 32, emailKeyConfigured: !!process.env.RESEND_API_KEY }));
  if (!structure.ready) process.exitCode = 1;
} catch (error) {
  // Do not print connection options, DSNs or upstream error objects.
  console.error(JSON.stringify({ connected, checked: false, code: error instanceof Error && 'code' in error ? String(error.code) : 'DATABASE_CHECK_FAILED' }));
  process.exitCode = 1;
} finally { await client.end({ timeout: 5 }); }
