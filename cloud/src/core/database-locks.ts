import { sql, type SQL } from 'drizzle-orm';
import { namespace } from './db/schema';
import { HttpError } from './http';

type Executor = { execute(query: SQL): PromiseLike<unknown> };
const target = (name: string) => sql`${sql.identifier(namespace.schemaName)}.${sql.identifier(name)}`;

function lockError(error: unknown): never {
  let cause = error;
  while (cause instanceof Error && cause.cause instanceof Error) cause = cause.cause;
  if (cause instanceof Error && cause.message === 'DATABASE_LOCK_BUSY' && 'code' in cause && cause.code === '55P03') {
    throw new HttpError(503, 'DATABASE_LOCK_BUSY', '当前操作较多，请稍后重试。');
  }
  throw error;
}

/** Acquire before protected reads/writes; a busy result never retries a write. */
export async function lockAccount(tx: Executor, userId: string): Promise<void> {
  try { await tx.execute(sql`select ${target('lock_wallet')}(${userId}::text)`); }
  catch (error) { lockError(error); }
}

export async function lockAdministration(tx: Executor, key: 804714031 | 804714032 | 804714033): Promise<void> {
  try { await tx.execute(sql`select ${target('acquire_mutex')}(${key}::bigint)`); }
  catch (error) { lockError(error); }
}
