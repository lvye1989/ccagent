import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from './http';
import { normalizeUpstreamHost, publicUpstreamAddresses, requestPublicHttps } from './upstream-hosts';

export const kieBaseUrl = 'https://api.kie.ai/api/v1';
export const kieImageModels = [
  'gpt-image-2-5-flare-text-to-image', 'gpt-image-2-5-flare-image-to-image',
  'gpt-image-2-5-sunburst-text-to-image', 'gpt-image-2-5-sunburst-image-to-image',
] as const;
export const imageResolutions = ['1K', '2K', '4K'] as const;
export const imageAspects = ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9', '27:16', '16:27', '9:8', '8:9'] as const;
export const imageTaskInput = z.object({
  model: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,79}$/), prompt: z.string().trim().min(1).max(20000),
  input_images: z.array(z.string().regex(/^ccagent-file:[a-f0-9-]{36}$/)).max(16).default([]),
  aspect_ratio: z.enum(imageAspects).default('auto'), resolution: z.enum(imageResolutions).default('1K'),
  background: z.enum(['transparent', 'opaque', 'auto']).default('auto'),
}).strict().superRefine((value, context) => {
  if (value.resolution !== '1K' && ['27:16', '16:27', '9:8', '8:9'].includes(value.aspect_ratio)) context.addIssue({ code: 'custom', path: ['aspect_ratio'], message: 'This aspect ratio requires 1K' });
  if (value.resolution !== '1K' && value.background !== 'auto') context.addIssue({ code: 'custom', path: ['background'], message: 'Background control requires 1K' });
});
export type ImageTaskInput = z.infer<typeof imageTaskInput>;
export type ImageTaskStatus = 'queued' | 'processing' | 'succeeded' | 'failed' | 'unknown';
export type ImageResult = { file_id: string; mime_type: string; expires_at: string };
export const imageMetric = (resolution: ImageTaskInput['resolution']) => ({ '1K': 'output_images_1k', '2K': 'output_images_2k', '4K': 'output_images_4k' })[resolution] as 'output_images_1k' | 'output_images_2k' | 'output_images_4k';

