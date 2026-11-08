import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { database, type DatabaseReader } from './db';
import { audit, settings } from './db/schema';
import { HttpError } from './http';
import { lockAdministration } from './database-locks';
import { authEnvironment, databaseMaxConnections, databaseSchema } from './env';

const definitions = {
  support_email: { default: '', env: 'SUPPORT_EMAIL', validate: z.union([z.literal(''), z.email()]) },
  payment_enabled: { default: false, env: 'PAYMENT_ENABLED', validate: z.boolean() },
  recharge_min_fen: { default: 100, env: 'RECHARGE_MIN_FEN', validate: z.number().int().min(1).max(1000000) },
  recharge_max_fen: { default: 1000000, env: 'RECHARGE_MAX_FEN', validate: z.number().int().min(1).max(1000000) },
  settlement_usd_cny: { default: '', env: 'SETTLEMENT_USD_CNY', validate: z.string().regex(/^(?:|[1-9]\d{0,2}(?:\.\d{1,6})?)$/) },
} as const;
export type ConfigurationKey = keyof typeof definitions;
type ConfigurationEntry = { key: ConfigurationKey; value: unknown; version: number; source: 'environment' | 'database' | 'default'; readonly: boolean };

function storedValue(key: ConfigurationKey, value: unknown): unknown {
  // JSON primitives are ambiguous between postgres-js and Drizzle's JSON decoder.
  // Store an object envelope so numeric-looking strings remain strings.
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'data')) return (value as { data: unknown }).data;
  // Read the initial scalar format without changing its numeric value.
  if (typeof definitions[key].default === 'string' && typeof value === 'number') return String(value);
  return value;
}

function environmentValue(key: ConfigurationKey, value: string): unknown {
  if (typeof definitions[key].default === 'boolean') {
    if (!['true', 'false'].includes(value)) throw new Error('INVALID_CONFIGURATION');
    return value === 'true';
  }
  if (typeof definitions[key].default === 'number') {
    if (!/^[1-9]\d*$/.test(value)) throw new Error('INVALID_CONFIGURATION');
    return Number(value);
  }
  return value;
}
/** No process cache: all Vercel instances observe database changes on the next request. */
export async function configuration(reader: DatabaseReader = database().db): Promise<ConfigurationEntry[]> {
  const rows = await reader.select().from(settings);
  return (Object.keys(definitions) as ConfigurationKey[]).map(key => {
    const definition = definitions[key], stored = rows.find(row => row.key === key), override = process.env[definition.env];
    const databaseFirst = key === 'settlement_usd_cny' && stored !== undefined;
    const value = definition.validate.parse(databaseFirst ? storedValue(key, stored.value) : override === undefined ? stored ? storedValue(key, stored.value) : definition.default : environmentValue(key, override));
    return { key, value, version: stored?.version ?? 0, source: databaseFirst ? 'database' : override !== undefined ? 'environment' : stored ? 'database' : 'default', readonly: key !== 'settlement_usd_cny' && override !== undefined };
  });
}
export async function configurationValues(reader: DatabaseReader = database().db) {
  return Object.fromEntries((await configuration(reader)).map(item => [item.key, item.value])) as {
    support_email: string; payment_enabled: boolean; recharge_min_fen: number; recharge_max_fen: number; settlement_usd_cny: string;
  };
}
export const configurationUpdate = z.object({ changes: z.array(z.object({ key: z.enum(Object.keys(definitions) as [ConfigurationKey, ...ConfigurationKey[]]),
  value: z.union([z.string().max(320), z.number(), z.boolean()]), version: z.number().int().min(0) }).strict()).min(1).max(5) }).strict();

