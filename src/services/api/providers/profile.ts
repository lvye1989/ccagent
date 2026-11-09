/**
 * Model profiles — resolves a user-facing "model handle" into a concrete
 * provider target (protocol + model + endpoint + credentials).
 *
 * A profile is declared in settings.json under `models`:
 *
 *   {
 *     "models": {
 *       "gpt5":   { "protocol": "openai-chat", "model": "gpt-5.1",
 *                   "baseURL": "https://api.openai.com/v1", "apiKey": "${OPENAI_API_KEY}" },
 *       "gemini": { "protocol": "gemini", "model": "gemini-2.5-pro",
 *                   "apiKey": "${GEMINI_API_KEY}" }
 *     },
 *     "defaultModel": "gpt5"
 *   }
 *
 * The profile *id* (the map key) is the handle the rest of the system passes
 * around — `--model gpt5`, `/model gpt5`, etc. When a handle does not match any
 * declared profile it is treated as a raw Anthropic model name (backwards
 * compatible: `--model claude-sonnet-4-...` still works with no `models` block).
 *
 * Translation to OpenAI / Gemini happens entirely at the edge (see
 * providerStream.ts via the zero-dependency `llm-bridge` library). The upper
 * stack never learns a profile is non-Anthropic — it keeps speaking the
 * normalized StreamEvent contract.
 *
 * Security: project/local profiles are ignored until the project is trusted.
 * Even after trust, an inline literal key declared in a
 * project/local settings file (which a hostile repo could commit) is IGNORED;
 * only `${ENV}` interpolation, or a key from a trusted scope (user/policy), is
 * honored. This mirrors how `mode: auto` is gated in the settings layer.
 */

import {
  loadTrustedSettingSources,
  isTrustedScopeForSensitiveKeys,
} from "../../../config/sources.js";
import { officialModelPrefix, readServiceBinding } from "../../../platform/serviceState.js";
import { getPlatformAccountClient } from "../../../platform/account.js";
import { normalizeOllamaBaseURL } from "../../ollama.js";

export type ModelProtocol =
  | "anthropic"
  | "openai-chat"
  | "openai-responses"
  | "gemini";

export interface ModelProfile {
  /** Supplier identity from the authenticated official catalog; not project metadata. */
  upstreamProvider?: string;
  /** Dedicated local Ollama preset, transported through the shared OpenAI adapter. */
  provider?: "ollama";
  /** Only synthesized from the authenticated account's official catalog. Never read from project settings. */
  platformService?: string;
  /** The map key / user-facing handle. */
  id: string;
  protocol: ModelProtocol;
  /** The model name sent to the upstream provider. */
  model: string;
  /** Override the provider base URL (else a protocol default is used). */
  baseURL?: string;
  /** Resolved API key (after `${ENV}` interpolation). */
  apiKey?: string;
  /** Per-profile max output tokens override. */
  maxTokens?: number;
  /** Provider context-window size used by warnings and auto-compaction. */
  contextWindow?: number;
  /** Extra HTTP headers merged into the upstream request. */
  headers?: Record<string, string>;
}

interface RawProfile {
  provider?: unknown;
  disabled?: unknown;
  protocol?: unknown;
  model?: unknown;
  baseURL?: unknown;
  apiKey?: unknown;
  maxTokens?: unknown;
  contextWindow?: unknown;
  headers?: unknown;
}

const VALID_PROTOCOLS: ReadonlySet<string> = new Set<ModelProtocol>([
  "anthropic",
  "openai-chat",
  "openai-responses",
  "gemini",
]);

/**
 * Expand environment references used by model profiles.
 *
 * - `${VAR}` resolves to the variable value, or an empty string when unset.
 * - `${VAR:-fallback}` resolves to the fallback when the variable is unset or
 *   empty. This mirrors dotenv/shell-style defaults and is useful for the
 *   non-secret protocol, model, and endpoint fields in a user-wide profile.
 */
function interpolateEnv(value: string): string {
  return value.replace(
    /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/gi,
    (_, name: string, fallback: string | undefined) => {
      const envValue = process.env[name];
      return envValue !== undefined && envValue !== "" ? envValue : (fallback ?? "");
    },
  );
}

