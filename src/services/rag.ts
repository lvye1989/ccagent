import { readJsonSettingsFile } from "../utils/settings.js";
import { getUserSettingsPath } from "../utils/paths.js";
import { resolveWebSecret } from "../utils/webSecrets.js";

export interface RagConnection {
  id: string; name: string; url: string; enabled: boolean; topK: number; collection?: string; apiKey?: string;
}
export interface RagDocument { text: string; title?: string; source?: string; score?: number }

export async function loadRagConnections(): Promise<RagConnection[]> {
  const { raw, parseError } = await readJsonSettingsFile<Record<string, unknown>>(getUserSettingsPath());
  if (parseError) throw new Error("Cannot read RAG settings.");
  return Array.isArray(raw?.ragConnections) ? raw.ragConnections.filter((item): item is RagConnection => Boolean(item && typeof item === "object" && typeof item.id === "string" && typeof item.url === "string")) : [];
}

export function validateServiceUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("Enter an HTTP(S) URL without embedded credentials or fragments.");
  return url.toString();
}

/** Generic retrieval port: POST {query, topK, collection?}, return {results:[{text,source,score}]}. */
export async function searchRag(connection: RagConnection, query: string, signal?: AbortSignal): Promise<RagDocument[]> {
  if (!connection.enabled) throw new Error("This knowledge connection is disabled.");
  if (!query.trim() || query.length > 8000) throw new Error("Enter a retrieval query up to 8000 characters.");
  const key = resolveWebSecret(connection.apiKey);
  const response = await fetch(validateServiceUrl(connection.url), {
    method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ query: query.trim(), topK: connection.topK, ...(connection.collection ? { collection: connection.collection } : {}) }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Knowledge endpoint returned HTTP ${response.status}.`); }
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("Knowledge response exceeds 2 MB.");
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const rows = Array.isArray(body) ? body : body.results ?? body.documents ?? body.records ?? body.data;
  if (!Array.isArray(rows)) throw new Error("Expected {results:[{text, source?, score?}]} from the knowledge endpoint.");
  return rows.slice(0, connection.topK).map((row: Record<string, unknown>) => ({
    text: String(row.text ?? row.content ?? (row.segment as { content?: string })?.content ?? "").slice(0, 16000),
    ...(typeof row.title === "string" ? { title: row.title } : {}),
    ...(typeof row.source === "string" ? { source: row.source } : {}),
    ...(typeof row.score === "number" ? { score: row.score } : {}),
  })).filter((row: RagDocument) => row.text);
}
