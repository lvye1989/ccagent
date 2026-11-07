import { ownedCallStatus } from '@/core/calls';
import { errorResponse, json } from '@/core/http';

export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const { id } = await context.params; return json(await ownedCallStatus(request, id)); }
  catch (error) { return errorResponse(error); }
}
