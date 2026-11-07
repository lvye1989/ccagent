import './load-env';
import { randomBytes } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import postgres from 'postgres';
import { databaseUrl } from '../src/core/env';
import { databaseOptions } from '../src/core/db/options';
import { grantRuntimeAccess } from '../src/core/db/runtime-permissions';

const owner = postgres(databaseUrl(true), databaseOptions(1));
const role = 'ccagent_runtime';
try {
  const exists = await owner`select 1 from pg_roles where rolname = ${role}`;
  if (exists.length && !process.env.DATABASE_URL) throw new Error('RUNTIME_ROLE_EXISTS_WITHOUT_LOCAL_CREDENTIAL');
  const url = new URL(process.env.DATABASE_URL || databaseUrl());
  if (!exists.length) {
    const password = randomBytes(36).toString('base64url');
    // DDL cannot use a bind parameter in PASSWORD; PostgreSQL quotes it with %L.
    const [statement] = await owner`select format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', ${role}::text, ${password}::text) as ddl`;
    await owner.unsafe(statement.ddl);
    const oldUsername = decodeURIComponent(url.username);
    const suffix = oldUsername.includes('.') ? oldUsername.slice(oldUsername.indexOf('.')) : '';
    url.username = role + suffix;
    url.password = password;
    // The only plaintext destination is the already ignored server env file.
    await appendFile('.env.local', `\nDATABASE_URL=${JSON.stringify(url.toString())}\n`, { mode: 0o600 });
  }
  await grantRuntimeAccess(owner, 'ccagent');
  const runtime = postgres(url.toString(), databaseOptions(1));
  try {
    const [who] = await runtime`select current_user as role`;
    const [permissions] = await runtime`select has_table_privilege(current_user, 'ccagent.wallets', 'UPDATE') as wallet_update, has_table_privilege(current_user, 'ccagent.ledger', 'DELETE') as ledger_delete, has_schema_privilege(current_user, 'public', 'CREATE') as public_create`;
    await runtime`select id from ccagent.user limit 1`;
    if (who.role !== role || permissions.wallet_update || permissions.ledger_delete || permissions.public_create) throw new Error('RUNTIME_PRIVILEGES_INVALID');
    console.log(JSON.stringify({ configured: true, role: who.role, directWalletWrite: false, directLedgerDelete: false, schemaCreate: false }));
  } finally { await runtime.end({ timeout: 5 }); }
} catch (error) {
  console.error(JSON.stringify({ configured: false, code: error instanceof Error && 'code' in error ? String(error.code) : error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'RUNTIME_CONFIGURATION_FAILED' }));
  process.exitCode = 1;
} finally { await owner.end({ timeout: 5 }); }
