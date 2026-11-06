import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeInput } from '../src/core/catalog';
import { measuredUsage, prepareUpstream, UsageStream, voiceDownloadUrl } from '../src/core/upstream';

const route = routeInput.parse({ id: 'unit-fixture', name: 'unit fixture', provider: 'fixture', service: 'chat', protocol: 'openai-chat',
  baseUrl: 'https://api.deepseek.com/v1', upstreamModel: 'fixture', credentialEnv: 'CCAGENT_PROVIDER_UNIT_FIXTURE', options: { maxOutputTokens: 64 } });
test('native chat preserves tools and images, adds usage and rejects excess output or unpriced paid tools', () => {
  const input = { model: 'unit-fixture', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,synthetic' } }] }], tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }], stream: true, max_tokens: 32 };
  const result = prepareUpstream('chat', input, route);
  assert.equal(result.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.deepEqual(result.body.tools, input.tools); assert.deepEqual(result.body.messages, input.messages);
  assert.deepEqual(result.body.stream_options, { include_usage: true });
  assert.throws(() => prepareUpstream('chat', { ...input, max_tokens: 65 }, route));
  assert.throws(() => prepareUpstream('chat', { ...input, tools: [{ type: 'web_search_20250305' }] }, route));
});
test('Decisions remains typed, search cannot enable paid extras, and voice uses its native request', () => {
  const decisions = { ...route, service: 'decision' as const, protocol: 'jev-decisions' as const, baseUrl: 'https://openrouter.ai/api/alpha/decisions' };
  const result = prepareUpstream('decisions', { state: 'synthetic', questions: { pick: { type: 'choice', instructions: 'pick', criteria: { a: 'A' } } } }, decisions);
  assert.equal(result.url, decisions.baseUrl); assert.ok(result.body.questions);
  assert.throws(() => prepareUpstream('decisions', { state: 'synthetic', questions: { pick: { type: 'chat' } } }, decisions));
  const search = prepareUpstream('search', { query: 'synthetic', search_depth: 'advanced', include_answer: true, auto_parameters: true }, { ...route, service: 'search', protocol: 'tavily', baseUrl: 'https://api.tavily.com/search' });
  assert.equal(search.body.include_answer, false); assert.equal(search.body.auto_parameters, undefined); assert.equal(search.body.include_usage, true);
  const voice = prepareUpstream('voice', { text: 'Synthetic.' }, { ...route, service: 'voice', protocol: 'dashscope-tts', baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer' });
  assert.equal((voice.body.input as Record<string, unknown>).format, 'wav');
});
test('usage requires supplier evidence and does not silently treat absent cached tokens as zero', () => {
  assert.deepEqual(measuredUsage('openai-chat', { usage: { prompt_tokens: 12, prompt_cache_hit_tokens: 5, completion_tokens: 2 } }, ['input_tokens', 'cached_input_tokens', 'output_tokens']), { input_tokens: 7n, cached_input_tokens: 5n, output_tokens: 2n });
  assert.equal(measuredUsage('openai-chat', { usage: { prompt_tokens: 12, completion_tokens: 2 } }, ['input_tokens', 'cached_input_tokens', 'output_tokens']), null);
  assert.equal(measuredUsage('openai-responses', { usage: { input_tokens: -1, output_tokens: 2 } }, ['input_tokens', 'output_tokens']), null);
  assert.deepEqual(measuredUsage('tavily', { results: [], usage: { credits: 2 } }, ['search_credits']), { search_credits: 2n });
  assert.deepEqual(measuredUsage('bocha', { code: 200, data: { webPages: { value: [] } } }, ['requests']), { requests: 1n });
});
test('SSE usage parser handles CRLF split across chunks and identifies incomplete transport', () => {
  const stream = new UsageStream();
  const content = 'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":2}}\r\n\r\ndata: [DONE]\r\n\r\n';
  for (const byte of Buffer.from(content)) stream.push(new Uint8Array([byte]));
  stream.push(new Uint8Array(), true); assert.equal(stream.terminal, true); assert.equal(stream.failed, false);
  const partial = new UsageStream(); partial.push(Buffer.from('data: {"broken":'), true); assert.equal(partial.failed, true);
});
test('Qwen temporary OSS audio downloads always use HTTPS and reject arbitrary network targets', () => {
  const url = voiceDownloadUrl('http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/synthetic.wav?Signature=synthetic');
  assert.equal(url.protocol, 'https:'); assert.equal(url.searchParams.get('Signature'), 'synthetic');
  for (const value of ['http://169.254.169.254/data', 'https://aliyuncs.com.attacker.invalid/file', 'https://api.deepseek.com/file', 'https://user:pass@bucket.oss-cn-beijing.aliyuncs.com/file', 'https://bucket.oss-cn-beijing.aliyuncs.com:8443/file']) assert.throws(() => voiceDownloadUrl(value));
});
