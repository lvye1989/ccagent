/** Small, display-only summaries. Never serialize full tool input or image data. */
export function sanitizeToolProgress(value: string): string {
  return value
    .replace(/-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----/g, "[密钥已隐藏]")
    .replace(/\bBearer\s+[^\s'";,]+/gi, "Bearer [已隐藏]")
    .replace(/\b(?:sk-|sk_|sess-)[a-z\d_-]{12,}/gi, "[密钥已隐藏]")
    .replace(/((?:api[-_]?key|access[-_]?token|authorization|password|secret|credential)\s*['"]?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;,]+)/gi, "$1[已隐藏]")
    .replace(/(--?(?:api[-_]?key|token|password|secret)\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;]+)/gi, "$1[已隐藏]")
    .replace(/data:[^\s]+/gi, "[图片数据]")
    .replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

export function toolProgressSummary(name: string, input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const args = input as Record<string, unknown>;
  const keys = /Bash|PowerShell|Terminal/.test(name) ? ["command", "script", "description"]
    : name === "GenerateImage" ? ["prompt", "request_id"]
    : /Read|Write|Edit/.test(name) ? ["file_path", "path", "notebook_path"]
    : /Grep|Glob|Search/.test(name) ? ["pattern", "query"]
    : /Fetch|Browser/.test(name) ? ["url", "action"]
    : /Rhino/.test(name) ? ["action", "operation", "description"] : ["description"];
  const value = keys.map(key => args[key]).find(value => typeof value === "string" && value.trim());
  return typeof value === "string" ? sanitizeToolProgress(value) : "";
}
