import { z } from 'zod';
import { requireSession } from '@/core/auth';
import { createKey, listKeys, revokeKey } from '@/core/keys';
import { errorResponse, json, readJson, requireSameOrigin } from '@/core/http';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { const { user } = await requireSession(request.headers); return json({ keys: await listKeys(user.id) }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const { user } = await requireSession(request.headers);
    const value = z.object({ name: z.string().trim().min(1).max(80), limit: z.string().max(16).nullable().optional() }).strict().parse(await readJson(request));
    return json(await createKey(user.id, value.name, value.limit), 201);
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(request: Request) {
  try {
    requireSameOrigin(request);
    const { user } = await requireSession(request.headers);
    const value = z.object({ id: z.string().uuid() }).strict().parse(await readJson(request));
    await revokeKey(user.id, value.id);
    return json({ revoked: true });
  } catch (error) { return errorResponse(error); }
}
