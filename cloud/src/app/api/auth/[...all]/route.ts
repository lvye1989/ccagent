import { authentication, requireSession } from '@/core/auth';
import { errorResponse, HttpError, json, readJson, requireSameOrigin } from '@/core/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const allowed = new Map([
  ['/sign-in/email', 'POST'], ['/sign-up/email', 'POST'], ['/get-session', 'GET'], ['/sign-out', 'POST'],
  ['/request-password-reset', 'POST'], ['/reset-password', 'POST'], ['/verify-email', 'GET'],
  ['/send-verification-email', 'POST'], ['/list-sessions', 'GET'], ['/revoke-session', 'POST'],
  ['/revoke-sessions', 'POST'], ['/revoke-other-sessions', 'POST'], ['/change-password', 'POST'],
]);
async function handle(request: Request) {
  try {
    const path = new URL(request.url).pathname.slice('/api/auth'.length);
    if (allowed.get(path) !== request.method) throw new HttpError(404, 'NOT_FOUND', '接口不存在。');
    if (path === '/get-session') {
      const current = await requireSession(request.headers);
      return json(current);
    }
    if (request.method === 'POST') {
      requireSameOrigin(request);
      await readJson(request.clone());
    }
    const response = await authentication().handler(request);
    response.headers.set('cache-control', 'no-store');
    response.headers.set('x-content-type-options', 'nosniff');
    return response;
  } catch (error) { return errorResponse(error); }
}
export const GET = handle;
export const POST = handle;
