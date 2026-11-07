import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requirePermission } from '@/core/auth';
import { database } from '@/core/db';
import { lockAdministration } from '@/core/database-locks';
import { audit, roles, session, user, userRoles } from '@/core/db/schema';
import { errorResponse, HttpError, json, readJson, requireSameOrigin } from '@/core/http';

const update = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), banned: z.boolean(), reason: z.string().trim().min(3).max(200) }).strict(),
  z.object({ action: z.literal('roles'), roles: z.array(z.string().min(1).max(50)).min(1).max(10) }).strict(),
]);
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const input = update.parse(await readJson(request));
    const current = await requirePermission(request.headers, input.action === 'roles' ? 'roles.write' : 'users.write');
    const { id } = await context.params;
    if (id.length > 200) throw new HttpError(400, 'INVALID_USER', '用户编号无效。');
    if (id === current.user.id && ((input.action === 'status' && input.banned) || (input.action === 'roles' && !input.roles.includes('admin')))) {
      throw new HttpError(400, 'SELF_LOCKOUT', '请由其他管理员处理你自己的禁用或管理员权限移除。');
    }
    await database().db.transaction(async tx => {
      await lockAdministration(tx, 804714032);
      const [target] = await tx.select().from(user).where(eq(user.id, id)).for('update');
      if (!target) throw new HttpError(404, 'USER_NOT_FOUND', '用户不存在。');
      const assigned = await tx.select().from(userRoles).where(eq(userRoles.userId, id));
      const removingAdmin = assigned.some(row => row.roleId === 'admin') && ((input.action === 'status' && input.banned) || (input.action === 'roles' && !input.roles.includes('admin')));
      if (removingAdmin && !target.banned) {
        const [{ count }] = await tx.select({ count: sql<number>`count(*)::integer` }).from(userRoles).innerJoin(user, eq(user.id, userRoles.userId)).where(and(eq(userRoles.roleId, 'admin'), eq(user.banned, false)));
        if (count <= 1) throw new HttpError(409, 'LAST_ADMINISTRATOR', '必须保留至少一个可用的管理员账户。');
      }
      if (input.action === 'status') {
        await tx.update(user).set({ banned: input.banned, banReason: input.banned ? input.reason : null, banExpires: null, updatedAt: new Date() }).where(eq(user.id, id));
        if (input.banned) await tx.delete(session).where(eq(session.userId, id));
      } else {
        const ids = [...new Set(input.roles)], found = await tx.select().from(roles).where(inArray(roles.id, ids));
        if (found.length !== ids.length) throw new HttpError(400, 'INVALID_ROLE', '提交的角色不存在。');
        await tx.delete(userRoles).where(eq(userRoles.userId, id));
        await tx.insert(userRoles).values(ids.map(roleId => ({ userId: id, roleId })));
        await tx.update(user).set({ role: ids.includes('admin') ? 'admin' : 'user', updatedAt: new Date() }).where(eq(user.id, id));
      }
      await tx.insert(audit).values({ id: randomUUID(), actorId: current.user.id, action: `users.${input.action}`, objectId: id, result: 'success', metadata: input });
    });
    return json({ saved: true });
  } catch (error) { return errorResponse(error); }
}
