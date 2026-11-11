import { requirePermission } from '@/core/auth';
import { readRelease, publishRelease, releaseInput } from '@/core/releases';
import { errorResponse, json, readJson, requireSameOrigin } from '@/core/http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { await requirePermission(request.headers, 'settings.write'); return json(await readRelease()); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const current = await requirePermission(request.headers, 'settings.write');
    return json(await publishRelease(current.user.id, releaseInput.parse(await readJson(request))));
  } catch (error) { return errorResponse(error); }
}
