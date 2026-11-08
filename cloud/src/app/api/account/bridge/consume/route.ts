import { consumeAccountBridge } from '@/core/account-bridge';
import { authentication } from '@/core/auth';
import { errorResponse, HttpError, json, readJson, requireSameOrigin } from '@/core/http';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const { state, ticket } = z.object({ state: z.string().max(8192), ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(await readJson(request));
    const claim = await consumeAccountBridge(state, ticket, request.headers);
    const signed = await authentication().api.setAccountBridgeSession({ body: { sessionId: claim.sessionId, userId: claim.userId }, asResponse: true });
    if (!signed.ok) throw new HttpError(401, 'ACCOUNT_BRIDGE_SESSION_EXPIRED', '应用登录已失效，请重新登录后打开账户中心。');
    const response = json({ target: claim.target });
    for (const cookie of signed.headers.getSetCookie()) response.headers.append('set-cookie', cookie);
    response.headers.append('set-cookie', claim.clearFallbackCookie);
    return response;
  } catch (error) { return errorResponse(error); }
}
