/**
 * Load + merge sandbox settings from user (~/.ccagent/settings.json)
 * and project (<cwd>/.ccagent/settings.json) scopes.
 *
 * Project overrides user (matches the existing permissions/MCP loaders
 * — see `src/permissions/permissions.ts:loadPermissionSettings`).
 *
 * Defaults:
 *   - enabled: false                      → opt-in feature
 *   - autoAllowBashIfSandboxed: true      → matches source code
 *   - allowUnsandboxedCommands: true      → matches source code
 *
 * Returns a fully-populated SandboxSettings — every field has a value,
 * so callers don't need to repeat default-checking.
 */

import { isTrustedScopeForSensitiveKeys, loadSettingSources } from "../config/sources.js";
import type {
  SandboxFilesystemSettings,
  SandboxNetworkSettings,
  SandboxSettings,
} from "./types.js";

interface RawRootSettings {
  sandbox?: unknown;
}

function asStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error("Sandbox path/domain/command lists must contain only strings.");
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function pickFilesystem(value: unknown): SandboxFilesystemSettings {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sandbox.filesystem must be an object.");
  const fs = value as Record<string, unknown>;
  return {
    allowWrite: asStringArray(fs.allowWrite),
    denyWrite: asStringArray(fs.denyWrite),
    allowRead: asStringArray(fs.allowRead),
    denyRead: asStringArray(fs.denyRead),
  };
}

function pickNetwork(value: unknown): SandboxNetworkSettings {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sandbox.network must be an object.");
  const net = value as Record<string, unknown>;
  return {
    allowedDomains: asStringArray(net.allowedDomains),
    deniedDomains: asStringArray(net.deniedDomains),
  };
}

function pickSandbox(value: unknown): SandboxSettings {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sandbox must be an object.");
  const raw = value as Record<string, unknown>;
  for (const key of ["enabled", "autoAllowBashIfSandboxed", "allowUnsandboxedCommands"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") throw new Error(`sandbox.${key} must be a boolean.`);
  }
  if (raw.docker !== undefined && (!raw.docker || typeof raw.docker !== "object" || Array.isArray(raw.docker))) throw new Error("sandbox.docker must be an object.");
  if (raw.docker && Object.keys(raw.docker).some(key => key !== "image")) throw new Error("sandbox.docker supports only image; container security and resource limits cannot be overridden.");
  if (raw.docker && (raw.docker as Record<string, unknown>).image !== undefined && typeof (raw.docker as Record<string, unknown>).image !== "string") throw new Error("sandbox.docker.image must be a string.");
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
    autoAllowBashIfSandboxed:
      typeof raw.autoAllowBashIfSandboxed === "boolean"
        ? raw.autoAllowBashIfSandboxed
        : undefined,
    allowUnsandboxedCommands:
      typeof raw.allowUnsandboxedCommands === "boolean"
        ? raw.allowUnsandboxedCommands
        : undefined,
    excludedCommands: asStringArray(raw.excludedCommands),
    filesystem: pickFilesystem(raw.filesystem),
    network: pickNetwork(raw.network),
    docker: raw.docker && typeof raw.docker === "object"
      ? { image: typeof (raw.docker as Record<string, unknown>).image === "string" ? (raw.docker as Record<string, string>).image : undefined }
      : undefined,
  };
}

function mergeStringArrays(...lists: (string[] | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const item of list ?? []) {
      if (!seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
  }
  return out;
}

export interface ResolvedSandboxSettings {
  enabled: boolean;
  autoAllowBashIfSandboxed: boolean;
  allowUnsandboxedCommands: boolean;
  excludedCommands: string[];
  filesystem: Required<SandboxFilesystemSettings>;
  network: Required<SandboxNetworkSettings>;
  docker?: { image?: string };
}

export const DEFAULT_RESOLVED_SANDBOX_SETTINGS: ResolvedSandboxSettings = {
  enabled: false,
  autoAllowBashIfSandboxed: true,
  allowUnsandboxedCommands: true,
  excludedCommands: [],
  filesystem: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] },
  network: { allowedDomains: [], deniedDomains: [] },
};

/**
 * Fold an ordered list of per-source sandbox settings (low → high priority)
 * into a fully-populated resolved object. Scalar fields take the last defined
 * value (later source wins); array fields merge + de-duplicate across sources.
 */
export function resolveSandboxList(list: SandboxSettings[]): ResolvedSandboxSettings {
  const lastDefined = <T>(pick: (s: SandboxSettings) => T | undefined, fallback: T): T => {
    let result: T | undefined;
    for (const s of list) {
      const v = pick(s);
      if (v !== undefined) result = v;
    }
    return result ?? fallback;
  };
  return {
    enabled: lastDefined((s) => s.enabled, false),
    autoAllowBashIfSandboxed: lastDefined((s) => s.autoAllowBashIfSandboxed, true),
    allowUnsandboxedCommands: lastDefined((s) => s.allowUnsandboxedCommands, true),
    excludedCommands: mergeStringArrays(...list.map((s) => s.excludedCommands)),
    filesystem: {
      allowWrite: mergeStringArrays(...list.map((s) => s.filesystem?.allowWrite)),
      denyWrite: mergeStringArrays(...list.map((s) => s.filesystem?.denyWrite)),
      allowRead: mergeStringArrays(...list.map((s) => s.filesystem?.allowRead)),
      denyRead: mergeStringArrays(...list.map((s) => s.filesystem?.denyRead)),
    },
    network: {
      allowedDomains: mergeStringArrays(...list.map((s) => s.network?.allowedDomains)),
      deniedDomains: mergeStringArrays(...list.map((s) => s.network?.deniedDomains)),
    },
    docker: lastDefined((s) => s.docker, {}),
  };
}

export function resolveSandboxSettings(
  user: SandboxSettings,
  project: SandboxSettings,
): ResolvedSandboxSettings {
  return resolveSandboxList([user, project]);
}

export async function loadSandboxSettings(
  cwd: string,
): Promise<ResolvedSandboxSettings> {
  const sources = await loadSettingSources(cwd);
  // An unreadable policy must never turn an opted-in sandbox into host execution.
  if (sources.some(src => src.parseError)) throw new Error("Sandbox settings could not be read; shell execution is blocked until settings are repaired.");
  const list = sources.map(src => {
    const picked = src.raw ? pickSandbox((src.raw as RawRootSettings).sandbox) : {};
    if (isTrustedScopeForSensitiveKeys(src.source)) return picked;
    // A repository may tighten isolation but cannot disable a user's isolation,
    // select executable images, or add model-controlled escape hatches.
    return { enabled: picked.enabled === true ? true : undefined,
      autoAllowBashIfSandboxed: picked.autoAllowBashIfSandboxed === false ? false : undefined,
      allowUnsandboxedCommands: picked.allowUnsandboxedCommands === false ? false : undefined,
      filesystem: { denyRead: picked.filesystem?.denyRead, denyWrite: picked.filesystem?.denyWrite },
      network: { deniedDomains: picked.network?.deniedDomains } };
  });
  return resolveSandboxList(list);
}
