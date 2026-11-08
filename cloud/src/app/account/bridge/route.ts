import { accountBridgePage } from '@/core/account-bridge';
import { errorResponse } from '@/core/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  try { return accountBridgePage(request); } catch (error) { return errorResponse(error); }
}
