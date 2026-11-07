// Opt-in diagnostics for isolated tests. Never serializes SQL, values, results,
// database addresses, usernames, passwords or error messages.
import dc from 'node:diagnostics_channel';
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve('../output/checks');
mkdirSync(root, { recursive: true });
const file = path.join(root, `database-trace-${process.pid}-${Date.now()}.jsonl`);
const fd = openSync(file, 'wx', 0o600), pending = new Map(), identities = new WeakMap();
let closed = false, inspecting = false, connectionEnvironment;
let sequence = 0;
const log = value => { if (!closed) writeSync(fd, JSON.stringify({ at: Date.now(), ...value }) + '\n'); };
const identity = context => { if (!identities.has(context)) identities.set(context, ++sequence); return identities.get(context); };
const record = context => {
  const query = typeof context.query === 'string' ? context.query : '';
  const operation = /^\s*([a-z]+)/i.exec(query)?.[1]?.toUpperCase() || 'SQL';
  return { id: identity(context), operation, connection: context.connection ?? null, port: context.port ?? null,
    queryHash: createHash('md5').update(query.replaceAll(/ccagent_test_[a-f0-9]{16}/g, 'ccagent_fixture')).digest('hex') };
};
for (const name of ['query', 'transaction']) {
  dc.tracingChannel('postgres:' + name).subscribe({
    start(context) { const value = { type: name, ...record(context) }; pending.set(context, { ...value, started: Date.now() }); log({ event: 'start', ...value }); },
    end(context) { log({ event: 'sent', type: name, ...record(context) }); },
    error(context) { log({ event: 'error', type: name, ...record(context), code: String(context.error?.code || 'UNKNOWN').slice(0, 60) }); },
    asyncStart() {},
    asyncEnd(context) { const previous = pending.get(context); pending.delete(context); log({ event: 'done', type: name, ...record(context), elapsed: previous ? Date.now() - previous.started : null, outcome: context.outcome,
      queuedMs: context.sent && context.queued ? context.sent - context.queued : undefined,
      firstByteMs: context.firstByte && context.sent ? context.firstByte - context.sent : undefined }); },
  });
}
dc.tracingChannel('postgres:connect').subscribe({ start() {}, end() {}, error(context) { log({ event: 'connect-error', port: context.port, code: String(context.error?.code || 'UNKNOWN').slice(0, 60) }); }, asyncStart() {},
  asyncEnd(context) { log({ event: 'connect', port: context.port, connection: context.connection, backendPid: context.result?.pid }); },
});
dc.subscribe('postgres:pool', context => log({ event: 'pool-' + context.event, connection: context.connection, port: context.port, stats: context.stats }));
async function inspectServer() {
  const migrationUrl = process.env.DATABASE_MIGRATION_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (inspecting || !migrationUrl) return;
  inspecting = true;
  try {
    const { remotePgEnvironment, runPostgresTool } = await import('./postgres-tools.ts');
    connectionEnvironment ??= remotePgEnvironment(migrationUrl, file + '.public-ca.pem');
    const sql = `select coalesce(json_agg(t),'[]'::json) from (
      select pid,state,wait_event_type,wait_event,extract(epoch from now()-query_start)::int as seconds,
      pg_blocking_pids(pid) as blockers,backend_xid,
      md5(regexp_replace(query,'ccagent_test_[a-f0-9]{16}','ccagent_fixture','g')) as query_hash
      from pg_stat_activity where pid<>pg_backend_pid() and backend_type='client backend'
      and (query like '%ccagent_test_%' or state like 'idle in transaction%')
      and now()-query_start > interval '2 seconds' order by query_start limit 20
    ) t`;
    const text = await runPostgresTool('psql', ['--no-password', '--no-psqlrc', '--no-align', '--tuples-only', '--command', sql], await connectionEnvironment, 20000);
    log({ event: 'server-state', rows: JSON.parse(text.trim()) });
  } catch (error) { log({ event: 'server-state-unavailable', code: /^[A-Za-z0-9_:.-]{1,140}$/.test(error.message) ? error.message : 'DIAGNOSTIC_FAILED' }); }
  finally { inspecting = false; }
}
setInterval(() => {
  let slow = false;
  for (const [context, value] of pending) if (Date.now() - value.started >= 3000) {
    slow = true; log({ event: 'pending', ...record(context), type: value.type, elapsed: Date.now() - value.started, firstByteReceived: Boolean(context.firstByte), sent: Boolean(context.sent) });
  }
  if (slow) void inspectServer();
}, 3000).unref();
process.once('exit', () => { log({ event: 'exit', pending: pending.size }); closed = true; closeSync(fd); });
