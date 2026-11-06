import { requirePermission } from '@/core/auth';
import { latestPrice, publishedRoute, routeInput, saveRoute } from '@/core/catalog';
import { database } from '@/core/db';
import { routes } from '@/core/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { errorResponse, json, readJson, requireSameOrigin } from '@/core/http';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    await requirePermission(request.headers, 'routes.write');
    const id = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,79}$/).parse(new URL(request.url).searchParams.get('id'));
    const [route] = await database().db.select().from(routes).where(eq(routes.id, id)).limit(1);
    if (!route) return json({ message: '路由不存在。' }, 404);
    let ready = false; try { await publishedRoute(id); ready = true; } catch {}
    return json({ route, latestPrice: await latestPrice(id), credentialConfigured: !!process.env[route.credentialEnv], ready });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    requireSameOrigin(request);
    const current = await requirePermission(request.headers, 'routes.write');
    return json(await saveRoute(current.user.id, routeInput.parse(await readJson(request))));
  } catch (error) { return errorResponse(error); }
}
