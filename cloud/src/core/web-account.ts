import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { permissionsFor, requireSession } from './auth';
import { HttpError } from './http';
import { formatMicroYuan } from './money-display';

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
  const formatted = formatMicroYuan(value);
  return formatted.startsWith('-') ? `-¥${formatted.slice(1)}` : `¥${formatted}`;
}