/** True when the string references at least one `${ENV}` placeholder. */
function usesEnvInterpolation(value: string): boolean {
  return /\$\{[A-Z0-9_]+\}/i.test(value);
}

export interface LoadedProfiles {
  disabledProfiles?: string[];
  profiles: Record<string, ModelProfile>;
  defaultModel?: string;
  /** Non-fatal notices (dropped inline secrets, malformed entries). */
  warnings: string[];
}

/**
 * Merge trusted task-role routing entries (for example `image -> qwen-omni`).
 * Project values participate only after the normal project-trust gate.
 */
export async function loadModelRoles(
  cwd: string = process.cwd(),
): Promise<Record<string, string>> {
  const roles: Record<string, string> = {};
  for (const source of await loadTrustedSettingSources(cwd)) {
    const rawRoles = source.raw?.modelRoles;
    if (!rawRoles || typeof rawRoles !== "object" || Array.isArray(rawRoles)) continue;
    for (const [key, value] of Object.entries(rawRoles as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) roles[key] = value.trim();
    }
  }
  return roles;
}

/** Resolve the first configured role to a declared, usable model handle. */
export async function resolveModelRole(
  roleNames: readonly string[],
  cwd: string = process.cwd(),
): Promise<string | undefined> {
  const roles = await loadModelRoles(cwd);
  const handle = roleNames.map((name) => roles[name]).find(Boolean);
  if (!handle) return undefined;
  const { profiles, disabledProfiles } = await loadProfiles(cwd);
  if (disabledProfiles?.includes(handle)) throw new Error("该角色关联的导入模型尚未启用，请先在设置中补全配置并保存。");
  return profiles[handle] ? handle : undefined;
}

/**
 * Merge the `models` map (and `defaultModel`) across every settings source in
 * priority order, sanitizing privilege-sensitive fields from untrusted scopes.
 */
