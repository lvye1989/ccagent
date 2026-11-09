import { z } from 'zod';
import { type UsageMetric, routeInput } from './catalog';
import { HttpError } from './http';

export type GatewayEndpoint = 'chat' | 'responses' | 'decisions' | 'search' | 'voice';
export type Quantities = Partial<Record<UsageMetric, bigint>>;
export const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): bigint | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
const copy = (input: Record<string, unknown>, names: readonly string[]) => Object.fromEntries(names.filter(name => input[name] !== undefined).map(name => [name, input[name]]));

export function voiceDownloadUrl(value: unknown): URL {
  const url = new URL(z.string().url().max(4096).parse(value));
  if (!['https:', 'http:'].includes(url.protocol) || !/^[a-z0-9.-]+\.oss(?:-[a-z0-9-]+)?\.aliyuncs\.com$/i.test(url.hostname) || url.username || url.password || url.port || url.hash) throw new Error('INVALID_AUDIO_DOWNLOAD_HOST');
  // DashScope may return an HTTP OSS URL. Upgrade before sending any request or signed query.
  url.protocol = 'https:';
  return url;
}

export function prepareUpstream(endpoint: GatewayEndpoint, input: Record<string, unknown>, route: z.infer<typeof routeInput>) {
  const common = ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'seed', 'stop', 'tools', 'tool_choice', 'parallel_tool_calls'];
  let path: string, body: Record<string, unknown>;
  const outputLimit = z.number().int().min(1).max(route.options.maxOutputTokens);
  if (endpoint === 'chat' || endpoint === 'responses') {
    if (route.protocol !== (endpoint === 'chat' ? 'openai-chat' : 'openai-responses') || !['chat', 'vision'].includes(route.service)) throw new HttpError(400, 'PROTOCOL_MISMATCH', '请使用该模型对应的调用协议。');
    const tools = input.tools === undefined ? [] : z.array(z.record(z.string(), z.unknown())).max(200).parse(input.tools);
    // Supplier-side paid tools and provider-managed conversation IDs are not part of this price.
    if (tools.some(tool => tool.type !== 'function' && !(endpoint === 'responses' && tool.type === 'custom' && tool.name === 'apply_patch')) || input.previous_response_id || input.conversation || input.background || input.modalities) throw new HttpError(400, 'UNPRICED_CAPABILITY', '此路由暂未开放该计费能力，请使用本地工具或无状态文本输出。');
    const stream = input.stream === undefined ? false : z.boolean().parse(input.stream);
    if (endpoint === 'chat') {
      z.array(z.record(z.string(), z.unknown())).min(1).max(2000).parse(input.messages);
      if (input.n !== undefined && input.n !== 1) throw new HttpError(400, 'SINGLE_OUTPUT_REQUIRED', '每次调用只支持一份输出。');
      const maxTokens = outputLimit.parse(input.max_completion_tokens ?? input.max_tokens ?? route.options.maxOutputTokens);
      // DeepSeek enables thinking by default on some models. Keep an explicit
      // caller choice intact so tool-result continuations use the same mode.
      const thinking = route.provider === 'deepseek' && input.thinking !== undefined
        ? z.object({ type: z.enum(['enabled', 'disabled']) }).strict().parse(input.thinking) : undefined;
      path = 'chat/completions';
      body = { ...copy(input, [...common, 'messages', 'response_format', 'reasoning_effort', 'enable_thinking', 'thinking_budget']),
        ...(thinking ? { thinking } : {}),
        model: route.upstreamModel, stream, n: 1, max_tokens: maxTokens, ...(stream ? { stream_options: { include_usage: true } } : {}) };
    } else {
      if (typeof input.input !== 'string') z.array(z.unknown()).min(1).max(2000).parse(input.input);
      path = 'responses';
      body = { ...copy(input, [...common, 'input', 'instructions', 'reasoning', 'text', 'truncation', 'prompt_cache_key', 'prompt_cache_retention']),
        model: route.upstreamModel, stream, store: false, max_output_tokens: outputLimit.parse(input.max_output_tokens ?? route.options.maxOutputTokens) };
    }
  } else if (endpoint === 'decisions') {
    if (route.protocol !== 'jev-decisions' || route.service !== 'decision') throw new HttpError(400, 'PROTOCOL_MISMATCH', '该路由不支持 Decisions。');
    const instructions = z.string().min(1).max(20000);
    const criteria = z.record(z.string().min(1).max(100), instructions).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 100);
    const question = z.discriminatedUnion('type', [z.object({ type: z.literal('choice'), instructions, criteria }).strict(),
      z.object({ type: z.literal('score'), instructions, criteria: z.array(instructions).min(1).max(100) }).strict(),
      z.object({ type: z.literal('noul'), instructions, criteria: z.object({ true: instructions, false: instructions }).strict().optional() }).strict()]);
    const questions = z.record(z.string().min(1).max(100), question).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 100).parse(input.questions);
    if (input.state === undefined || input.state === null) throw new HttpError(400, 'STATE_REQUIRED', '请提供决策状态。');
    path = '';
    body = { model: route.upstreamModel, state: input.state, questions };
  } else if (endpoint === 'search') {
    if (route.service !== 'search' || !['tavily', 'bocha'].includes(route.protocol)) throw new HttpError(400, 'PROTOCOL_MISMATCH', '该路由不支持搜索。');
    const query = z.string().trim().min(1).max(2000).parse(input.query);
    const maxResults = z.number().int().min(1).max(20).parse(input.max_results ?? 5);
    const domains = (value: unknown) => value === undefined ? undefined : z.array(z.string().regex(/^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/)).max(100).parse(value);
    const include = domains(input.include_domains), exclude = domains(input.exclude_domains);
    path = '';
    body = route.protocol === 'tavily' ? { query, max_results: maxResults, search_depth: z.enum(['basic', 'advanced']).parse(input.search_depth ?? 'basic'),
      topic: z.enum(['general', 'news', 'finance']).parse(input.topic ?? 'general'), include_answer: false, include_raw_content: false, include_images: false,
      include_usage: true, safe_search: true, ...(include ? { include_domains: include } : {}), ...(exclude ? { exclude_domains: exclude } : {}),
      ...(input.time_range ? { time_range: z.enum(['day', 'week', 'month', 'year']).parse(input.time_range) } : {}) }
      : { query, count: maxResults, summary: true, freshness: z.enum(['noLimit', 'oneDay', 'oneWeek', 'oneMonth', 'oneYear']).parse(input.freshness ?? 'noLimit'),
        ...(include ? { include: include.join('|') } : {}), ...(exclude ? { exclude: exclude.join('|') } : {}) };
  } else {
    if (route.service !== 'voice' || route.protocol !== 'dashscope-tts') throw new HttpError(400, 'PROTOCOL_MISMATCH', '该路由不支持语音合成。');
    const text = z.string().trim().min(1).max(10000).parse(input.text);
    const voice = z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/).parse(input.voice ?? 'longanhuan_v3.1');
    path = '';
    body = { model: route.upstreamModel, input: { text, voice, format: 'wav', sample_rate: 24000, language_hints: ['zh'], enable_aigc_tag: true } };
  }
  const base = new URL(route.baseUrl.endsWith('/') ? route.baseUrl : `${route.baseUrl}/`);
  return { url: path ? new URL(path, base).toString() : route.baseUrl, body, streaming: body.stream === true };
}

