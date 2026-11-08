import { issueAccountBridge } from '@/core/account-bridge';
import { requireSession } from '@/core/auth';
import { errorResponse, json, readJson, requireSameOrigin } from '@/core/http';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const { state } = z.object({ state: z.string().max(8192) }).strict().parse(await readJson(request));
    return json(await issueAccountBridge(state, await requireSession(request.headers)));
  } catch (error) { return errorResponse(error); }
}
