import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { databaseMaxConnections, databaseSchema, databaseUrl } from '../env';
import * as schema from './schema';
import { databaseOptions } from './options';

function createDatabase() {
  const client = postgres(databaseUrl(), databaseOptions(databaseMaxConnections()));
  return { client, db: drizzle(client, { schema }) };
}
type Database = ReturnType<typeof createDatabase>;
export type DatabaseReader = Pick<Database['db'], 'select'>;
const globalDatabase = globalThis as typeof globalThis & { ccagentDatabase?: Database };
let instance: Database | undefined;
export function database(): Database {
  // Drizzle table namespaces are bound at import time. Never send a cached table
  // binding to a different schema after runtime configuration changes (e.g. tests).
  if (schema.namespace.schemaName !== databaseSchema()) throw new Error('DATABASE_SCHEMA_BINDING_MISMATCH');
  if (process.env.DB_SINGLETON_ENABLED !== 'false') return globalDatabase.ccagentDatabase ??= createDatabase();
  return instance ??= createDatabase();
}
export async function closeDatabase(): Promise<void> {
  const value = globalDatabase.ccagentDatabase || instance;
  delete globalDatabase.ccagentDatabase;
  instance = undefined;
  if (value) await value.client.end({ timeout: 5 });
}
