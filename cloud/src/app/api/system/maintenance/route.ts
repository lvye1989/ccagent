import { errorResponse, json } from '@/core/http';
import { requireMaintenanceIdentity, runMaintenance } from '@/core/maintenance';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { requireMaintenanceIdentity(request); return json(await runMaintenance()); }
  catch (error) { return errorResponse(error); }
}