export async function loadProfiles(cwd: string = process.cwd()): Promise<LoadedProfiles> {
  // Endpoint, headers and env-backed credentials form one trust boundary.
  // Filtering only literal API keys still lets an untrusted repo override a
  // user's endpoint while inheriting their real key, or interpolate it into headers.
  const sources = await loadTrustedSettingSources(cwd);
  const merged: Record<string, RawProfile> = {};
  const warnings: string[] = [];
  let defaultModel: string | undefined;

  for (const src of sources) {
    if (!src.raw) continue;
    const trusted = isTrustedScopeForSensitiveKeys(src.source);

    const models = src.raw.models;
    if (models && typeof models === "object" && !Array.isArray(models)) {
      for (const [id, value] of Object.entries(models as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const raw: RawProfile = { ...(value as RawProfile) };

        // Drop inline literal API keys from project/local scopes — only
        // ${ENV} interpolation (or a trusted scope) may supply credentials.
        if (
          !trusted &&
          typeof raw.apiKey === "string" &&
          raw.apiKey.trim().length > 0 &&
          !usesEnvInterpolation(raw.apiKey)
        ) {
          warnings.push(
            `models.${id}.apiKey: inline secret from "${src.source}" scope ignored — use \${ENV} or a user/policy settings file`,
          );
          delete raw.apiKey;
        }

        merged[id] = { ...merged[id], ...raw };
      }
    }

    const dm = src.raw.defaultModel;
    if (typeof dm === "string" && dm.trim().length > 0) defaultModel = dm.trim();
  }

  const profiles: Record<string, ModelProfile> = {};
  for (const [id, raw] of Object.entries(merged)) {
    if (raw.disabled === true) { warnings.push(`models.${id}: disabled; complete the imported configuration in Settings`); continue; }
    if (id.startsWith(officialModelPrefix)) { warnings.push("CCAGENT 官方模型编号不能由项目或自定义配置覆盖。"); continue; }
    const built = buildProfile(id, raw, warnings);
    if (built) profiles[id] = built;
  }

  if (process.env.CCAGENT_ACCOUNT_ID) {
    try {
      const binding = await readServiceBinding();
      if (binding && binding.configuration.origin !== (await getPlatformAccountClient()).origin) throw new Error("Official service origin changed");
      for (const route of binding?.configuration.routes ?? []) {
        if (!["chat", "vision"].includes(route.service) || !["openai-chat", "openai-responses"].includes(route.protocol)) continue;
        const id = officialModelPrefix + route.id;
        profiles[id] = { id, platformService: route.id, upstreamProvider: route.provider, protocol: route.protocol as ModelProtocol, model: route.id,
          baseURL: binding!.configuration.origin + "/v1", maxTokens: route.limits.maxOutputTokens, contextWindow: route.limits.contextWindow };
      }
    } catch { warnings.push("官方服务配置需要重新验证；不会切换到其他供应商密钥。"); }
  }
  return { profiles, defaultModel, warnings, disabledProfiles: Object.entries(merged).filter(([, raw]) => raw.disabled === true).map(([id]) => id) };
}

function buildProfile(
  id: string,
  raw: RawProfile,
  warnings: string[],
): ModelProfile | null {
  const protocol =
    typeof raw.protocol === "string" ? interpolateEnv(raw.protocol.trim()).trim() : "";
  const model = typeof raw.model === "string" ? interpolateEnv(raw.model.trim()).trim() : "";

  if (!VALID_PROTOCOLS.has(protocol)) {
    warnings.push(
      `models.${id}: unknown or missing protocol "${protocol}" — ignored (expected anthropic | openai-chat | openai-responses | gemini)`,
    );
    return null;
  }
  if (!model) {
    warnings.push(`models.${id}: missing "model" — ignored`);
    return null;
  }

  const profile: ModelProfile = { id, protocol: protocol as ModelProtocol, model };

  const ollama = raw.provider === "ollama";
  if (ollama) {
    if (protocol !== "openai-chat") { warnings.push(`models.${id}: Ollama requires openai-chat — ignored`); return null; }
    try { profile.baseURL = normalizeOllamaBaseURL(typeof raw.baseURL === "string" ? interpolateEnv(raw.baseURL.trim()) : undefined); }
    catch { warnings.push(`models.${id}: invalid Ollama service address — ignored`); return null; }
    profile.provider = "ollama";
  }

  if (!ollama && typeof raw.baseURL === "string" && raw.baseURL.trim()) {
    profile.baseURL = interpolateEnv(raw.baseURL.trim());
  }
  if (!ollama && typeof raw.apiKey === "string" && raw.apiKey.trim()) {
    const key = interpolateEnv(raw.apiKey.trim());
    if (key) profile.apiKey = key;
  }
  if (typeof raw.maxTokens === "number" && Number.isFinite(raw.maxTokens) && raw.maxTokens > 0) {
    profile.maxTokens = raw.maxTokens;
  }
  if (
    typeof raw.contextWindow === "number" &&
    Number.isFinite(raw.contextWindow) &&
    raw.contextWindow > 0
  ) {
    profile.contextWindow = Math.floor(raw.contextWindow);
  }
  if (!ollama && raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = interpolateEnv(v);
    }
    if (Object.keys(out).length > 0) profile.headers = out;
  }

  return profile;
}

/**
 * Resolve a model handle into a concrete profile.
 *
 * - A handle matching a declared profile id → that profile.
 * - Anything else → a synthetic Anthropic profile whose `model` is the handle
 *   verbatim (legacy / direct-model behavior, env-configured client).
 */
export async function resolveProfile(
  handle: string,
  cwd: string = process.cwd(),
): Promise<ModelProfile> {
  const { profiles, disabledProfiles } = await loadProfiles(cwd);
  const declared = profiles[handle];
  if (declared) return declared;
  if (disabledProfiles?.includes(handle)) throw new Error("该导入模型尚未启用，请先在设置中补全配置并保存。");
  if (handle.startsWith(officialModelPrefix)) throw new Error("官方模型不可用，请验证平台 Key 并刷新服务目录。");
  return { id: handle, protocol: "anthropic", model: handle };
}
