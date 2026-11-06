import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { database } from './db';
import { apiKeys } from './db/schema';
import { HttpError } from './http';
import { moneyValue } from './wallet';
import { requireSession } from './auth';

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');
const safeColumns = { id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, enabled: apiKeys.enabled, limit: apiKeys.limit,
  spent: apiKeys.spent, frozen: apiKeys.frozen, createdAt: apiKeys.createdAt, revokedAt: apiKeys.revokedAt };
export async function listKeys(userId: string) {
  return database().db.select(safeColumns).from(apiKeys).where(eq(apiKeys.userId, userId)).orderBy(sql`${apiKeys.createdAt} desc`).limit(100);
}
export async function createKey(userId: string, name: string, limit?: string | null) {
  const value = `ccagent_${randomBytes(32).toString('base64url')}`;
  const [key] = await database().db.insert(apiKeys).values({ id: randomUUID(), userId, name, prefix: value.slice(0, 16), hash: hashKey(value), limit: limit ? moneyValue(limit, true) : null }).returning(safeColumns);
  return { key, secret: value };
}
export async function revokeKey(userId: string, keyId: string): Promise<void> {
  const result = await database().db.update(apiKeys).set({ enabled: false, revokedAt: new Date() }).where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId))).returning({ id: apiKeys.id });
  if (!result.length) throw new HttpError(404, 'KEY_NOT_FOUND', 'API Key 不存在。');
}
export async function requireServiceIdentity(request: Request) {
  const current = await requireSession(request.headers);
  const match = /^Bearer (ccagent_[A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') || '');
  if (!match) throw new HttpError(401, 'API_KEY_REQUIRED', '请配置有效的个人 CCAGENT API Key。');
  const [key] = await database().db.select({ id: apiKeys.id, userId: apiKeys.userId, enabled: apiKeys.enabled, revokedAt: apiKeys.revokedAt })
    .from(apiKeys).where(eq(apiKeys.hash, hashKey(match[1]))).limit(1);
  if (!key || key.userId !== current.user.id || !key.enabled || key.revokedAt) throw new HttpError(403, 'INVALID_API_KEY', 'API Key 无效、已撤销或不属于当前账户。');
  return { ...current, keyId: key.id };
}
