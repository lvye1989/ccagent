import { eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { database, type DatabaseReader } from './db';
import { routes, settings } from './db/schema';
import { HttpError } from './http';

export const routeArchiveKey = (id: string) => `gateway.route_archive.${id}`;
/** Retired identifiers stay reserved even when an old client attempts an upsert. */
export async function assertRouteNotArchived(id: string, reader: DatabaseReader = database().db) {
  const [record] = await reader.select({ key: settings.key }).from(settings).where(eq(settings.key, routeArchiveKey(id))).limit(1);
  if (record) throw new HttpError(410, 'ROUTE_DELETED', '该服务路由已删除，请使用新的路由编号。');
}
export function activeRouteCondition(id: SQLWrapper = routes.id): SQL {
  return sql`not exists(select 1 from ${settings} route_archive where route_archive.key=${'gateway.route_archive.'} || ${id})`;
}
/** Millisecond versions remain distinct, including multiple administrator writes in one clock tick. */
export function nextRouteUpdate(previous?: Date): Date { return new Date(Math.max(Date.now(), (previous?.getTime() ?? 0) + 1)); }
export function checkRouteVersion(route: { updatedAt: Date }, expectedUpdatedAt?: string) {
  if (expectedUpdatedAt !== undefined && route.updatedAt.getTime() !== new Date(expectedUpdatedAt).getTime()) {
    throw new HttpError(409, 'ROUTE_CONFIGURATION_CHANGED', '路由已被其他管理员修改，请重新载入后再操作。');
  }
}
