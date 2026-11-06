import './load-env';
import path from 'node:path';
import { loadEnv } from '../../src/utils/loadEnv';
import { loadProfiles } from '../../src/services/api/providers/profile';
import { voiceDownloadUrl } from '../src/core/upstream';

// Opt-in synthetic live probes. No project files, conversation, or real user content is sent.
if (!process.argv.includes('--run')) {
  console.log('Use --run to make at most one short synthetic request per configured supplier/model.');
  process.exit(0);
}
const root = path.resolve('..');
process.chdir(root);
await loadEnv();
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
const loaded = await loadProfiles(root);
const only = process.argv.find(value => value.startsWith('--only='))?.slice(7).split(',');
function safeUsage(value: unknown, depth = 0): unknown {
  if (depth > 4 || !value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([name, item]) => /^[a-zA-Z0-9_]{1,60}$/.test(name)
    ? typeof item === 'number' && Number.isFinite(item) ? [[name, item]] : item && typeof item === 'object' ? [[name, safeUsage(item, depth + 1)]] : [] : []));
}
async function probe(name: string, url: string, key: string | undefined, body: unknown, downloadAudio = false) {
  if (only && !only.includes(name)) return;
  if (!key) { console.log(JSON.stringify({ name, skipped: 'credential_not_configured' })); return; }
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.search || !['api.deepseek.com', 'openrouter.ai', 'api.tavily.com', 'api.bochaai.com', 'dashscope.aliyuncs.com', 'llm-htz8qllbi0nz48bo.cn-beijing.maas.aliyuncs.com'].includes(target.hostname)) throw new Error('PROBE_HOST_NOT_ALLOWED');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000), started = Date.now();
  let status: number | undefined, stage = 'request';
  try {
    const response = await fetch(target, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
    status = response.status;
    stage = 'parse_json';
    const payload = await response.json() as Record<string, unknown>;
    const error = payload.error as { code?: unknown; type?: unknown } | undefined;
    const safeError = (value: unknown) => typeof value === 'string' && value !== key && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(value) ? value : undefined;
    const output = payload.output as { audio?: { url?: string } } | undefined;
    let audio: { bytes: number; waveHeader: boolean } | undefined;
    if (response.ok && downloadAudio && output?.audio?.url) {
      const originalAudio = new URL(output.audio.url), audioUrl = voiceDownloadUrl(output.audio.url);
      console.log(JSON.stringify({ name, supplierAudioProtocol: originalAudio.protocol, downloadProtocol: audioUrl.protocol, audioHost: audioUrl.hostname, usage: safeUsage(payload.usage) }));
      stage = 'audio_host';
      stage = 'audio_download';
      const file = await fetch(audioUrl, { signal: controller.signal, redirect: 'error' });
      const reader = file.body?.getReader(); if (!file.ok || !reader) throw new Error('PROBE_AUDIO_UNAVAILABLE');
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 5 * 1024 * 1024) { await reader.cancel(); throw new Error('PROBE_AUDIO_TOO_LARGE'); } chunks.push(item.value); }
      const bytes = Buffer.concat(chunks); audio = { bytes: size, waveHeader: bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE' };
    }
    console.log(JSON.stringify({ name, status: response.status, ok: response.ok && !payload.error && (!payload.code || String(payload.code) === '200'), elapsedMs: Date.now() - started,
      usage: safeUsage(payload.usage), responseFields: Object.keys(payload).filter(name => /^[a-zA-Z0-9_]{1,60}$/.test(name)), ...(audio ? { audio } : {}) }));
    if (!response.ok) console.log(JSON.stringify({ name, providerError: safeError(error?.code ?? payload.code), providerErrorType: safeError(error?.type) }));
  } catch { console.log(JSON.stringify({ name, status, stage, ok: false, transportOrProtocolError: true, elapsedMs: Date.now() - started })); }
  finally { clearTimeout(timer); }
}
for (const name of ['deepseek', 'qwen-omni', 'qwen-plus']) {
  const profile = loaded.profiles[name];
  if (!profile?.baseURL) { console.log(JSON.stringify({ name, skipped: 'profile_not_configured' })); continue; }
  const responseProtocol = profile.protocol === 'openai-responses';
  const base = profile.baseURL.replace(/\/+$/, '');
  await probe(name, `${base}/${responseProtocol ? 'responses' : 'chat/completions'}`, profile.apiKey,
    responseProtocol ? { model: profile.model, input: 'Reply only OK. Synthetic connectivity test.', reasoning: { effort: 'none' }, max_output_tokens: 8, store: false }
      : { model: profile.model, messages: [{ role: 'user', content: 'Reply only OK. Synthetic connectivity test.' }], enable_thinking: false, max_tokens: 8 });
}
await probe('jev', process.env.OPENROUTER_JEV_ENDPOINT || 'https://openrouter.ai/api/alpha/decisions', process.env.OPENROUTER_API_KEY,
  { model: process.env.OPENROUTER_JEV_MODEL || '~typesafe/jev-latest', state: 'Synthetic connectivity test. No user data.', questions: { pick: { type: 'choice', instructions: 'Choose keep.', criteria: { keep: 'Keep', skip: 'Skip' } } } });
await probe('tavily', 'https://api.tavily.com/search', process.env.TAVILY_API_KEY || process.env.WEB_SEARCH_API_KEY,
  { query: 'Vercel documentation', search_depth: 'basic', max_results: 1, include_answer: false, include_raw_content: false, include_images: false, include_usage: true });
await probe('bocha', 'https://api.bochaai.com/v1/web-search', process.env.bocha_API_KEY || process.env.BOCHA_API_KEY,
  { query: 'Vercel documentation', count: 1, summary: false });
const ttsBase = process.env.DASHSCOPE_BASE_URL || process.env.QWEN_BASE_URL;
await probe('qwen-voice', process.env.DASHSCOPE_TTS_URL || `${ttsBase ? new URL(ttsBase).origin : 'https://dashscope.aliyuncs.com'}/api/v1/services/audio/tts/SpeechSynthesizer`,
  process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY, { model: process.env.QWEN_TTS_MODEL || 'qwen-audio-3.1-tts-flash',
    input: { text: '测试完成。', voice: process.env.QWEN_TTS_VOICE || 'longanhuan_v3.1', format: 'wav', sample_rate: 24000, language_hints: ['zh'], enable_aigc_tag: true } }, true);
