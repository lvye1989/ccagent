/** Ollama local-server preset. Discovery never pulls, runs, or changes a model. */
import { validateServiceUrl } from "./rag.js";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 200;

export interface OllamaModel {
  name: string;
  size?: number;
  family?: string;
  parameterSize?: string;
  quantizationLevel?: string;
  modifiedAt?: string;
}
export interface OllamaModels { baseURL: string; models: OllamaModel[]; truncated: boolean }

/** Accept the server root, compatibility base or a known native endpoint. Keep proxy prefixes. */
export function normalizeOllamaBaseURL(value: unknown = DEFAULT_OLLAMA_URL): string {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(value.trim())) {
    throw new Error("请输入有效的 Ollama HTTP(S) 服务地址。");
  }
  const input = value.trim() || DEFAULT_OLLAMA_URL;
  let url: URL;
  try {
    url = new URL(validateServiceUrl(input));
    if (url.search || url.hash || url.username || url.password || /%2f|%5c|%00/i.test(url.pathname)) throw new Error();
  } catch { throw new Error("Ollama 地址须为 HTTP(S)，不能包含账户、密码、查询参数或片段。"); }
  let prefix = url.pathname.replace(/\/+$/, "");
  prefix = prefix.replace(/\/(?:v1(?:\/chat\/completions|\/models)?|api(?:\/(?:tags|chat|generate))?)$/i, "");
  url.pathname = prefix + "/v1";
  return url.toString().replace(/\/$/, "");
}

function cleanText(value: unknown, max = 200): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : undefined;
}

export async function discoverOllamaModels(
  value: unknown,
  dependencies: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<OllamaModels> {
  const baseURL = normalizeOllamaBaseURL(value === undefined ? DEFAULT_OLLAMA_URL : value);
  const tagsURL = baseURL.slice(0, -3) + "/api/tags";
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(dependencies.timeoutMs ?? 8000, 8000)));
  let response: Response;
  try {
    response = await (dependencies.fetch ?? fetch)(tagsURL, {
      method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: timeout,
    });
  } catch { throw new Error("无法连接 Ollama。请确认本机服务已启动，并检查服务地址和网络连接。"); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Ollama 服务返回 HTTP ${response.status}。请检查服务地址和访问设置。`);
  }
  let raw: unknown;
  try {
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw new Error(); }
    const chunks: Uint8Array[] = []; let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES || timeout.aborted) throw new Error();
      chunks.push(chunk);
    }
    if (timeout.aborted) throw new Error();
    raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { throw new Error("Ollama 模型列表无效、过大或读取超时，请检查服务地址后重试。"); }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { models?: unknown }).models)) {
    throw new Error("此地址没有返回 Ollama 模型列表，请填写 Ollama 服务地址。");
  }
  const entries = (raw as { models: unknown[] }).models;
  const models: OllamaModel[] = [], seen = new Set<string>();
  let truncated = false;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>, name = cleanText(row.name ?? row.model);
    if (!name || seen.has(name)) continue;
    if (models.length >= MAX_MODELS) { truncated = true; break; }
    seen.add(name);
    const details = row.details && typeof row.details === "object" && !Array.isArray(row.details) ? row.details as Record<string, unknown> : {};
    const family = cleanText(details.family), parameterSize = cleanText(details.parameter_size), quantizationLevel = cleanText(details.quantization_level), modifiedAt = cleanText(row.modified_at);
    models.push({ name, ...(Number.isSafeInteger(row.size) && Number(row.size) >= 0 ? { size: Number(row.size) } : {}),
      ...(family ? { family } : {}), ...(parameterSize ? { parameterSize } : {}), ...(quantizationLevel ? { quantizationLevel } : {}), ...(modifiedAt ? { modifiedAt } : {}) });
  }
  return { baseURL, models, truncated };
}
