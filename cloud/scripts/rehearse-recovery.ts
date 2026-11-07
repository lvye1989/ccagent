import './load-env';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import postgres from 'postgres';
import { is, getTableName } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { hashPassword } from 'better-auth/crypto';
import { isolatedDatabase } from '../tests/database-fixture';
import { databaseUrl } from '../src/core/env';
import { databaseOptions } from '../src/core/db/options';
import { grantRuntimeAccess } from '../src/core/db/runtime-permissions';
import { remotePgEnvironment, runPostgresTool } from './lib/postgres-tools';

const checksum = (value: unknown) => createHash('sha256').update(Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const checks: string[] = [];
let phase = 'preflight';
const output = path.resolve('../output/checks/database-recovery', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(4).toString('hex'));
const connections: postgres.Sql[] = [];
let cluster = '', clusterStarted = false, fixture: Awaited<ReturnType<typeof isolatedDatabase>> | undefined;
let manifest: Record<string, unknown> | undefined, sourceCleaned = false;

async function check(name: string, run: () => Promise<void>) {
  phase = name; await run(); checks.push(name); console.log(JSON.stringify({ check: name, passed: true }));
}

function snapshotDetails(value: unknown) {
  if (!value || typeof value !== 'object' || !('structure' in value) || !('data' in value) ||
    !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) return undefined;
  return { structure: value.structure, data: value.data as Record<string, unknown> };
}

async function fingerprints(client: postgres.Sql, schema: string) {
  if (!/^ccagent_test_[a-f0-9]{16}$/.test(schema)) throw new Error('REFUSE_NON_FIXTURE_FINGERPRINT');
  return client.begin('isolation level repeatable read read only', async tx => {
    await tx`set local time zone 'UTC'`;
    const tables = await tx`select tablename from pg_tables where schemaname = ${schema} order by tablename collate "C"`;
    const data: Record<string, { rows: number; sha256: string }> = {};
    for (const table of tables) {
      const rows = await tx.unsafe(`select to_jsonb(t)::text as value from "${schema}"."${table.tablename}" t order by to_jsonb(t)::text collate "C"`);
      data[table.tablename] = { rows: rows.length, sha256: checksum(rows.map(row => row.value)) };
    }
    const objects = await tx`select c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname=${schema} and c.relkind in ('r','i','S') order by c.relname collate "C"`;
    const constraints = await tx`select c.conname, pg_get_constraintdef(c.oid) as definition from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname=${schema} order by c.conname collate "C"`;
    const triggers = await tx`select t.tgname, pg_get_triggerdef(t.oid) as definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname=${schema} and not t.tgisinternal order by t.tgname collate "C"`;
    const functions = await tx`select p.proname, pg_get_functiondef(p.oid) as definition, array(select entry from unnest(p.proacl::text[]) as a(entry) order by entry collate "C") as grants from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=${schema} order by p.proname collate "C"`;
    const policies = await tx`select tablename, policyname, roles, cmd, qual, with_check from pg_policies where schemaname=${schema} order by tablename collate "C",policyname collate "C"`;
    const privileges = await tx`select table_name, grantee, privilege_type, is_grantable from information_schema.table_privileges where table_schema=${schema} order by table_name collate "C",grantee collate "C",privilege_type collate "C"`;
    const sequences = [];
    for (const sequence of objects.filter(item => item.relkind === 'S')) {
      const [value] = await tx.unsafe(`select last_value::text,is_called from "${schema}"."${sequence.relname}"`); sequences.push({ name: sequence.relname, ...value });
    }
    const structure = Object.fromEntries(Object.entries({ objects, constraints, triggers, functions, policies, privileges, sequences }).map(([key, value]) => [key, checksum(value)]));
    const schemaHash = checksum(structure);
    return { data, structure, schemaHash, rows: Object.values(data).reduce((sum, table) => sum + table.rows, 0) };
  });
}

async function prepareMigrations(schema: string, directory: string, fail = false) {
  await mkdir(path.join(directory, 'meta'), { recursive: true });
  for (const file of (await readdir('migrations')).filter(file => file.endsWith('.sql'))) {
    const body = (await readFile(path.join('migrations', file), 'utf8')).replaceAll('"ccagent"', `"${schema}"`).replaceAll("'ccagent'", `'${schema}'`);
    await writeFile(path.join(directory, file), body, { flag: 'wx' });
  }
  const journal = JSON.parse(await readFile('migrations/meta/_journal.json', 'utf8'));
  if (fail) {
    const idx = journal.entries.length, tag = `${String(idx).padStart(4, '0')}_recovery_failure_fixture`;
    journal.entries.push({ idx, version: '7', when: journal.entries.at(-1).when + 1, tag, breakpoints: true });
    await writeFile(path.join(directory, tag + '.sql'), `CREATE TABLE "${schema}".must_rollback(id text);\n--> statement-breakpoint\nINSERT INTO "${schema}".settings(key,value) VALUES ('must_rollback','true');\n--> statement-breakpoint\nSELECT 1/0;\n`);
  }
  await writeFile(path.join(directory, 'meta', '_journal.json'), JSON.stringify(journal));
}

async function main() {
  await mkdir(output, { recursive: true });
  const remoteUrl = databaseUrl(true);
  const version = (await runPostgresTool('pg_dump', ['--version'])).trim();
  assert.match(version, /PostgreSQL\) 17\./);
  cluster = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ccagent-pg-recovery-')));
  const data = path.join(cluster, 'data'), passwordFile = path.join(cluster, 'initial-password');
  const password = randomBytes(36).toString('base64url'), authSecret = randomBytes(48).toString('base64url');
  const port = await new Promise<number>((resolve, reject) => {
    const socket = net.createServer(); socket.once('error', reject); socket.listen(0, '127.0.0.1', () => {
      const address = socket.address(); socket.close(() => address && typeof address !== 'string' ? resolve(address.port) : reject(new Error('NO_FIXTURE_PORT')));
    });
  });
  const local = (database: string, role = 'postgres'): Partial<NodeJS.ProcessEnv> => ({ PGHOST: '127.0.0.1', PGPORT: String(port), PGDATABASE: database, PGUSER: role, PGPASSWORD: password, PGSSLMODE: 'disable' });
  const connect = (database: string, role = 'postgres') => {
    const url = new URL(`postgres://127.0.0.1:${port}/${database}`); url.username = role; url.password = password;
    const client = postgres(url.toString(), { ...databaseOptions(1), ssl: false }); connections.push(client); return client;
  };
  await check('isolated-local-cluster', async () => {
    await writeFile(passwordFile, password + '\n', { mode: 0o600, flag: 'wx' });
    await runPostgresTool('initdb', ['-D', data, '-U', 'postgres', '--encoding=UTF8', '--locale=C', '--auth=scram-sha-256', '--pwfile', passwordFile]);
    await rm(passwordFile);
    clusterStarted = true;
    await runPostgresTool('pg_ctl', ['-D', data, '-l', path.join(cluster, 'server.log'), '-o', `-p ${port} -h 127.0.0.1 -c timezone=UTC`, '-w', '-t', '30', 'start']);
  });
  const admin = connect('postgres');
  await admin`revoke create on schema public from public`;
  const [roleDdl] = await admin`select format('CREATE ROLE ccagent_runtime LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', ${password}::text) as ddl`;
  await admin.unsafe(roleDdl.ddl);
  fixture = await isolatedDatabase({ migrationCount: 2 });
  const { schema, owner } = fixture;
  const [server] = await owner`show server_version`; const serverVersion = String(server!.server_version); assert.match(serverVersion, /^17\./);
  const [sourceLocale] = await owner`select datcollate,datctype from pg_database where datname=current_database()`;
  const [targetLocale] = await admin`select datcollate,datctype from pg_database where datname=current_database()`;
  await check('cross-locale-fingerprints-use-byte-order', async () => {
    const orders = (client: postgres.Sql) => client`select array_agg(to_jsonb(t)::text order by to_jsonb(t)::text) as default_order,
      array_agg(to_jsonb(t)::text order by to_jsonb(t)::text collate "C") as byte_order from (values ('a-recovery-fixture'),('Z-recovery-fixture')) t(id)`;
    const [source] = await orders(owner), [target] = await orders(admin);
    assert.deepEqual(source!.byte_order, target!.byte_order);
    assert.deepEqual(source!.byte_order, ['{"id": "Z-recovery-fixture"}', '{"id": "a-recovery-fixture"}']);
    console.log(JSON.stringify({ sourceLocale, targetLocale, defaultOrderingDiffers: JSON.stringify(source!.default_order) !== JSON.stringify(target!.default_order), fingerprintOrdering: 'C' }));
  });
  const tables = await import('../src/core/db/schema');
  const { createAuthentication } = await import('../src/core/auth');
  const db = drizzle(owner, { schema: tables });
  const userId = randomUUID(), adminId = randomUUID(), keyId = randomUUID(), reservationId = randomUUID(), orderId = '9' + Date.now().toString() + '0001';
  const fixturePassword = randomBytes(24).toString('base64url'), email = `${userId}@example.invalid`, origin = 'http://127.0.0.1:4310';
  const keyHash = checksum('fixture-key-' + randomUUID());
  const authOptions = { origin, secret: authSecret, deliverMail: async () => { throw new Error('REAL_MAIL_FORBIDDEN_IN_RECOVERY'); } };
  const authRequest = (route: string, body?: object, cookie?: string) => new Request(origin + '/api/auth' + route, { method: body ? 'POST' : 'GET', headers: { origin, 'x-vercel-forwarded-for': '127.0.0.1', ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let cookie = '';
  await check('all-application-tables-seeded', async () => {
    phase = 'seed-users-and-auth';
    await db.insert(tables.user).values([{ id: userId, name: 'Recovery user', email, emailVerified: true }, { id: adminId, name: 'Recovery admin', email: `${adminId}@example.invalid`, emailVerified: true, role: 'admin' }]);
    await db.insert(tables.userRoles).values({ userId: adminId, roleId: 'admin' });
    await db.insert(tables.account).values({ id: randomUUID(), userId, accountId: userId, providerId: 'credential', password: await hashPassword(fixturePassword) });
    await db.insert(tables.verification).values({ id: randomUUID(), identifier: 'recovery-fixture', value: 'fixture-verification', expiresAt: new Date(Date.now() + 3600_000) });
    const auth = createAuthentication({ db, ...authOptions });
    const login = await auth.handler(authRequest('/sign-in/email', { email, password: fixturePassword })); assert.equal(login.status, 200);
    cookie = login.headers.getSetCookie().find(item => item.startsWith('ccagent.session_token='))!.split(';')[0]!;
    await db.insert(tables.rateLimit).values(['a', 'Z'].map(prefix => ({ id: prefix + '-recovery-fixture', key: prefix + '-recovery-' + userId, count: 1, lastRequest: Date.now() })));
    phase = 'seed-service-and-payment-records';
    await db.insert(tables.apiKeys).values({ id: keyId, userId, name: 'Recovery key', prefix: 'ccagent_fixture', hash: keyHash, frozen: 200_000n });
    await db.insert(tables.routes).values({ id: 'recovery-route', name: 'Recovery route', service: 'chat', protocol: 'openai-chat', provider: 'deepseek', baseUrl: 'https://example.invalid', upstreamModel: 'fixture-model', credentialEnv: 'CCAGENT_PROVIDER_RECOVERY_FIXTURE', enabled: false });
    await db.insert(tables.prices).values({ id: randomUUID(), routeId: 'recovery-route', version: 1, currency: 'CNY', components: { fixture: true }, sourceUrl: 'https://example.invalid/fixture-price', effectiveAt: new Date() });
    await db.insert(tables.orders).values({ id: orderId, userId, amountFen: 100n, status: 'credited', merchantId: 'fixture-only', tradeNo: 'fixture-trade', creditedAt: new Date() });
    await db.insert(tables.paymentEvents).values({ id: randomUUID(), orderId, tradeNo: 'fixture-trade', deduplicationHash: checksum('fixture-event'), status: 'processed' });
    await db.insert(tables.refunds).values({ id: randomUUID(), orderId, userId, amount: 1_000_000n, status: 'failed', initiatedBy: adminId, reason: 'Fixture-only declined refund' });
    phase = 'seed-financial-ledger';
    for (const [reference, kind, balance, frozen] of [ ['fixture-credit', 'recharge', 1_000_000, 0], ['fixture-refund-hold', 'refund_hold', 0, 1_000_000], ['fixture-refund-release', 'refund_release', 0, -1_000_000], ['fixture-call-hold', 'authorization', 0, 200_000] ] as const) {
      await owner.unsafe(`select "${schema}".post_ledger($1,$2,$3,$4,$5,'{}')`, [userId, reference, kind, balance, frozen]);
    }
    await db.insert(tables.reservations).values({ id: reservationId, userId, keyId, routeId: 'recovery-route', taskId: 'recovery-task', idempotencyKey: 'recovery-call', requestHash: checksum('fixture-request'), authorized: 200_000n, priceSnapshot: { fixture: true }, reconcileAt: new Date(Date.now() + 86400_000) });
    await db.insert(tables.settings).values({ key: 'default_fx', value: '7.25', updatedBy: adminId });
    await db.insert(tables.audit).values({ id: randomUUID(), actorId: adminId, action: 'recovery.fixture', objectId: userId, result: 'success' });
    await db.insert(tables.blobs).values({ id: randomUUID(), userId, pathname: 'recovery-fixture/expired', purpose: 'request', contentType: 'application/json', size: 0, status: 'expired', expiresAt: new Date(Date.now() - 1000) });
    phase = 'seed-grants-and-inventory';
    await grantRuntimeAccess(owner, schema);
    const snapshot = await fingerprints(owner, schema);
    const declaredTables = Object.values(tables).filter(value => is(value, PgTable)).map(value => getTableName(value));
    assert.deepEqual(Object.keys(snapshot.data).sort(), [...declaredTables, '__drizzle_migrations'].sort());
    assert.ok(Object.values(snapshot.data).every(table => table.rows > 0));
  });
  const before = await fingerprints(owner, schema), beforeFile = path.join(output, 'before-0002.dump');
  const remote = await remotePgEnvironment(remoteUrl, path.join(cluster, 'trusted-roots.pem'));
  await check('real-remote-pg-dump-with-verified-tls', async () => {
    await runPostgresTool('pg_dump', ['--format=custom', '--strict-names', '--schema', schema, '--lock-wait-timeout=15000', '--file', beforeFile, '--no-password'], remote);
    assert.match(await runPostgresTool('pg_restore', ['--list', beforeFile]), new RegExp(schema));
  });
  const createDatabase = async (name: string) => { if (!/^recovery_(before|rollback|current)$/.test(name)) throw new Error('INVALID_RECOVERY_DATABASE'); await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE template0`); };
  const restore = async (file: string, database: string) => { await createDatabase(database); await runPostgresTool('pg_restore', ['--single-transaction', '--exit-on-error', '--no-password', '--dbname', database, file], local(database)); };
  await check('restore-all-schema-data-constraints-policies-grants', async () => {
    await restore(beforeFile, 'recovery_before'); assert.deepEqual(await fingerprints(connect('recovery_before'), schema), before);
  });
  const upgraded = connect('recovery_before');
  await check('restored-real-login-and-session-cookie', async () => {
    const auth = createAuthentication({ db: drizzle(upgraded, { schema: tables }), ...authOptions });
    const session = await auth.handler(authRequest('/get-session', undefined, cookie)); assert.equal(session.status, 200);
    const result = await session.json(); assert.equal(result.user.id, userId);
    const login = await auth.handler(authRequest('/sign-in/email', { email, password: fixturePassword })); assert.equal(login.status, 200);
  });
  const migrations = path.join(cluster, 'migrations'); await prepareMigrations(schema, migrations);
  const apply = async (client: postgres.Sql, folder = migrations) => migrate(drizzle(client), { migrationsFolder: folder, migrationsSchema: schema, migrationsTable: '__drizzle_migrations' });
  const migrationCount = JSON.parse(await readFile('migrations/meta/_journal.json', 'utf8')).entries.length;
  await check('apply-and-replay-current-migrations', async () => {
    await apply(upgraded); await apply(upgraded);
    const rows = await upgraded.unsafe(`select count(*)::int as count from "${schema}".__drizzle_migrations`); assert.equal(rows[0]!.count, migrationCount);
  });
  await check('restored-runtime-grants-and-financial-functions', async () => {
    const runtime = connect('recovery_before', 'ccagent_runtime');
    await assert.rejects(() => runtime.unsafe(`update "${schema}".wallets set balance=999999999 where user_id=$1`, [userId]));
    await runtime.unsafe(`select "${schema}".finish_usage($1,$2,1000,'{"fixture":true}',false)`, [userId, reservationId]);
    const [wallet] = await runtime.unsafe(`select balance::text,frozen::text from "${schema}".wallets where user_id=$1`, [userId]); assert.equal(wallet!.balance, '999000'); assert.equal(wallet!.frozen, '0');
    await assert.rejects(() => runtime.unsafe(`delete from "${schema}".ledger where user_id=$1`, [userId]));
    await assert.rejects(() => runtime.unsafe(`update "${schema}".audit set result='tampered'`));
  });
  await check('failed-migration-rolls-back-ddl-data-and-journal', async () => {
    const expected = await fingerprints(upgraded, schema), failed = path.join(cluster, 'failing-migrations'); await prepareMigrations(schema, failed, true);
    await assert.rejects(() => apply(upgraded, failed)); assert.deepEqual(await fingerprints(upgraded, schema), expected);
  });
  await check('snapshot-rollback-to-pre-0002-version', async () => {
    await restore(beforeFile, 'recovery_rollback');
    const restored = connect('recovery_rollback'); assert.deepEqual(await fingerprints(restored, schema), before);
    const absent = await restored`select to_regprocedure(${schema + '.authorize_usage(text,text,text,text,text,text,bigint,jsonb)'}) is null as absent`; assert.equal(absent[0]!.absent, true);
    const auth = createAuthentication({ db: drizzle(restored, { schema: tables }), ...authOptions });
    const current = await auth.handler(authRequest('/get-session', undefined, cookie)); assert.equal((await current.json()).user.id, userId);
    await apply(restored); const versions = await restored.unsafe(`select count(*)::int as count from "${schema}".__drizzle_migrations`); assert.equal(versions[0]!.count, migrationCount);
  });
  const currentFile = path.join(output, 'current.dump'), current = await fingerprints(upgraded, schema);
  await check('current-version-backup-and-full-restore', async () => {
    await runPostgresTool('pg_dump', ['--format=custom', '--strict-names', '--schema', schema, '--file', currentFile, '--no-password'], local('recovery_before'));
    await restore(currentFile, 'recovery_current'); assert.deepEqual(await fingerprints(connect('recovery_current'), schema), current);
  });
  await check('schema-exclusion-and-source-preservation', async () => {
    const listing = await runPostgresTool('pg_restore', ['--list', beforeFile]);
    assert.equal(/ TABLE (?:ccagent|auth|storage|public) /m.test(listing), false);
    assert.deepEqual(await fingerprints(owner, schema), before);
  });
  manifest = { ok: true, createdAt: new Date().toISOString(), fixtureOnly: true, serverVersion, toolVersion: version,
    schema, checks, tableCount: Object.keys(before.data).length, before, current, sourceLocale, targetLocale, fingerprintOrdering: 'C',
    archives: await Promise.all([beforeFile, currentFile].map(async file => { const bytes = await readFile(file); return { file: path.basename(file), sha256: checksum(bytes), bytes: bytes.length }; })),
    migrationFiles: await Promise.all((await readdir('migrations')).filter(file => file.endsWith('.sql')).sort().map(async file => ({ file, sha256: checksum(await readFile(path.join('migrations', file))) }))),
    productionCutover: false, scope: 'Application schema only. Blob bytes, external service secrets and database role passwords are not included.' };
}

try { await main(); }
catch (error) {
  const message = error instanceof Error ? error.message : '', info = error as { code?: unknown; cause?: { code?: unknown }; actual?: unknown; expected?: unknown };
  const code = info.code ?? info.cause?.code;
  const actualSnapshot = snapshotDetails(info.actual), expectedSnapshot = snapshotDetails(info.expected);
  console.error(JSON.stringify({ ok: false, phase, code: typeof code === 'string' && /^[A-Z0-9_]{1,60}$/.test(code) ? code : /^[A-Za-z0-9_:.-]{1,140}$/.test(message) ? message : 'RECOVERY_CHECK_FAILED',
    ...(typeof info.actual === 'number' && typeof info.expected === 'number' ? { actual: info.actual, expected: info.expected } : {}),
    ...(actualSnapshot && expectedSnapshot ? { structuralDifference: { actual: actualSnapshot.structure, expected: expectedSnapshot.structure },
      dataDifference: Object.fromEntries(Object.entries(actualSnapshot.data).filter(([table, value]) => JSON.stringify(value) !== JSON.stringify(expectedSnapshot.data[table])).map(([table, value]) => [table, { actual: value, expected: expectedSnapshot.data[table] }])) } : {}) })); process.exitCode = 1;
}
finally {
  for (const connection of connections) await connection.end({ timeout: 5 }).catch(() => {});
  if (clusterStarted) {
    try { await runPostgresTool('pg_ctl', ['-D', path.join(cluster, 'data'), '-w', '-t', '30', '-m', 'fast', 'stop']); clusterStarted = false; }
    catch {
      try { await runPostgresTool('pg_ctl', ['-D', path.join(cluster, 'data'), 'status']); }
      catch (error) { if (error instanceof Error && error.message === 'pg_ctl:TOOL_FAILED:3') clusterStarted = false; }
      if (clusterStarted) { console.error(JSON.stringify({ cleanup: 'local-cluster-stop-failed', directory: cluster })); process.exitCode = 1; }
    }
  }
  try { await fixture?.cleanup(); sourceCleaned = true; }
  catch { console.error(JSON.stringify({ cleanup: 'remote-fixture-cleanup-failed', schema: fixture?.schema })); process.exitCode = 1; }
  if (cluster && !clusterStarted) {
    const parent = await realpath(os.tmpdir());
    if (path.dirname(cluster) !== parent || !path.basename(cluster).startsWith('ccagent-pg-recovery-')) throw new Error('REFUSE_UNSCOPED_CLUSTER_CLEANUP');
    try { await rm(cluster, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch { console.error(JSON.stringify({ cleanup: 'local-cluster-directory-retained', directory: cluster })); process.exitCode = 1; }
  }
  const result = { ...(manifest ?? { ok: false, phase, checks, fixtureOnly: true }), ok: Boolean(manifest && process.exitCode !== 1), cleanup: { sourceSchemaRemoved: sourceCleaned, localServerStopped: !clusterStarted } };
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ ok: result.ok, checks: checks.length, fixtureOnly: true, report: path.relative(process.cwd(), path.join(output, 'manifest.json')) }));
}
