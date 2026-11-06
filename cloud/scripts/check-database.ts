import './load-env';
import postgres from 'postgres';
import { databaseSchema, databaseUrl } from '../src/core/env';

const client = postgres(databaseUrl(), { prepare: false, max: 1, ssl: 'require', connect_timeout: 15, onnotice: () => {} });
try {
  await client`select 1 as connected`;
  const tables = await client`select count(*)::integer as count from information_schema.tables where table_schema = ${databaseSchema()}`;
  console.log(JSON.stringify({ connected: true, schema: databaseSchema(), tableCount: tables[0].count, authSecretConfigured: (process.env.AUTH_SECRET?.length || 0) >= 32, emailKeyConfigured: !!process.env.RESEND_API_KEY }));
} catch (error) {
  // Do not print connection options, DSNs or upstream error objects.
  console.error(JSON.stringify({ connected: false, code: error instanceof Error && 'code' in error ? String(error.code) : 'DATABASE_CONNECTION_FAILED' }));
  process.exitCode = 1;
} finally { await client.end({ timeout: 5 }); }
