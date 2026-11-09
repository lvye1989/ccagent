import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { database } from './db';
import { apiKeys, audit, user } from './db/schema';
import { HttpError } from './http';
import { hashKey } from './keys';
import { parseYuanToMicro } from './money-display';
import { moneyValue } from './wallet';

const safeColumns = { id: apiKeys.id, userId: apiKeys.userId, name: apiKeys.name, prefix: apiKeys.prefix,
  enabled: apiKeys.enabled, limit: apiKeys.limit, spent: apiKeys.spent, frozen: apiKeys.frozen,
  createdAt: apiKeys.createdAt, revokedAt: apiKeys.revokedAt };
const nameInput = z.string().trim().min(1).max(80);
const yuanLimit = z.string().max(24).nullable();
export const adminKeyCreateInput = z.object({ userId: z.string().min(1).max(200), name: nameInput, limitYuan: yuanLimit.optional() }).strict();
export const adminKeyUpdateInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('revoke') }).strict(),
  z.object({ action: z.literal('limit'), limit: z.string().max(16).nullable() }).strict(),
  z.object({ action: z.literal('update'), name: nameInput, limitYuan: yuanLimit }).strict(),
]);

function limitInMicro(value: string | null | undefined): bigint | null {
  if (value == null || value === '') return null;
  try { return moneyValue(parseYuanToMicro(value)); }
  catch { throw new HttpError(400, 'INVALID_AMOUNT', '累计额度请输入有效的人民币元金额，最多六位小数。'); }
}

export async function findAdminKeyOwner(email: string) {
  const [owner] = await database().db.select({ id: user.id, name: user.name, email: user.email,
    emailVerified: user.emailVerified, banned: user.banned }).from(user)
    .where(sql`lower(${user.email}) = ${email.toLowerCase()}`).limit(1);
  if (!owner) throw new HttpError(404, 'USER_NOT_FOUND', '未找到该邮箱对应的用户。');
  return owner;
}

export async function adminKeyById(id: string) {
  const [key] = await database().db.select({ ...safeColumns, email: user.email }).from(apiKeys)
    .innerJoin(user, eq(user.id, apiKeys.userId)).where(eq(apiKeys.id, id)).limit(1);
  if (!key) throw new HttpError(404, 'KEY_NOT_FOUND', 'API Key 不存在。');
  return key;
}

/** The secret is returned once and only its hash is stored; audit stays in the same transaction. */
export async function createAdminKey(actorId: string, input: z.infer<typeof adminKeyCreateInput>) {
  const limit = limitInMicro(input.limitYuan), secret = `ccagent_${randomBytes(32).toString('base64url')}`;
  const key = await database().db.transaction(async tx => {
    const [owner] = await tx.select({ id: user.id, banned: user.banned, verified: user.emailVerified })
      .from(user).where(eq(user.id, input.userId)).for('update');
    if (!owner) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在。');
    if (owner.banned || !owner.verified) throw new HttpError(400, 'USER_UNAVAILABLE', '请先确认用户已完成邮箱验证，且账户未被禁用。');
    const [created] = await tx.insert(apiKeys).values({ id: randomUUID(), userId: owner.id, name: input.name,
      prefix: secret.slice(0, 16), hash: hashKey(secret), limit }).returning(safeColumns);
    await tx.insert(audit).values({ id: randomUUID(), actorId, action: 'keys.create', objectId: created.id,
      result: 'success', metadata: { userId: owner.id, name: created.name, limit: limit?.toString() ?? null } });
    return created;
  });
  return { key, secret };
}

export async function updateAdminKey(actorId: string, id: string, input: z.infer<typeof adminKeyUpdateInput>) {
  return database().db.transaction(async tx => {
    const [key] = await tx.select().from(apiKeys).where(eq(apiKeys.id, id)).for('update');
    if (!key) throw new HttpError(404, 'KEY_NOT_FOUND', 'API Key 不存在。');
    let changes: Partial<typeof apiKeys.$inferInsert>;
    if (input.action === 'revoke') changes = { enabled: false, revokedAt: key.revokedAt ?? new Date() };
    else {
      const limit = input.action === 'limit' ? input.limit === null ? null : moneyValue(input.limit, true) : limitInMicro(input.limitYuan);
      if (limit !== null && limit < key.spent + key.frozen) throw new HttpError(400, 'LIMIT_BELOW_USAGE', '累计额度不能低于已使用金额与冻结额度之和。');
      changes = input.action === 'update' ? { name: input.name, limit } : { limit };
    }
    const [saved] = await tx.update(apiKeys).set(changes).where(eq(apiKeys.id, id)).returning(safeColumns);
    await tx.insert(audit).values({ id: randomUUID(), actorId, action: `keys.${input.action}`, objectId: id,
      result: 'success', metadata: input.action === 'revoke' ? { userId: key.userId } : {
        userId: key.userId, previousName: key.name, name: saved.name,
        previousLimit: key.limit?.toString() ?? null, limit: saved.limit?.toString() ?? null,
      } });
    return saved;
  });
}

/** Logical deletion preserves reservation foreign keys and permits in-flight financial settlement. */
export async function deleteAdminKey(actorId: string, id: string) {
  return database().db.transaction(async tx => {
    const [key] = await tx.select().from(apiKeys).where(eq(apiKeys.id, id)).for('update');
    if (!key) throw new HttpError(404, 'KEY_NOT_FOUND', 'API Key 不存在。');
    await tx.update(apiKeys).set({ enabled: false, revokedAt: key.revokedAt ?? new Date() }).where(eq(apiKeys.id, id));
    await tx.insert(audit).values({ id: randomUUID(), actorId, action: 'keys.delete', objectId: id, result: 'success',
      metadata: { userId: key.userId, logicalDelete: true, previouslyRevoked: !!key.revokedAt } });
  });
}
