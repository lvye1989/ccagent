import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { database, type DatabaseReader } from './db';
import { audit, settings } from './db/schema';
import { lockAdministration } from './database-locks';
import { HttpError } from './http';

const key = 'client_latest_release';
const fields = {
  version: z.string().trim().regex(/^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/),
  title: z.string().trim().min(1).max(140),
  notes: z.string().trim().min(1).max(12000),
  downloadUrl: z.string().trim().max(2048).refine(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password; } catch { return false; }
  }, '请填写 HTTPS 下载链接'),
};
export const releaseInput = z.object({ ...fields, id: z.uuid(), revision: z.number().int().min(0) }).strict();
const releaseSchema = z.object({ ...fields, id: z.uuid(), publishedAt: z.iso.datetime() }).strict();
export type ClientRelease = z.infer<typeof releaseSchema>;
export async function readRelease(reader: DatabaseReader = database().db): Promise<{ revision: number; release: ClientRelease | null }> {
  const [row] = await reader.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (!row) return { revision: 0, release: null };
  const result = releaseSchema.safeParse(row.value);
  if (!result.success) throw new HttpError(503, 'RELEASE_UNAVAILABLE', '版本信息暂不可用，请稍后重试。');
  return { revision: row.version, release: result.data };
}
export async function publishRelease(actorId: string, input: z.infer<typeof releaseInput>) {
  const checked = releaseInput.parse(input);
  return database().db.transaction(async tx => {
    await lockAdministration(tx, 804714035);
    const current = await readRelease(tx);
    const { revision, ...content } = checked;
    if (current.release?.id === checked.id) {
      const { publishedAt: _, ...existing } = current.release;
      if (JSON.stringify(existing) !== JSON.stringify(content)) throw new HttpError(409, 'RELEASE_CONFLICT', '同一发送编号不能用于不同内容，请重新载入。');
      return current;
    }
    if (current.revision !== revision) throw new HttpError(409, 'RELEASE_CHANGED', '版本信息已被其他管理员更新，请重新载入后发送。');
    const release = { ...content, publishedAt: new Date().toISOString() };
    if (revision) await tx.update(settings).set({ value: release, version: revision + 1, updatedBy: actorId, updatedAt: new Date() }).where(eq(settings.key, key));
    else await tx.insert(settings).values({ key, value: release, version: 1, updatedBy: actorId });
    await tx.insert(audit).values({ id: randomUUID(), actorId, action: 'release.publish', objectId: release.id, result: 'success', metadata: { version: release.version, revision: revision + 1 } });
    return { revision: revision + 1, release };
  });
}