export function validateKieRoute(route: { protocol: string; provider: string; baseUrl: string; upstreamModel: string; retries?: number }, input?: ImageTaskInput): void {
  if (route.protocol !== 'kie-images' || route.provider !== 'kie' || route.baseUrl.replace(/\/$/, '') !== kieBaseUrl || !kieImageModels.includes(route.upstreamModel as typeof kieImageModels[number]) || (route.retries !== undefined && route.retries !== 0)) {
    throw new HttpError(400, 'INVALID_KIE_ROUTE', 'Kie 图像路由须使用官方接口、受支持模型且关闭自动重试。');
  }
  if (input && (route.upstreamModel.endsWith('-image-to-image') ? input.input_images.length === 0 : input.input_images.length !== 0)) {
    throw new HttpError(400, 'IMAGE_MODE_MISMATCH', '文生图不接受参考图，图生图需要至少一张参考图。');
  }
}
export function kieBody(model: string, input: ImageTaskInput, urls: string[]) {
  return { model, input: { prompt: input.prompt, aspect_ratio: input.aspect_ratio, resolution: input.resolution,
    ...(input.resolution === '1K' ? { background: input.background } : {}), ...(urls.length ? { input_urls: urls } : {}) } };
}
export function imageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  const data = Buffer.from(bytes);
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
export async function boundedImageBytes(response: Response, maximum: number): Promise<Buffer> {
  const reader = response.body?.getReader(); if (!reader) throw new Error('IMAGE_BODY_MISSING');
  const chunks: Uint8Array[] = []; let count = 0;
  try { while (true) { const value = await reader.read(); if (value.done) break; count += value.value.length; if (count > maximum) { await reader.cancel(); throw new Error('IMAGE_BODY_TOO_LARGE'); } chunks.push(value.value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export type KieTransport = (url: string, init: RequestInit, hosts?: readonly string[]) => Promise<Response>;
export const kieTransport: KieTransport = (url, init, hosts) => requestPublicHttps(url, init, { allowedHosts: hosts, allowQuery: true });
export function createKieClient(secret: string, transport: KieTransport = kieTransport) {
  const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
  async function json(response: Response) { return record(JSON.parse((await boundedImageBytes(response, 2 * 1024 * 1024)).toString('utf8'))); }
  return {
    async upload(data: Uint8Array, mime: string, path: string, signal: AbortSignal): Promise<string> {
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mime];
      if (!extension || data.length > 30 * 1024 * 1024 || imageType(data) !== mime) throw new HttpError(400, 'INVALID_IMAGE', '参考图须为不超过 30 MB 的 PNG、JPEG 或 WebP。');
      const boundary = `ccagent-${randomUUID()}`, fileName = `${randomUUID()}.${extension}`;
      const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="uploadPath"\r\n\r\n${path}\r\n--${boundary}\r\nContent-Disposition: form-data; name="fileName"\r\n\r\n${fileName}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`), Buffer.from(data), Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const response = await transport('https://kieai.redpandaai.co/api/file-stream-upload', { method: 'POST', headers: { authorization: headers.authorization, 'content-type': `multipart/form-data; boundary=${boundary}` }, body, signal, redirect: 'error' }, ['kieai.redpandaai.co']);
      const payload = await json(response), url = record(payload.data).downloadUrl;
      if (!response.ok || payload.code !== 200 || typeof url !== 'string') throw new Error('IMAGE_UPLOAD_FAILED');
      // Upload output is used by Kie, never fetched by this server. Reject non-public URL syntax and credentials.
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.port || !/^[a-z0-9.-]+$/i.test(parsed.hostname)) throw new Error('IMAGE_UPLOAD_URL_INVALID');
      normalizeUpstreamHost(parsed.hostname); await publicUpstreamAddresses(parsed.hostname);
      return parsed.href;
    },
    async create(model: string, input: ImageTaskInput, urls: string[], signal: AbortSignal) {
      const response = await transport(`${kieBaseUrl}/jobs/createTask`, { method: 'POST', headers, body: JSON.stringify(kieBody(model, input, urls)), signal, redirect: 'error' }, ['api.kie.ai']);
      const payload = await json(response), taskId = record(payload.data).taskId;
      if (!response.ok || payload.code !== 200) {
        const rejected = [400, 401, 402, 403, 404, 422, 429].includes(response.status) || [400, 401, 402, 403, 404, 422, 429].includes(Number(payload.code));
        return { rejected, taskId: null };
      }
      return { rejected: false, taskId: typeof taskId === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(taskId) ? taskId : null };
    },
    async query(taskId: string, signal: AbortSignal, expected?: { model: string; resolution: string }) {
      const response = await transport(`${kieBaseUrl}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, { headers, signal, redirect: 'error' }, ['api.kie.ai']);
      const payload = await json(response), data = record(payload.data);
      if (!response.ok || payload.code !== 200 || data.taskId !== taskId) throw new Error('IMAGE_QUERY_UNCONFIRMED');
      if (expected) {
        if (data.model !== expected.model) throw new Error('IMAGE_MODEL_UNCONFIRMED');
        if (data.param !== undefined && data.param !== null) {
          const param = record(typeof data.param === 'string' ? JSON.parse(data.param) : data.param);
          const input = record(typeof param.input === 'string' ? JSON.parse(param.input) : param.input);
          if (param.model !== undefined && param.model !== expected.model || input.resolution !== undefined && input.resolution !== expected.resolution) throw new Error('IMAGE_PARAMETERS_UNCONFIRMED');
        }
      }
      if (data.state === 'fail') return { state: 'fail' as const, urls: [] as string[], credits: undefined };
      if (data.state !== 'success') {
        if (!['waiting', 'queuing', 'generating'].includes(String(data.state))) throw new Error('IMAGE_STATE_UNCONFIRMED');
        return { state: data.state as 'waiting' | 'queuing' | 'generating', urls: [] as string[], credits: undefined };
      }
      const result = typeof data.resultJson === 'string' ? record(JSON.parse(data.resultJson)) : {};
      const urls = z.array(z.string().url().max(4096)).min(1).max(1).parse(result.resultUrls);
      const credits = typeof data.creditsConsumed === 'number' && Number.isFinite(data.creditsConsumed) && data.creditsConsumed >= 0 ? data.creditsConsumed : undefined;
      return { state: 'success' as const, urls, credits };
    },
    async download(url: string, signal: AbortSignal) {
      // No Authorization header is ever sent to a supplier-provided result host.
      const response = await transport(url, { method: 'GET', signal, redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); throw new Error('IMAGE_DOWNLOAD_FAILED'); }
      const data = await boundedImageBytes(response, 64 * 1024 * 1024), mime = imageType(data);
      if (!mime || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== mime) throw new Error('IMAGE_DOWNLOAD_TYPE_INVALID');
      return { data, mime };
    },
  };
}
