import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { databaseMaxConnections, databaseUrl } from '../env';
import * as schema from './schema';

function createDatabase() {
  const client = postgres(databaseUrl(), { prepare: false, max: databaseMaxConnections(), idle_timeout: 20, connect_timeout: 15,
    ssl: 'require', onnotice: () => {} });
  return { client, db: drizzle(client, { schema }) };
}
type Database = ReturnType<typeof createDatabase>;
const globalDatabase = globalThis as typeof globalThis & { ccagentDatabase?: Database };
let instance: Database | undefined;
export function database(): Database {
  if (process.env.DB_SINGLETON_ENABLED !== 'false') return globalDatabase.ccagentDatabase ??= createDatabase();
  return instance ??= createDatabase();
}
export async function closeDatabase(): Promise<void> {
  const value = globalDatabase.ccagentDatabase || instance;
  delete globalDatabase.ccagentDatabase;
  instance = undefined;
  if (value) await value.client.end({ timeout: 5 });
}
