import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageTaskInput, kieImageModels, validateKieRoute, kieBody, createKieClient, imageType } from '../src/core/kie-images';
import { requestPublicHttps } from '../src/core/upstream-hosts';
import { uploadInput } from '../src/core/files';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { defaultRoutes } from '../src/core/service-defaults';

test('all four official image modes expose only documented Kie 2.5 parameters and every valid size/aspect combination', () => {
  assert.deepEqual(defaultRoutes.parse({ chat: null, vision: null, decision: null, search: null, voice: null }), { chat: null, vision: null, decision: null, search: null, voice: null, image: null });
  const aspects = ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9', '27:16', '16:27', '9:8', '8:9'];
  for (const model of kieImageModels) for (const resolution of ['1K', '2K', '4K']) for (const aspect_ratio of aspects) {
    const result = imageTaskInput.safeParse({ model: 'route', prompt: 'Draw a city.', resolution, aspect_ratio, ...(model.endsWith('-image-to-image') ? { input_images: ['ccagent-file:00000000-0000-4000-8000-000000000000'] } : {}) });
    const supported = resolution === '1K' || !['27:16', '16:27', '9:8', '8:9'].includes(aspect_ratio); assert.equal(result.success, supported);
    if (result.success) { validateKieRoute({ protocol: 'kie-images', provider: 'kie', baseUrl: 'https://api.kie.ai/api/v1', upstreamModel: model, retries: 0 }, result.data); assert.equal('background' in kieBody(model, result.data, []).input, resolution === '1K'); }
  }
  for (const extra of [{ quality: 'high' }, { output_format: 'png' }, { n: 2 }, { mask: 'url' }, { seed: 1 }, { prompt: 'x'.repeat(20001) }, { input_images: Array(17).fill('ccagent-file:00000000-0000-4000-8000-000000000000') }]) assert.equal(imageTaskInput.safeParse({ model: 'route', prompt: 'x', ...extra }).success, false);
  assert.equal(uploadInput.safeParse({ purpose: 'image', contentType: 'image/png', size: 30 * 1024 * 1024 }).success, true);
  assert.equal(uploadInput.safeParse({ purpose: 'image', contentType: 'image/png', size: 30 * 1024 * 1024 + 1 }).success, false);
});

test('pinned download transport rejects insecure, credentialed, local, literal IP, query-disallowed and unapproved URLs before network', async () => {
  for (const url of ['http://api.kie.ai/image.png', 'https://user:password@api.kie.ai/image.png', 'https://127.0.0.1/image.png', 'https://localhost/image.png', 'https://metadata.google.internal/image.png', 'https://api.kie.ai:444/image.png', 'https://api.kie.ai/image.png#hash']) await assert.rejects(requestPublicHttps(url, {}));
  await assert.rejects(requestPublicHttps('https://api.kie.ai/x?a=1', {}));
  await assert.rejects(requestPublicHttps('https://other.kie.ai/api/v1/jobs/createTask', {}, { allowedHosts: ['api.kie.ai'] }));
});

test('supplier body errors, exact task IDs, result lists and image signatures are verified without exposing credentials', async () => {
  const input = imageTaskInput.parse({ model: 'route', prompt: 'x' });
  let payload: unknown = { code: 200, data: { taskId: 'task_1' } };
  const client = createKieClient('fixture-secret', async (_url, init) => { assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-secret'); return Response.json(payload); });
  assert.deepEqual(await client.create(kieImageModels[0], input, [], new AbortController().signal), { rejected: false, taskId: 'task_1' });
  payload = { code: 402, msg: 'fixture-secret' }; assert.deepEqual(await client.create(kieImageModels[0], input, [], new AbortController().signal), { rejected: true, taskId: null });
  payload = { code: 200, data: { taskId: 'wrong-task', state: 'success', resultJson: '{"resultUrls":["https://example.com/1.png"]}' } }; await assert.rejects(client.query('task_1', new AbortController().signal));
  assert.equal(imageType(Buffer.from('<html>bad</html>')), null);
});

test('public transport pins validated DNS, rejects private answers and contains malformed upstream responses', async () => {
  const originalLookup = dns.lookup, originalRequest = https.request; let requested = 0;
  try {
    dns.lookup = (async () => [{ address: '93.184.216.34', family: 4 }]) as unknown as typeof dns.lookup;
    let status = 700, responseHeaders: Record<string, string> = {};
    https.request = ((_url: unknown, options: { lookup: (host: string, options: unknown, callback: (error: unknown, address: string, family: number) => void) => void }, callback: (incoming: unknown) => void) => {
      requested++; options.lookup('api.kie.ai', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4); });
      const request = new EventEmitter() as EventEmitter & { end: () => void };
      request.end = () => { const incoming = Object.assign(new PassThrough(), { statusCode: status, headers: responseHeaders }); callback(incoming); if (!incoming.destroyed) incoming.end('ok'); }; return request;
    }) as unknown as typeof https.request;
    await assert.rejects(requestPublicHttps('https://api.kie.ai/result', {}), { code: 'UPSTREAM_RESPONSE_INVALID' });
    status = 101; await assert.rejects(requestPublicHttps('https://api.kie.ai/result', {}), { code: 'UPSTREAM_RESPONSE_INVALID' });
    status = 200; responseHeaders = { 'content-type': 'image/png\r\nInvalid: injected' }; await assert.rejects(requestPublicHttps('https://api.kie.ai/result', {}), { code: 'UPSTREAM_RESPONSE_INVALID' });
    responseHeaders = { 'content-type': 'text/plain' }; const valid = await requestPublicHttps('https://api.kie.ai/result?signature=public', {}, { allowQuery: true }); assert.equal(await valid.text(), 'ok');
    const before = requested; dns.lookup = (async () => [{ address: '127.0.0.1', family: 4 }]) as unknown as typeof dns.lookup;
    await assert.rejects(requestPublicHttps('https://api.kie.ai/result', {})); assert.equal(requested, before);
  } finally { dns.lookup = originalLookup; https.request = originalRequest; }
});
