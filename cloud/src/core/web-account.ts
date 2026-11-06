import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { permissionsFor, requireSession } from './auth';
import { HttpError } from './http';

export async function webAccount(permission?: string) {
  let current;
  try { current = await requireSession(await headers()); }
  catch (error) {
    if (error instanceof HttpError && error.status === 401) redirect('/login');
    if (error instanceof HttpError && error.status === 403) redirect('/login?error=disabled');
    throw error;
  }
  const permissions = await permissionsFor(current.user.id);
  if (permission && !permissions.includes(permission)) notFound();
  return { ...current, permissions };
}
export function cny(value: bigint | string) {
  const amount = BigInt(value), absolute = amount < 0n ? -amount : amount;
  const decimals = (absolute % 1000000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${amount < 0n ? '-' : ''}¥${(absolute / 1000000n).toLocaleString('zh-CN')}.${decimals}`;
}
