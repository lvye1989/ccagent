import { requireSession } from '@/core/auth';
import { errorResponse, json, pagination } from '@/core/http';
import { walletFor, walletLedger } from '@/core/wallet';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const { user } = await requireSession(request.headers);
    const paging = pagination(new URL(request.url));
    const [wallet, entries] = await Promise.all([walletFor(user.id), walletLedger(user.id, paging.offset, paging.pageSize)]);
    return json({ wallet, entries, ...paging });
  } catch (error) { return errorResponse(error); }
}
