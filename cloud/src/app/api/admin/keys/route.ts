import { z } from 'zod';
import { requirePermission } from '@/core/auth';
import { adminRows } from '@/core/admin-data';
import { adminKeyCreateInput, createAdminKey, findAdminKeyOwner } from '@/core/admin-keys';
import { errorResponse, HttpError, json, readJson, requireSameOrigin } from '@/core/http';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    await requirePermission(request.headers, 'keys.write');
    const url = new URL(request.url);
    if (url.searchParams.has('email')) {
      if (url.searchParams.size !== 1 || url.searchParams.getAll('email').length !== 1) throw new HttpError(400, 'INVALID_FILTER', '用户查询仅支持一个邮箱参数。');
      const email = z.email().max(320).parse(url.searchParams.get('email')?.trim());
      return json({ user: await findAdminKeyOwner(email) });
    }
    return json(await adminRows('keys', url));
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const current = await requirePermission(request.headers, 'keys.write');
    const input = adminKeyCreateInput.parse(await readJson(request));
    return json(await createAdminKey(current.user.id, input), 201);
  } catch (error) { return errorResponse(error); }
}
