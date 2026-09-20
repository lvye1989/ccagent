/**
 * loadEnv — Multi-source environment variable loader.
 *
 * Loads env vars from the CCAGENT settings chain plus a dotenv file, with
 * increasing priority (later sources override earlier ones):
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
 * Note: the project/local `env` blocks come from repo files. This is the same
 * trust posture as the cwd `.env` file (which dotenv already auto-loads), so it
 * introduces no attack surface beyond what `.env` provides.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import dotenv from "dotenv";
import {
  getUserSettingsPath,
  getProjectSettingsPath,
  getLocalSettingsPath,
} from "./paths.js";

const DEEPSEEK_API_KEY = "DEEPSEEK_API_KEY";

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

export function loadEnv(): void {
  const cwd = process.cwd();

  // Never inherit the DeepSeek key from the parent shell, Windows user env,
  // or a previously loaded settings source. The selected .env below is the
  // sole authority for this credential.
  delete process.env[DEEPSEEK_API_KEY];

  // Settings `env` blocks, low → high priority (later wins).
  Object.assign(process.env, readJsonEnv(getUserSettingsPath()));
  Object.assign(process.env, readJsonEnv(getProjectSettingsPath(cwd)));
  Object.assign(process.env, readJsonEnv(getLocalSettingsPath(cwd)));

  // The selected .env is the highest-priority source. Parse into an isolated
  // object first so empty template entries are ignored. For DeepSeek, an empty
  // value leaves the key unavailable rather than falling back to another path.
  // `quiet` suppresses dotenv's "injected env (N) from .env" tip banner so
  // the REPL opens on a clean welcome card instead of a stray log line.
  const configuredEnvFile = process.env.CCAGENT_ENV_FILE?.trim();
  const envFile = configuredEnvFile
    ? path.resolve(cwd, configuredEnvFile)
    : path.join(cwd, ".env");
  const dotenvValues: Record<string, string> = {};
  dotenv.config({ path: envFile, processEnv: dotenvValues, override: true, quiet: true });
  for (const [key, value] of Object.entries(dotenvValues)) {
    if (value !== "") process.env[key] = value;
  }
}
