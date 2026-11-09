import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { database } from './db';
import { audit, routes, settings } from './db/schema';
import { routeFingerprint, routeInput } from './catalog';
import { lockAdministration } from './database-locks';
import { HttpError } from './http';
import { saveRouteCredential } from './provider-credentials';
import { activeRouteCondition, checkRouteVersion, nextRouteUpdate, routeArchiveKey } from './route-lifecycle';
import { readServiceDefaults } from './service-defaults';

export const deleteRouteInput = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,79}$/),
  expectedUpdatedAt: z.iso.datetime({ offset: true }).optional(), expectedRouteFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();

/** Retire a route, never erase the referenced price versions, calls, holds or audit records. */
export async function deleteRoute(actorId: string, input: z.infer<typeof deleteRouteInput>) {
  return database().db.transaction(async tx => {
    await lockAdministration(tx, 804714033);
    const [route] = await tx.select().from(routes).where(eq(routes.id, input.id)).for('update');
    if (!route) throw new HttpError(404, 'ROUTE_NOT_FOUND', '服务路由不存在。');
    const [archived] = await tx.select({ key: settings.key }).from(settings).where(eq(settings.key, routeArchiveKey(input.id))).limit(1);
    if (archived) return { deleted: true, mode: 'archived' as const, replayed: true, message: '该路由已删除，历史调用、价格和审计记录已保留。' };
    checkRouteVersion(route, input.expectedUpdatedAt);
    if (input.expectedRouteFingerprint !== undefined && input.expectedRouteFingerprint !== routeFingerprint(route)) {
      throw new HttpError(409, 'ROUTE_CONFIGURATION_CHANGED', '路由已被其他管理员修改，请重新载入后再删除。');
    }
    const updatedAt = nextRouteUpdate(route.updatedAt);
    await tx.insert(settings).values({ key: routeArchiveKey(input.id), value: { retiredAt: updatedAt.toISOString() }, updatedBy: actorId });
    const options = routeInput.shape.options.parse(route.options);
    await tx.update(routes).set({ enabled: false, updatedAt, options: { ...options, fallbackEnabled: false, fallbackRouteId: null } }).where(eq(routes.id, input.id));
    await saveRouteCredential(actorId, route, { remove: true }, tx);

    const dependents = await tx.select({ id: routes.id, options: routes.options, updatedAt: routes.updatedAt }).from(routes).where(activeRouteCondition());
    const affectedFallbacks: string[] = [];
    for (const dependent of dependents) {
      const config = routeInput.shape.options.parse(dependent.options);
      if (config.fallbackRouteId !== input.id) continue;
      await tx.update(routes).set({ options: { ...config, fallbackEnabled: false, fallbackRouteId: null }, updatedAt: nextRouteUpdate(dependent.updatedAt) }).where(eq(routes.id, dependent.id));
      affectedFallbacks.push(dependent.id);
    }
    const defaults = await readServiceDefaults(tx), selected = { ...defaults.routes };
    const affectedDefaults = (Object.keys(selected) as (keyof typeof selected)[]).filter(service => selected[service] === input.id);
    if (affectedDefaults.length) {
      for (const service of affectedDefaults) selected[service] = null;
      await tx.update(settings).set({ value: selected, version: defaults.version + 1, updatedBy: actorId, updatedAt }).where(eq(settings.key, 'service_default_routes'));
      await tx.insert(audit).values({ id: randomUUID(), actorId, action: 'routes.defaults.update', objectId: 'platform', result: 'success',
        metadata: { services: affectedDefaults, version: defaults.version + 1, reason: 'route_deleted', routeId: input.id } });
    }
    await tx.insert(audit).values({ id: randomUUID(), actorId, action: 'routes.delete', objectId: input.id, result: 'success',
      metadata: { logicalDelete: true, affectedFallbacks, affectedDefaults } });
    return { deleted: true, mode: 'archived' as const, replayed: false, message: '已删除，历史调用、价格和审计记录已保留。' };
  });
}
