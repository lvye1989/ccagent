import { requirePermission } from '@/core/auth';
import { databaseOverview } from '@/core/admin-data';
import { errorResponse, json } from '@/core/http';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { await requirePermission(request.headers, 'data.read'); return json(await databaseOverview()); }
  catch (error) { return errorResponse(error); }
}
