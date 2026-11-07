import { permissionsFor, requirePermission } from '@/core/auth';
import { databaseOverview } from '@/core/admin-data';
import { errorResponse, json } from '@/core/http';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { const current = await requirePermission(request.headers, 'data.read'); return json(await databaseOverview(await permissionsFor(current.user.id))); }
  catch (error) { return errorResponse(error); }
}
