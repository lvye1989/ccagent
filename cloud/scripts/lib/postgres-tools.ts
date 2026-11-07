import { execFile } from 'node:child_process';
import path from 'node:path';
import { getCACertificates } from 'node:tls';
import { writeFile } from 'node:fs/promises';
import { supabaseRootCA } from '../../src/core/db/supabase-root-ca';

export const defaultPgBin = path.resolve('../.tmp/tools/postgresql-17.11-5/pgsql/bin');
const binaries = new Set(['pg_dump', 'pg_restore', 'psql', 'initdb', 'pg_ctl']);

/** No shell, password arguments, inherited libpq configuration or raw tool logs. */
export function runPostgresTool(name: string, args: string[], connection: Partial<NodeJS.ProcessEnv> = {}, timeout = 120_000): Promise<string> {
  return execute(name, args, connection, timeout).then(value => value.toString('utf8'));
}

/** Keep custom archives binary and off disk until the caller encrypts them. */
export function dumpSchema(schema: string, connection: Partial<NodeJS.ProcessEnv>): Promise<Buffer> {
  if (schema !== 'ccagent' && !/^ccagent_test_[a-f0-9]{16}$/.test(schema)) throw new Error('REFUSE_UNSCOPED_BACKUP');
  return execute('pg_dump', ['--format=custom', '--strict-names', '--schema', schema, '--lock-wait-timeout=15000', '--no-password'], connection, 120_000);
}

/** Inventory an archive from memory; rows and credentials never enter tool output. */
export function listArchive(archive: Buffer): Promise<string> {
  return execute('pg_restore', ['--list'], {}, 120_000, archive).then(value => value.toString('utf8'));
}

/** Read every archive block without executing SQL or exposing row data. */
export async function validateArchive(archive: Buffer): Promise<void> {
  const output = await execute('pg_restore', ['--file=-', '--exit-on-error'], {}, 120_000, archive);
  output.fill(0);
}

function execute(name: string, args: string[], connection: Partial<NodeJS.ProcessEnv>, timeout: number, input?: Buffer): Promise<Buffer> {
  if (!binaries.has(name)) throw new Error('INVALID_POSTGRES_TOOL');
  const directory = process.env.CCAGENT_PG_BIN || (process.platform === 'win32' ? defaultPgBin : '');
  const binary = directory ? path.join(directory, name + (process.platform === 'win32' ? '.exe' : '')) : name;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG/i.test(key))) as NodeJS.ProcessEnv;
  Object.assign(env, connection, { PGCONNECT_TIMEOUT: '15', PGAPPNAME: 'ccagent-recovery-rehearsal', PGTZ: 'UTC' });
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, { env, windowsHide: true, timeout, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      // Tool errors can contain row data. Keep only a classified diagnostic.
      const text = String(stderr);
      const reason = /certificate verify|root certificate|SSL error/i.test(text) ? 'TLS_VERIFICATION_FAILED' :
        /password authentication failed/i.test(text) ? 'AUTHENTICATION_FAILED' :
        /server version mismatch/i.test(text) ? 'VERSION_MISMATCH' :
        /already exists/i.test(text) ? 'OBJECT_EXISTS' :
        /permission denied|must be owner|must be superuser/i.test(text) ? 'PERMISSION_DENIED' :
        /connection refused|could not connect/i.test(text) ? 'CONNECTION_FAILED' :
        /does not exist/i.test(text) ? 'MISSING_OBJECT' : error.killed ? 'TIMEOUT' : 'TOOL_FAILED';
      reject(new Error(`${name}:${reason}:${'code' in error ? error.code : 'UNKNOWN'}`));
    });
    child.stdin?.on('error', () => { /* Completion reports failure without echoing input. */ });
    child.stdin?.end(input);
    // Windows postgres inherits pg_ctl's pipe handles even with a server log.
    // pg_ctl's own exit is authoritative; inherited handles must not hold the
    // caller open for the entire lifetime of the local server.
    if (name === 'pg_ctl' && args.includes('start')) child.once('exit', () => { child.stdout?.destroy(); child.stderr?.destroy(); });
  });
}

/** Export only public trust roots; credentials stay in the child environment. */
export async function remotePgEnvironment(url: string, rootFile: string): Promise<Partial<NodeJS.ProcessEnv>> {
  const parsed = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.username || !parsed.password || parsed.port === '6543') throw new Error('SESSION_DATABASE_CONNECTION_REQUIRED');
  const roots = [...new Set([...getCACertificates('default'), ...getCACertificates('system'), supabaseRootCA])];
  if (!roots.length) throw new Error('NO_TRUSTED_CERTIFICATE_ROOTS');
  await writeFile(rootFile, roots.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  return { PGHOST: parsed.hostname, PGPORT: parsed.port || '5432', PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
    PGUSER: decodeURIComponent(parsed.username), PGPASSWORD: decodeURIComponent(parsed.password),
    PGSSLMODE: 'verify-full', PGSSLROOTCERT: rootFile };
}
