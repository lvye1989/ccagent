import { requirePermission } from '@/core/auth';
import { latestPrice, publishedRoute, routeFingerprint, routeInput, saveRoute } from '@/core/catalog';
import { database } from '@/core/db';
import { routes } from '@/core/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { errorResponse, json, readJson, requireSameOrigin } from '@/core/http';
import { routeCredentialStatus } from '@/core/provider-credentials';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    await requirePermission(request.headers, 'routes.write');
    const id = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,79}$/).parse(new URL(request.url).searchParams.get('id'));
    const [route] = await database().db.select().from(routes).where(eq(routes.id, id)).limit(1);
    if (!route) return json({ message: '路由不存在。' }, 404);
    let ready = false; try { await publishedRoute(id); ready = true; } catch {}
    const credentialStatus = await routeCredentialStatus(route);
    return json({ route, routeFingerprint: routeFingerprint(route), latestPrice: await latestPrice(id), credentialConfigured: credentialStatus.configured, credentialStatus, ready });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    requireSameOrigin(request);
    const current = await requirePermission(request.headers, 'routes.write');
    const body = z.object({ apiKey: z.string().max(8192).optional(), removeApiKey: z.boolean().optional() }).passthrough().parse(await readJson(request));
    const { apiKey, removeApiKey, ...route } = body;
    return json(await saveRoute(current.user.id, routeInput.parse(route), { apiKey, remove: removeApiKey }));
  } catch (error) { return errorResponse(error); }
}
