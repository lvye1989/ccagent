import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { database } from './db';
import { audit, settings } from './db/schema';
import { configuration } from './configuration';
import { lockAdministration } from './database-locks';
import { HttpError } from './http';
import { normalizeUpstreamHost, publicUpstreamAddresses, readApprovedUpstreamHosts, trustedUpstreamHosts, upstreamHostsKey } from './upstream-hosts';

export const gatewayConfigurationInput = z.object({ version: z.number().int().min(0), allowedHosts: z.array(z.string().max(253)).max(50),
  usdCny: z.string().regex(/^(?:|[1-9]\d{0,2}(?:\.\d{1,6})?)$/).optional(), fxVersion: z.number().int().min(0).optional() }).strict()
  .refine(value => value.usdCny === undefined || value.fxVersion !== undefined, 'FX version is required');
export async function gatewayConfiguration() {
  const hosts = await readApprovedUpstreamHosts(), values = await configuration();
  const fx = values.find(item => item.key === 'settlement_usd_cny')!;
  return { ...hosts, trustedHosts: trustedUpstreamHosts(), usdCny: fx.value as string, fxVersion: fx.version, fxReadonly: fx.readonly, fxSource: fx.source };
}
export async function saveGatewayConfiguration(actorId: string, input: z.infer<typeof gatewayConfigurationInput>) {
  const allowedHosts = [...new Set(input.allowedHosts.map(normalizeUpstreamHost))].filter(host => !trustedUpstreamHosts().includes(host)).sort();
  await Promise.all(allowedHosts.map(publicUpstreamAddresses));
  await database().db.transaction(async tx => {
    await lockAdministration(tx, 804714031);
    const current = await readApprovedUpstreamHosts(tx);
    if (current.version !== input.version) throw new HttpError(409, 'CONFIGURATION_CHANGED', '网关配置已被其他管理员修改，请重新载入。');
    if (input.usdCny !== undefined) {
      const [fx] = await tx.select().from(settings).where(eq(settings.key, 'settlement_usd_cny')).for('update');
      if ((fx?.version ?? 0) !== input.fxVersion) throw new HttpError(409, 'CONFIGURATION_CHANGED', '汇率已被其他管理员修改，请重新载入。');
      if (fx) await tx.update(settings).set({ value: { data: input.usdCny }, version: fx.version + 1, updatedBy: actorId, updatedAt: new Date() }).where(eq(settings.key, fx.key));
      else await tx.insert(settings).values({ key: 'settlement_usd_cny', value: { data: input.usdCny }, updatedBy: actorId });
    }
    if (current.version) await tx.update(settings).set({ value: { allowedHosts }, version: current.version + 1, updatedBy: actorId, updatedAt: new Date() }).where(eq(settings.key, upstreamHostsKey));
    else await tx.insert(settings).values({ key: upstreamHostsKey, value: { allowedHosts }, updatedBy: actorId });
    await tx.insert(audit).values({ id: randomUUID(), actorId, action: 'gateway.configuration.update', objectId: 'platform', result: 'success', metadata: { fields: ['allowedHosts', ...(input.usdCny === undefined ? [] : ['usdCny'])] } });
  });
  return gatewayConfiguration();
}
