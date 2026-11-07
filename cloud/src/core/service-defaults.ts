import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { database, type DatabaseReader } from './db';
import { audit, routes, settings } from './db/schema';
import { publishedRoute } from './catalog';
import { lockAdministration } from './database-locks';
import { HttpError } from './http';

export const serviceKinds = ['chat', 'vision', 'decision', 'search', 'voice'] as const;
export type ServiceKind = typeof serviceKinds[number];
const routeId = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,79}$/).nullable();
export const defaultRoutes = z.object({ chat: routeId, vision: routeId, decision: routeId, search: routeId, voice: routeId }).strict();
export const serviceDefaultsInput = z.object({ version: z.number().int().min(0), routes: defaultRoutes }).strict();
const key = 'service_default_routes';
const emptyRoutes = () => ({ chat: null, vision: null, decision: null, search: null, voice: null });

export async function readServiceDefaults(reader: DatabaseReader = database().db) {
  const [stored] = await reader.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (!stored) return { version: 0, routes: emptyRoutes() };
  const parsed = defaultRoutes.safeParse(stored.value);
  if (!parsed.success) throw new HttpError(503, 'INVALID_SERVICE_DEFAULTS', '平台默认服务配置需要管理员核对。');
  return { version: stored.version, routes: parsed.data };
}

/** Never substitutes another route for a configured service that is unavailable. */
export function availableServiceDefaults(configured: z.infer<typeof defaultRoutes>, available: readonly { id: string; service: string }[]) {
  return Object.fromEntries(serviceKinds.map(service => [service, available.some(route => route.id === configured[service] && route.service === service) ? configured[service] : null])) as z.infer<typeof defaultRoutes>;
}

export async function adminServiceDefaults() {
  return database().db.transaction(async tx => {
    const current = await readServiceDefaults(tx);
    const candidates = await tx.select({ id: routes.id, name: routes.name, service: routes.service, enabled: routes.enabled }).from(routes).orderBy(asc(routes.name), asc(routes.id));
    const choices: { id: string; name: string; service: string; ready: boolean }[] = [];
    for (const route of candidates) {
      let ready = false;
      if (route.enabled) { try { await publishedRoute(route.id, route.service, tx); ready = true; } catch { /* Metadata readiness only; never invoke a supplier. */ } }
      choices.push({ id: route.id, name: route.name, service: route.service, ready });
    }
    return { ...current, available: availableServiceDefaults(current.routes, choices.filter(choice => choice.ready)), choices };
  }, { accessMode: 'read only', isolationLevel: 'repeatable read' });
}
export type ServiceDefaultsView = Awaited<ReturnType<typeof adminServiceDefaults>>;

export async function saveServiceDefaults(actorId: string, input: z.infer<typeof serviceDefaultsInput>) {
  const checked = serviceDefaultsInput.parse(input);
  await database().db.transaction(async tx => {
    // Route and price writes take the same lock, so validation and the default change are atomic.
    await lockAdministration(tx, 804714033);
    const current = await readServiceDefaults(tx);
    if (current.version !== checked.version) throw new HttpError(409, 'CONFIGURATION_CHANGED', '默认服务已被其他管理员更新，请重新载入后保存。');
    for (const service of serviceKinds) {
      const selected = checked.routes[service];
      if (!selected) continue;
      try { await publishedRoute(selected, service, tx); }
      catch { throw new HttpError(409, 'DEFAULT_SERVICE_NOT_READY', '默认服务须类型匹配、已开放，且已配置有效成本、凭据与结算汇率。'); }
    }
    const changed = serviceKinds.filter(service => checked.routes[service] !== current.routes[service]);
    if (!changed.length) return;
    if (current.version) await tx.update(settings).set({ value: checked.routes, version: current.version + 1, updatedBy: actorId, updatedAt: new Date() }).where(eq(settings.key, key));
    else await tx.insert(settings).values({ key, value: checked.routes, updatedBy: actorId });
    await tx.insert(audit).values({ id: randomUUID(), actorId, action: 'routes.defaults.update', objectId: 'platform', result: 'success', metadata: { services: changed, version: current.version + 1 } });
  });
  return adminServiceDefaults();
}
