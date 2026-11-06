import { requirePermission } from '@/core/auth';
import { createPriceVersion, priceInput } from '@/core/catalog';
import { errorResponse, json, readJson, requireSameOrigin } from '@/core/http';

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const current = await requirePermission(request.headers, 'routes.write');
    return json(await createPriceVersion(current.user.id, priceInput.parse(await readJson(request))), 201);
  } catch (error) { return errorResponse(error); }
}
