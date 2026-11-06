import { permissionsFor, requireSession } from '@/core/auth';
import { errorResponse, json } from '@/core/http';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const current = await requireSession(request.headers);
    return json({ user: current.user, expiresAt: current.session.expiresAt, permissions: await permissionsFor(current.user.id) });
  } catch (error) { return errorResponse(error); }
}
