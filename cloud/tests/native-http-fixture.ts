import { createServer } from 'node:http';
import { createGateway, availableModels } from '../src/core/gateway';
import { requireSession, permissionsFor } from '../src/core/auth';
import { walletFor } from '../src/core/wallet';
import { initializeUpload, completeUpload, readOwnedFile, deleteOwnedFile, uploadInput } from '../src/core/files';
import { ownedCallStatus } from '../src/core/calls';
import { errorResponse, json, readJson, requireSameOrigin } from '../src/core/http';
import type { createAuthentication } from '../src/core/auth';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { user, reservations, blobs } from '../src/core/db/schema';

/** Real HTTP boundary for isolated database/supplier checks. Never part of production deployment. */
export async function nativeHttpFixture(options: { schema: string; fetch?: typeof fetch }) {
  if (!/^ccagent_test_[a-f0-9]{16}$/.test(options.schema) || process.env.DB_SCHEMA !== options.schema ||
    [user, reservations, blobs].some(table => getTableConfig(table).schema !== options.schema)) throw new Error('REFUSE_NONISOLATED_HTTP_FIXTURE');
  let auth: ReturnType<typeof createAuthentication> | undefined;
  const gateway = createGateway({ fetch: options.fetch });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const method = incoming.method ?? 'GET', headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const request = new Request(origin + incoming.url, { method, headers, ...(['GET', 'HEAD'].includes(method) ? {} : { body: new Uint8Array(Buffer.concat(chunks)) }) });
      const pathname = new URL(request.url).pathname;
      let response: Response;
      try {
        if (pathname.startsWith('/api/auth/')) {
          if (!auth) throw new Error('AUTH_FIXTURE_NOT_READY'); response = await auth.handler(request);
        } else if (pathname === '/v1/models') response = json(await availableModels(request));
        else if (pathname === '/api/account/me') {
          const current = await requireSession(request.headers); response = json({ user: current.user, permissions: await permissionsFor(current.user.id) });
        } else if (pathname === '/api/account/wallet') {
          const { user } = await requireSession(request.headers); response = json({ wallet: await walletFor(user.id), entries: [] });
        } else if (pathname.startsWith('/api/account/calls/')) response = json(await ownedCallStatus(request, decodeURIComponent(pathname.split('/').at(-1)!)));
        else if (pathname === '/api/files' && method === 'POST') {
          requireSameOrigin(request); const { user } = await requireSession(request.headers); response = json(await initializeUpload(user.id, uploadInput.parse(await readJson(request))), 201);
        } else if (pathname.startsWith('/api/files/')) {
          const { user } = await requireSession(request.headers), id = pathname.split('/').at(-1)!;
          if (method === 'POST') { requireSameOrigin(request); response = json(await completeUpload(user.id, id)); }
          else if (method === 'DELETE') { requireSameOrigin(request); await deleteOwnedFile(user.id, id); response = json({ deleted: true }); }
          else { const file = await readOwnedFile(user.id, id); response = new Response(file.stream, { headers: { 'content-type': file.record.contentType, 'content-length': String(file.record.size) } }); }
        } else if (pathname === '/v1/responses') response = await gateway.execute(request, 'responses');
        else if (pathname === '/v1/voice') response = await gateway.execute(request, 'voice');
        else response = json({ code: 'NOT_FOUND' }, 404);
      } catch (error) { response = errorResponse(error); }
      for (const [name, value] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name, value);
      const cookies = response.headers.getSetCookie(); if (cookies.length) outgoing.setHeader('set-cookie', cookies);
      outgoing.writeHead(response.status);
      if (response.body) { const reader = response.body.getReader(); try { while (true) { const item = await reader.read(); if (item.done) break; outgoing.write(item.value); } } finally { reader.releaseLock(); } }
      outgoing.end();
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'application/json' });
      outgoing.end('{"code":"FIXTURE_REQUEST_FAILED"}');
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('NO_FIXTURE_PORT');
  const origin = `http://127.0.0.1:${address.port}`;
  return { origin, setAuthentication(value: ReturnType<typeof createAuthentication>) { auth = value; },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
