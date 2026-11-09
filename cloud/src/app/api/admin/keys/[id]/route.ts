import { requirePermission } from '@/core/auth';
import { adminKeyById, adminKeyUpdateInput, deleteAdminKey, updateAdminKey } from '@/core/admin-keys';
import { errorResponse, json, readJson, requireSameOrigin } from '@/core/http';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(request.headers, 'keys.write');
    return json({ key: await adminKeyById((await context.params).id) });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const current = await requirePermission(request.headers, 'keys.write');
    const input = adminKeyUpdateInput.parse(await readJson(request));
    const { id } = await context.params;
    return json({ saved: true, key: await updateAdminKey(current.user.id, id, input) });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const current = await requirePermission(request.headers, 'keys.write');
    await deleteAdminKey(current.user.id, (await context.params).id);
    return json({ deleted: true, revoked: true, financialHistoryRetained: true });
  } catch (error) { return errorResponse(error); }
}
