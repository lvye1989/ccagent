import { requirePermission } from '@/core/auth';
import { adminServiceDefaults, saveServiceDefaults, serviceDefaultsInput } from '@/core/service-defaults';
import { errorResponse, json, readJson, requireSameOrigin } from '@/core/http';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { await requirePermission(request.headers, 'routes.write'); return json(await adminServiceDefaults()); }
  catch (error) { return errorResponse(error); }
}
export async function PUT(request: Request) {
  try {
    requireSameOrigin(request);
    const current = await requirePermission(request.headers, 'routes.write');
    return json(await saveServiceDefaults(current.user.id, serviceDefaultsInput.parse(await readJson(request))));
  } catch (error) { return errorResponse(error); }
}
