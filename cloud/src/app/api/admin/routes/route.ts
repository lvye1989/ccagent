import { permissionsFor, requirePermission, requireSession } from '@/core/auth';
import { latestPrice, publishedRoute, routeFingerprint, routeInput, saveRoute } from '@/core/catalog';
import { database } from '@/core/db';
import { routes } from '@/core/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { errorResponse, HttpError, json, readJson, requireSameOrigin } from '@/core/http';
import { routeCredentialStatus } from '@/core/provider-credentials';
import { adminRows } from '@/core/admin-data';
import { assertRouteNotArchived } from '@/core/route-lifecycle';
import { deleteRoute, deleteRouteInput } from '@/core/route-management';

const writeInput = z.object({ apiKey: z.string().max(8192).optional(), removeApiKey: z.boolean().optional(),
  expectedUpdatedAt: z.iso.datetime({ offset: true }).optional() }).passthrough();

async function requireRouteReader(headers: Headers) {
  const current = await requireSession(headers), permissions = await permissionsFor(current.user.id);
  if (!permissions.some(value => value === 'admin.read' || value === 'routes.write')) throw new HttpError(403, 'PERMISSION_DENIED', '没有查看服务路由的权限。');
}

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    await requireRouteReader(request.headers);
    const url = new URL(request.url);
    if (!url.searchParams.has('id')) {
      if (url.searchParams.has('format') && url.searchParams.get('format') !== 'json') throw new HttpError(400, 'INVALID_FORMAT', '此接口仅提供 JSON 查询，请使用列表上的导出入口。');
      return json(await adminRows('routes', url));
    }
    if (url.searchParams.size !== 1 || url.searchParams.getAll('id').length !== 1) throw new HttpError(400, 'INVALID_FILTER', '单条路由查询仅支持一个编号参数。');
    const id = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,79}$/).parse(url.searchParams.get('id'));
    await assertRouteNotArchived(id);
    const [route] = await database().db.select().from(routes).where(eq(routes.id, id)).limit(1);
    if (!route) return json({ message: '路由不存在。' }, 404);
    let ready = false; try { await publishedRoute(id); ready = true; } catch {}
    const credentialStatus = await routeCredentialStatus(route);
    const publicRoute = { id: route.id, name: route.name, service: route.service, protocol: route.protocol, provider: route.provider,
      baseUrl: route.baseUrl, upstreamModel: route.upstreamModel, credentialEnv: route.credentialEnv, enabled: route.enabled,
      timeoutMs: route.timeoutMs, retries: route.retries, options: routeInput.shape.options.parse(route.options), createdAt: route.createdAt, updatedAt: route.updatedAt };
    const executionSupported = ['openai-chat', 'openai-responses', 'jev-decisions', 'tavily', 'bocha', 'dashscope-tts', 'kie-images'].includes(route.protocol);
    return json({ route: publicRoute, routeFingerprint: routeFingerprint(route), latestPrice: await latestPrice(id), credentialConfigured: credentialStatus.configured,
      credentialStatus, ready, capabilities: { executionSupported, configurationOnly: !executionSupported } });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    requireSameOrigin(request);
    const current = await requirePermission(request.headers, 'routes.write');
    const { apiKey, removeApiKey, expectedUpdatedAt, ...route } = writeInput.parse(await readJson(request));
    return json(await saveRoute(current.user.id, routeInput.parse(route), { apiKey, remove: removeApiKey }, { expectedUpdatedAt }));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const current = await requirePermission(request.headers, 'routes.write');
    const { apiKey, removeApiKey, expectedUpdatedAt, ...route } = writeInput.parse(await readJson(request));
    if (expectedUpdatedAt !== undefined) throw new HttpError(400, 'INVALID_INPUT', '新建路由不接受已有版本，请使用编辑操作。');
    return json(await saveRoute(current.user.id, routeInput.parse(route), { apiKey, remove: removeApiKey }, { mode: 'create' }), 201);
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    requireSameOrigin(request);
    const current = await requirePermission(request.headers, 'routes.write');
    return json(await deleteRoute(current.user.id, deleteRouteInput.parse(await readJson(request))));
  } catch (error) { return errorResponse(error); }
}