export async function saveConfiguration(actorId: string, input: z.infer<typeof configurationUpdate>) {
  const seen = new Set<string>();
  const current = await configuration();
  for (const change of input.changes) {
    if (seen.has(change.key)) throw new HttpError(400, 'DUPLICATE_FIELD', '不能重复提交同一设置。');
    seen.add(change.key);
    if (current.find(item => item.key === change.key)?.readonly) throw new HttpError(409, 'ENVIRONMENT_OVERRIDE', '此设置由服务器环境变量控制，请通过安全配置渠道修改。');
    definitions[change.key].validate.parse(change.value);
  }
  const merged = Object.fromEntries(current.map(item => [item.key, input.changes.find(change => change.key === item.key)?.value ?? item.value]));
  if (Number(merged.recharge_min_fen) > Number(merged.recharge_max_fen)) throw new HttpError(400, 'INVALID_RECHARGE_RANGE', '最低充值额不能高于最高充值额。');
  await database().db.transaction(async tx => {
    // Serialize multi-field updates, including the first write of a setting.
    await lockAdministration(tx, 804714031);
    const latest = await tx.select().from(settings);
    const values = Object.fromEntries((Object.keys(definitions) as ConfigurationKey[]).map(key => {
      const definition = definitions[key], override = process.env[definition.env];
      const stored = latest.find(row => row.key === key);
      return [key, key === 'settlement_usd_cny' ? input.changes.find(change => change.key === key)?.value ?? (stored ? storedValue(key, stored.value) : override !== undefined ? environmentValue(key, override) : definition.default)
        : override !== undefined ? environmentValue(key, override) : input.changes.find(change => change.key === key)?.value ?? (stored ? storedValue(key, stored.value) : definition.default)];
    }));
    if (Number(values.recharge_min_fen) > Number(values.recharge_max_fen)) throw new HttpError(400, 'INVALID_RECHARGE_RANGE', '最低充值额不能高于最高充值额。');
    for (const change of input.changes) {
      const [existing] = await tx.select().from(settings).where(eq(settings.key, change.key)).for('update');
      if ((existing?.version ?? 0) !== change.version) throw new HttpError(409, 'CONFIGURATION_CHANGED', '设置已被其他管理员更新，请刷新后再保存。');
      if (existing) await tx.update(settings).set({ value: { data: change.value }, version: existing.version + 1, updatedBy: actorId, updatedAt: new Date() }).where(eq(settings.key, change.key));
      else await tx.insert(settings).values({ key: change.key, value: { data: change.value }, updatedBy: actorId });
    }
    await tx.insert(audit).values({ id: randomUUID(), actorId, action: 'settings.update', objectId: 'platform', result: 'success', metadata: { fields: input.changes.map(change => change.key) } });
  });
  return configuration();
}

export function credentialStatuses() {
  let baseUrl: string | null = null, origin: string | null = null;
  try {
    const url = new URL(process.env.ZPAY_API_BASE_URL || 'https://zpayz.cn');
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/') baseUrl = url.origin;
  } catch { /* Never echo malformed URLs, which may contain credentials. */ }
  try { origin = authEnvironment().origin; } catch { /* Status only; no raw validation error leaves this function. */ }
  const from = process.env.AUTH_EMAIL_FROM || 'CCAGENT <account@notify.cjai.pro>';
  const address = from.match(/<([^<>]+)>$/)?.[1] || from;
  const senderValid = !/[\r\n]/.test(from) && z.email().safeParse(address).success;
  const channelId = process.env.ZPAY_CHANNEL_ID || '';
  const providerCount = Object.entries(process.env).filter(([name, value]) => /^CCAGENT_PROVIDER_[A-Z0-9_]+$/.test(name) && value).length;
  const callbackHttps = !!origin?.startsWith('https://');
  return { database: !!(process.env.DATABASE_URL || process.env.POSTGRES_URL), auth: (process.env.AUTH_SECRET?.length || 0) >= 32,
    authentication: { emailPasswordRequired: true, emailVerificationRequired: true },
    backend: { provider: 'postgresql', schema: databaseSchema(), maxConnections: databaseMaxConnections() },
    email: !!process.env.RESEND_API_KEY, emailDomain: senderValid ? address.slice(address.lastIndexOf('@') + 1).toLowerCase() : null, senderValid,
    storage: { configured: !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID), access: 'private' },
    providers: { configuredCount: providerCount },
    payment: { merchantConfigured: !!process.env.ZPAY_PID, keyConfigured: !!process.env.ZPAY_KEY,
      baseUrl, baseUrlValid: !!baseUrl, baseUrlSource: process.env.ZPAY_API_BASE_URL ? 'environment' : 'default', channel: 'alipay',
      channelIdConfigured: !!channelId, channelIdValid: !channelId || /^\d+(?:,\d+)*$/.test(channelId), callbackHttps,
      notifyUrl: callbackHttps ? `${origin}/api/payments/zpay/notify` : null, returnUrl: callbackHttps ? `${origin}/payment/return` : null }, markup: '1.3' };
}
export type CredentialStatuses = ReturnType<typeof credentialStatuses>;
