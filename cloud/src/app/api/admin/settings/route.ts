import { requirePermission } from '@/core/auth';
import { configuration, configurationUpdate, credentialStatuses, saveConfiguration } from '@/core/configuration';
import { errorResponse, json, readJson, requireSameOrigin } from '@/core/http';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { await requirePermission(request.headers, 'settings.write'); return json({ settings: await configuration(), credentials: credentialStatuses() }); }
  catch (error) { return errorResponse(error); }
}
export async function PUT(request: Request) {
  try {
    requireSameOrigin(request);
    const current = await requirePermission(request.headers, 'settings.write');
    const input = configurationUpdate.parse(await readJson(request));
    return json({ saved: true, settings: await saveConfiguration(current.user.id, input), effective: 'next-request' });
  } catch (error) { return errorResponse(error); }
}
