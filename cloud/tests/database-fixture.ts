import '../scripts/load-env';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { databaseUrl } from '../src/core/env';

export async function isolatedDatabase() {
  const schema = `ccagent_test_${randomBytes(8).toString('hex')}`;
  const url = databaseUrl(true);
  const owner = postgres(url, { prepare: false, max: 8, ssl: 'require', connect_timeout: 15, onnotice: () => {} });
  const folder = await mkdtemp(path.join(os.tmpdir(), 'ccagent-db-test-'));
  await mkdir(path.join(folder, 'meta'));
  const files = (await readdir('migrations')).filter(file => file.endsWith('.sql'));
  for (const file of files) {
    const body = (await readFile(path.join('migrations', file), 'utf8')).replaceAll('"ccagent"', `"${schema}"`).replaceAll("'ccagent'", `'${schema}'`);
    await writeFile(path.join(folder, file), body);
  }
  await writeFile(path.join(folder, 'meta', '_journal.json'), await readFile('migrations/meta/_journal.json'));
  const apply = () => migrate(drizzle(owner), { migrationsFolder: folder, migrationsSchema: schema, migrationsTable: '__drizzle_migrations' });
  const cleanup = async () => {
    if (!/^ccagent_test_[a-f0-9]{16}$/.test(schema)) throw new Error('REFUSE_UNSCOPED_CLEANUP');
    await owner.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await owner.end({ timeout: 5 });
    if (path.dirname(path.resolve(folder)) !== path.resolve(os.tmpdir()) || !path.basename(folder).startsWith('ccagent-db-test-')) throw new Error('REFUSE_UNSCOPED_FILE_CLEANUP');
    await rm(folder, { recursive: true, force: true });
  };
  try { await apply(); }
  catch (error) { await cleanup(); throw error; }
  // Set before dynamically importing the schema and runtime clients.
  process.env.DB_SCHEMA = schema;
  process.env.DATABASE_URL = url;
  process.env.DB_MAX_CONNECTIONS = '8';
  return { owner, schema, apply, cleanup };
}
