import '../scripts/load-env';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { databaseUrl } from '../src/core/env';
import { databaseOptions } from '../src/core/db/options';
import { grantRuntimeAccess } from '../src/core/db/runtime-permissions';

export async function isolatedDatabase(options: { migrationCount?: number } = {}) {
  const mode = process.env.CCAGENT_TEST_BUSINESS_DATABASE || 'runtime';
  if (!['runtime', 'owner-session'].includes(mode)) throw new Error('INVALID_FIXTURE_DATABASE_MODE');
  const runtimeUrl = databaseUrl();
  const journal = JSON.parse(await readFile('migrations/meta/_journal.json', 'utf8'));
  const completeJournal = structuredClone(journal);
  if (options.migrationCount !== undefined) {
    if (!Number.isInteger(options.migrationCount) || options.migrationCount < 1 || options.migrationCount > journal.entries.length) throw new Error('INVALID_FIXTURE_MIGRATION_COUNT');
    journal.entries = journal.entries.slice(0, options.migrationCount);
  }
  const schema = `ccagent_test_${randomBytes(8).toString('hex')}`;
  const url = databaseUrl(true);
  const owner = postgres(url, databaseOptions(8));
  const folder = await mkdtemp(path.join(os.tmpdir(), 'ccagent-db-test-'));
  await mkdir(path.join(folder, 'meta'));
  const files = (await readdir('migrations')).filter(file => file.endsWith('.sql'));
  for (const file of files) {
    const body = (await readFile(path.join('migrations', file), 'utf8')).replaceAll('"ccagent"', `"${schema}"`).replaceAll("'ccagent'", `'${schema}'`);
    await writeFile(path.join(folder, file), body);
  }
  await writeFile(path.join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
  const apply = () => migrate(drizzle(owner), { migrationsFolder: folder, migrationsSchema: schema, migrationsTable: '__drizzle_migrations' });
  const applyAll = async () => { await writeFile(path.join(folder, 'meta', '_journal.json'), JSON.stringify(completeJournal)); await apply(); };
  const cleanup = async () => {
    if (!/^ccagent_test_[a-f0-9]{16}$/.test(schema)) throw new Error('REFUSE_UNSCOPED_CLEANUP');
    try { await owner.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await owner.end({ timeout: 5 }); }
    if (path.dirname(path.resolve(folder)) !== path.resolve(os.tmpdir()) || !path.basename(folder).startsWith('ccagent-db-test-')) throw new Error('REFUSE_UNSCOPED_FILE_CLEANUP');
    await rm(folder, { recursive: true, force: true });
  };
  try {
    await apply();
    if (mode === 'runtime') {
      await grantRuntimeAccess(owner, schema);
      const runtime = postgres(runtimeUrl, databaseOptions(1));
      try {
        const [identity] = await runtime`select current_user as role`;
        if (identity!.role !== 'ccagent_runtime') throw new Error('FIXTURE_REQUIRES_RUNTIME_ROLE');
      } finally { await runtime.end({ timeout: 5 }); }
    }
  }
  catch (error) { await cleanup(); throw error; }
  // Set before dynamically importing the schema and runtime clients.
  process.env.DB_SCHEMA = schema;
  process.env.DATABASE_URL = mode === 'runtime' ? runtimeUrl : url;
  process.env.DB_MAX_CONNECTIONS = '8';
  return { owner, schema, apply, applyAll, cleanup };
}
