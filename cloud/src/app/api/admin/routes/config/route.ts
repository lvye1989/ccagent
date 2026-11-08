import { requirePermission } from '@/core/auth';
import { gatewayConfiguration, gatewayConfigurationInput, saveGatewayConfiguration } from '@/core/gateway-configuration';
import { errorResponse, json, readJson, requireSameOrigin } from '@/core/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try { await requirePermission(request.headers, 'routes.write'); return json(await gatewayConfiguration()); }
  catch (error) { return errorResponse(error); }
}
export async function PUT(request: Request) {
  try { requireSameOrigin(request); const current = await requirePermission(request.headers, 'routes.write');
    return json(await saveGatewayConfiguration(current.user.id, gatewayConfigurationInput.parse(await readJson(request)))); }
  catch (error) { return errorResponse(error); }
}
