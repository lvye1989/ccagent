import { randomUUID } from 'node:crypto';
import { requirePermission } from '@/core/auth';
import { adminRows, adminView, csvResponse } from '@/core/admin-data';
import { database } from '@/core/db';
import { audit } from '@/core/db/schema';
import { errorResponse, json } from '@/core/http';

export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ section: string }> }) {
  try {
    const { section } = await context.params;
    const view = adminView(section), url = new URL(request.url), exporting = url.searchParams.get('format') === 'csv';
    const current = await requirePermission(request.headers, view.permission);
    if (exporting) await requirePermission(request.headers, 'data.export');
    const result = await adminRows(section, url, exporting);
    if (exporting) {
      await database().db.insert(audit).values({ id: randomUUID(), actorId: current.user.id, action: 'data.export', objectId: section, result: 'success', metadata: { rows: result.rows.length, total: result.total, limit: 10000 } });
      return csvResponse(result.rows, section);
    }
    return json(result);
  } catch (error) { return errorResponse(error); }
}
