import postgres from 'postgres';
import { databaseOptions } from '../src/core/db/options';
if (process.env.CI !== 'true') throw new Error('CI_ONLY');
const url = new URL(process.env.DATABASE_MIGRATION_URL || '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/ccagent_ci') throw new Error('REFUSE_NONFIXTURE_DATABASE');
const client = postgres(url.href, databaseOptions(1));
try {
  // Only this disposable CI service uses this public, nonproduction password.
  await client.unsafe("CREATE ROLE ccagent_runtime LOGIN PASSWORD 'ci-runtime-only'");
  // Mirror the no-access platform roles checked by the financial grant tests.
  for (const role of ['anon', 'authenticated', 'service_role']) await client.unsafe(`CREATE ROLE ${role} NOLOGIN`);
} finally { await client.end({ timeout: 5 }); }