/** No guessed token counts: absent or inconsistent supplier statistics remain unmeasured. */
export function measuredUsage(protocol: string, payload: unknown, pricedMetrics: readonly UsageMetric[]): Quantities | null {
  const root = object(payload), usage = object(root.usage);
  const values: Quantities = {};
  if (protocol === 'bocha') {
    if ((root.code !== undefined && String(root.code) !== '200') || !Array.isArray(object(object(root.data).webPages ?? root.webPages).value)) return null;
    values.requests = 1n;
  } else if (protocol === 'tavily') {
    if (!Array.isArray(root.results)) return null;
    values.search_credits = count(usage.credits); values.requests = 1n;
  } else {
    const chat = protocol === 'openai-chat', details = object(chat ? usage.prompt_tokens_details : usage.input_tokens_details);
    const input = count(chat ? usage.prompt_tokens : usage.input_tokens), output = count(chat ? usage.completion_tokens : usage.output_tokens);
    const cached = count(usage.prompt_cache_hit_tokens ?? details.cached_tokens);
    if (input !== undefined) {
      if (pricedMetrics.includes('cached_input_tokens')) {
        if (cached === undefined || cached > input) return null;
        values.cached_input_tokens = cached; values.input_tokens = input - cached;
      } else {
        if (cached !== undefined && cached > 0n) return null;
        values.input_tokens = input;
      }
    }
    if (output !== undefined) values.output_tokens = output;
    if (count(usage.characters) !== undefined) values.input_characters = count(usage.characters);
    values.requests = 1n;
    // Unpriced provider-side tools may consume money beyond the published token price.
    if (Object.values(object(usage.server_tool_use)).some(value => typeof value === 'number' && value > 0)) return null;
  }
  return pricedMetrics.every(name => values[name] !== undefined) ? Object.fromEntries(pricedMetrics.map(name => [name, values[name]])) : null;
}

/** Incremental SSE framing handles UTF-8 splits and multiline data without changing tool/reasoning payloads. */
export class UsageStream {
  private decoder = new TextDecoder();
  private pending = '';
  usage: unknown;
  terminal = false;
  failed = false;
  push(chunk: Uint8Array, final = false): void {
    this.pending += this.decoder.decode(chunk, { stream: !final });
    this.pending = this.pending.replace(/\r\n/g, '\n');
    if (this.pending.length > 2 * 1024 * 1024) throw new Error('UPSTREAM_EVENT_TOO_LARGE');
    let boundary: number;
    while ((boundary = this.pending.indexOf('\n\n')) >= 0) {
      const event = this.pending.slice(0, boundary); this.pending = this.pending.slice(boundary + 2);
      const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data === '[DONE]') { this.terminal = true; continue; }
      if (!data) continue;
      let value: Record<string, unknown>;
      try { value = object(JSON.parse(data)); } catch { this.failed = true; continue; }
      if (value.error || value.type === 'error' || value.type === 'response.failed') this.failed = true;
      if (value.usage) this.usage = value;
      if (['response.completed', 'response.incomplete'].includes(String(value.type))) { this.terminal = true; this.usage = value.response; }
    }
    if (final && this.pending.trim()) this.failed = true;
  }
}
