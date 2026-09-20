/**
 * loadEnv — Multi-source environment variable loader.
 *
 * Loads user configuration first. Project/local env and implicit cwd dotenv
 * are read only after machine-level project trust has been established.
 *
 *   1. ~/.ccagent/settings.json            → user-scope `env` block
 *   2. <cwd>/.ccagent/settings.json        → project-scope `env` block
 *   3. <cwd>/.ccagent/settings.local.json  → project-local `env` block
 *   4. $CCAGENT_ENV_FILE or <cwd>/.env        → dotenv file (highest priority)
 *
 * DeepSeek is intentionally stricter: `DEEPSEEK_API_KEY` is ignored in the
 * inherited process environment and in every settings `env` block. Its only
 * accepted source is the selected dotenv file. `CCAGENT_ENV_FILE` may point to
 * one canonical file so a globally installed command uses the same key while
 * running from different working directories.
 *
 * A repository cannot select a different user home, trust store, canonical key
 * file, Node loader or TLS policy through environment entries. An explicit
 * shell/user CCAGENT_ENV_FILE still works from any working directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import dotenv from "dotenv";
import { isProjectTrusted } from "../config/globalState.js";
import {
  getUserSettingsPath,
  getProjectSettingsPath,
  getLocalSettingsPath,
} from "./paths.js";

const DEEPSEEK_API_KEY = "DEEPSEEK_API_KEY";
const IDENTITY_KEYS = new Set(["CCAGENT_HOME", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"]);
const PROJECT_PROTECTED_KEYS = new Set([
  ...IDENTITY_KEYS, "CCAGENT_ENV_FILE", "NODE_OPTIONS", "NODE_PATH",
  "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
]);
const injected = new Map<string, { before: string | undefined; applied: string }>();

function applyValues(values: Record<string, string>, projectOwned: boolean, allowEnvFile = false): void {
  for (const [key, value] of Object.entries(values)) {
    const upper = key.toUpperCase();
    if (!value || IDENTITY_KEYS.has(upper) || (!allowEnvFile && upper === "CCAGENT_ENV_FILE") ||
        (projectOwned && PROJECT_PROTECTED_KEYS.has(upper))) continue;
    const previous = injected.get(key);
    injected.set(key, { before: previous ? previous.before : process.env[key], applied: value });
    process.env[key] = value;
  }
}

function readJsonEnv(filePath: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "env" in parsed &&
      (parsed as { env?: unknown }).env &&
      typeof (parsed as { env?: unknown }).env === "object"
    ) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries((parsed as { env: Record<string, unknown> }).env)) {
        // DeepSeek credentials have one canonical source: the selected .env.
        if (k.toUpperCase() === DEEPSEEK_API_KEY) continue;
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // File doesn't exist or is invalid JSON — silently skip.
  }
  return {};
}

export async function loadEnv(): Promise<void> {
  const cwd = process.cwd();

  // Trust may change between loads (first-run consent or another cwd). Do not
  // leave previously injected repository values active after revocation.
  // Explicit changes made by the caller since the last load are preserved.
  for (const [key, { before, applied }] of injected) {
    if (process.env[key] !== applied) continue;
    if (before === undefined) delete process.env[key]; else process.env[key] = before;
  }
  injected.clear();

  // Never inherit the DeepSeek key from the parent shell, Windows user env,
  // or a previously loaded settings source. The selected .env below is the
  // sole authority for this credential.
  delete process.env[DEEPSEEK_API_KEY];

  const userSettingsPath = getUserSettingsPath();
  const userEnv = readJsonEnv(userSettingsPath);
  // Relative paths owned by user settings are relative to THAT file, not an
  // arbitrary repository cwd. Shell-selected relative paths remain explicit.
  if (userEnv.CCAGENT_ENV_FILE?.trim()) {
    userEnv.CCAGENT_ENV_FILE = path.resolve(path.dirname(userSettingsPath), userEnv.CCAGENT_ENV_FILE.trim());
  }
  applyValues(userEnv, false, true);
  // Pin the credential location BEFORE any project-owned data is considered.
  const configuredEnvFile = process.env.CCAGENT_ENV_FILE?.trim();
  const trusted = await isProjectTrusted(cwd);
  if (trusted) {
    applyValues(readJsonEnv(getProjectSettingsPath(cwd)), true);
    applyValues(readJsonEnv(getLocalSettingsPath(cwd)), true);
  }

  // The selected .env is the highest-priority source. Parse into an isolated
  // object first so empty template entries are ignored. For DeepSeek, an empty
  // value leaves the key unavailable rather than falling back to another path.
  // `quiet` suppresses dotenv's "injected env (N) from .env" tip banner so
  // the REPL opens on a clean welcome card instead of a stray log line.
  if (!configuredEnvFile && !trusted) return;
  const envFile = configuredEnvFile
    ? path.resolve(cwd, configuredEnvFile)
    : path.join(cwd, ".env");
  const dotenvValues: Record<string, string> = {};
  dotenv.config({ path: envFile, processEnv: dotenvValues, override: true, quiet: true });
  applyValues(dotenvValues, !configuredEnvFile);
}
