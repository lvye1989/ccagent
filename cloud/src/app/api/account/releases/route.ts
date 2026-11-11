import { requireSession } from '@/core/auth';
import { readRelease } from '@/core/releases';
import { errorResponse, json } from '@/core/http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { await requireSession(request.headers); return json({ release: (await readRelease()).release }); }
  catch (error) { return errorResponse(error); }
}
