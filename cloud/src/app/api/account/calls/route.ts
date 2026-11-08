import { ownedCallStatus } from '@/core/calls';
import { errorResponse, HttpError, json } from '@/core/http';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const search = new URL(request.url).searchParams;
    if (search.getAll('id').length !== 1 || [...search.keys()].some(key => key !== 'id')) throw new HttpError(400, 'INVALID_CALL_QUERY', '请提供唯一的调用标识。');
    return json(await ownedCallStatus(request, search.get('id')!));
  } catch (error) { return errorResponse(error); }
}
