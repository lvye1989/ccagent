import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Writable } from "node:stream";
import {
  type InitPrompter,
  buildUserSettings,
  mergeEnv,
  parseEnv,
  runInitCommand,
} from "../entrypoint/init.js";
import { GOOGLE_WORKSPACE_MCP_ENDPOINTS } from "../services/mcp/googleWorkspace.js";

const failures: string[] = [];

function assert(condition: unknown, label: string): void {
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}`);
  if (!condition) failures.push(label);
}

class FakePrompter implements InitPrompter {
  closed = false;

  constructor(
    private readonly answers: string[],
    private readonly secrets: string[],
    private readonly confirmations: boolean[],
  ) {}

  async ask(_label: string, fallback: string): Promise<string> {
    const answer = this.answers.shift() ?? "";
    return answer || fallback;
  }

  async secret(_label: string, _hasExisting: boolean): Promise<string> {
    return this.secrets.shift() ?? "";
  }

  async confirm(_label: string, defaultYes: boolean): Promise<boolean> {
    return this.confirmations.shift() ?? defaultYes;
  }

  close(): void {
    this.closed = true;
  }
}

function sink(): { output: Writable; text: () => string } {
  const chunks: string[] = [];
  return {
    output: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    }),
    text: () => chunks.join(""),
  };
}

console.log("\n[1] Pure merge helpers");
const mergedEnv = mergeEnv(
  "# keep me\nCUSTOM=value\nDEEPSEEK_API_KEY=old\nDEEPSEEK_API_KEY=older\n",
  { DEEPSEEK_API_KEY: "new", DEEPSEEK_MODEL: "deepseek-flash" },
);
assert(mergedEnv.includes("# keep me") && mergedEnv.includes("CUSTOM=value"), "dotenv comments and unknown keys survive");
assert(parseEnv(mergedEnv).DEEPSEEK_API_KEY === "new", "owned dotenv keys are updated");
assert(parseEnv(mergedEnv).DEEPSEEK_MODEL === "deepseek-flash", "new dotenv keys are appended");

const mergedSettings = buildUserSettings(
  { customFeature: { enabled: true }, models: { local: { protocol: "openai-chat", model: "local" } } },
  {
    envPath: "/tmp/.ccagent/.env",
    language: "zh-CN",
    deepseekBaseURL: "https://api.deepseek.com",
    deepseekModel: "deepseek-flash",
    configureQwen: true,
    qwenBaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    qwenModel: "qwen3.8-omni-flash",
    configureGoogleMcp: true,
    googleMcpRedirectUri: "http://127.0.0.1:53682/oauth/callback",
  },
);
assert(Boolean((mergedSettings.customFeature as { enabled?: boolean }).enabled), "unknown settings survive the merge");
assert(Boolean((mergedSettings.models as Record<string, unknown>).local), "unrelated model profiles survive the merge");
assert(
  ((mergedSettings.models as Record<string, { contextWindow?: number }>).deepseek?.contextWindow === 1_048_576),
  "DeepSeek init profile records the provider context window",
);
assert(
  Object.keys(mergedSettings.mcpServers as Record<string, unknown>).filter((name) => name.startsWith("google-")).length === 8,
  "Google Workspace init profile includes all eight official MCP servers",
);

console.log("\n[2] First-run files and connection orchestration");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-init-"));
try {
  const homeDir = path.join(root, ".ccagent");
  const firstPrompter = new FakePrompter(
    ["", "", "", "", "", "", ""],
    ["deep-test-key", "qwen-test-key", "openrouter-test-key", "google-client-id", "google-client-secret"],
    [true, true, true],
  );
  const firstOutput = sink();
  let testedDeepseek = false;
  let testedQwen = false;
  let testedJev = false;
  const firstCode = await runInitCommand([], {
    homeDir,
    output: firstOutput.output,
    prompter: firstPrompter,
    connectionTester: async (config) => {
      testedDeepseek = Boolean(config.deepseek);
      testedQwen = Boolean(config.qwen);
      testedJev = Boolean(config.jev);
      return [
        { provider: "DeepSeek", ok: true, detail: "ok" },
        { provider: "Qwen vision", ok: true, detail: "ok" },
        { provider: "OpenRouter Jev", ok: true, detail: "ok" },
      ];
    },
  });
  const settingsPath = path.join(homeDir, "settings.json");
  const envPath = path.join(homeDir, ".env");
  const settingsText = await fs.readFile(settingsPath, "utf-8");
  const settings = JSON.parse(settingsText) as Record<string, unknown>;
  const envText = await fs.readFile(envPath, "utf-8");
  const env = parseEnv(envText);

  assert(firstCode === 0 && firstPrompter.closed, "interactive init completes and closes its prompt");
  assert(settingsText.includes("${DEEPSEEK_API_KEY}") && settingsText.includes("${DASHSCOPE_API_KEY}"), "settings reference environment-backed secrets");
  assert(!settingsText.includes("deep-test-key") && !settingsText.includes("qwen-test-key") && !settingsText.includes("openrouter-test-key") && !settingsText.includes("google-client-secret"), "settings never contain literal API keys or OAuth secrets");
  assert(env.DEEPSEEK_API_KEY === "deep-test-key" && env.DASHSCOPE_API_KEY === "qwen-test-key" && env.OPENROUTER_API_KEY === "openrouter-test-key", "API keys are written only to the private dotenv file");
  assert(env.GOOGLE_MCP_CLIENT_ID === "google-client-id" && env.GOOGLE_MCP_CLIENT_SECRET === "google-client-secret", "Google OAuth credentials are written only to the private dotenv file");
  const googleServers = settings.mcpServers as Record<string, { url?: string; oauth?: { clientIdEnv?: string; clientSecretEnv?: string } }>;
  assert(Object.keys(GOOGLE_WORKSPACE_MCP_ENDPOINTS).every((name) => Boolean(googleServers[name])), "first-run settings install all official Google Workspace MCP endpoints");
  assert(Object.values(googleServers).filter((server) => server.url?.includes("googleapis.com/mcp/v1")).length === 8, "Google Workspace MCP entries use the eight official remote endpoints");
  assert(Object.values(googleServers).every((server) => !server.oauth || (server.oauth.clientIdEnv === "GOOGLE_MCP_CLIENT_ID" && server.oauth.clientSecretEnv === "GOOGLE_MCP_CLIENT_SECRET")), "Google MCP settings reference environment variable names instead of credentials");
  assert(env.QWEN_PROTOCOL === "openai-chat", "Qwen defaults to the verified Chat Completions protocol");
  assert(env.CCAGENT_COMPUTER_USE_INDICATOR === "1", "init enables the visible Computer Use control indicator by default");
  assert(env.JEV_MODEL === "~typesafe/jev-latest" && env.CCAGENT_JEV_MODE === "enforce", "init enables OpenRouter Jev decisions for Computer Use");
  assert(env.CCAGENT_TOOL_JEV === "1" && env.JEV_TOOL_MODE === "enforce", "init enables Jev as the general Auto Mode tool classifier");
  assert(env.CCAGENT_SEARCH_JEV === "1", "init enables Jev search-result reranking");
  assert(env.CCAGENT_WORKFRIEND_JEV === "1" && env.WORKFRIEND_JEV_MODE === "decision", "init gives Workfriend Jev mood/stress decision authority by default");
  assert(env.QWEN_TTS_MODEL === "qwen-audio-3.1-tts-flash" && env.QWEN_TTS_VOICE === "longanhuan_v3.1", "init writes Workfriend Qwen TTS defaults");
  assert((settings.env as Record<string, unknown>).CCAGENT_ENV_FILE === envPath, "settings point at the current user's canonical dotenv file");
  assert(settings.agentTeams === true, "init enables Agent Teams for a new user by default");
  assert(settings.agentSkills === true, "init enables Skills for a new user by default");
  assert(
    ((settings.models as Record<string, { contextWindow?: number }>).deepseek?.contextWindow === 1_048_576),
    "first-run settings enable the 1 Mi-token DeepSeek window",
  );
  assert(testedDeepseek && testedQwen && testedJev, "all configured providers are connection-tested");
  assert(!firstOutput.text().includes("deep-test-key") && !firstOutput.text().includes("qwen-test-key") && !firstOutput.text().includes("openrouter-test-key") && !firstOutput.text().includes("google-client-secret"), "command output does not reveal API keys or OAuth secrets");

  console.log("\n[3] Re-run preservation and malformed-file safety");
  const externalEnvPath = path.join(root, "existing-canonical.env");
  const withCustom = {
    ...settings,
    env: { ...(settings.env as Record<string, unknown>), CCAGENT_ENV_FILE: externalEnvPath },
    customFeature: { retained: true },
    agentSkills: false,
  };
  await fs.writeFile(settingsPath, JSON.stringify(withCustom, null, 2) + "\n", "utf-8");
  await fs.writeFile(externalEnvPath, "# existing\nCUSTOM_ENV=keep\n" + envText, "utf-8");
  const secondPrompter = new FakePrompter(["", "", ""], [""], [false, false, false]);
  const secondCode = await runInitCommand(["--skip-test"], {
    homeDir,
    output: sink().output,
    prompter: secondPrompter,
  });
  const secondSettings = JSON.parse(await fs.readFile(settingsPath, "utf-8")) as Record<string, unknown>;
  const secondEnv = parseEnv(await fs.readFile(externalEnvPath, "utf-8"));
  assert(secondCode === 0, "init can be safely re-run offline");
  assert(secondSettings.agentSkills === false, "init preserves an existing closed Skills preference");
  assert(Boolean((secondSettings.customFeature as { retained?: boolean }).retained), "re-run preserves unrelated settings");
  assert(secondEnv.CUSTOM_ENV === "keep" && secondEnv.DEEPSEEK_API_KEY === "deep-test-key", "re-run preserves unknown dotenv keys and an existing API key");
  assert((secondSettings.env as Record<string, unknown>).CCAGENT_ENV_FILE === externalEnvPath, "re-run honors an existing canonical dotenv path");

  const malformed = "{ definitely not json";
  await fs.writeFile(settingsPath, malformed, "utf-8");
  let rejectedMalformed = false;
  try {
    await runInitCommand(["--skip-test"], {
      homeDir,
      output: sink().output,
      prompter: new FakePrompter([], [], []),
    });
  } catch {
    rejectedMalformed = true;
  }
  assert(rejectedMalformed, "malformed existing settings are refused instead of overwritten");
  assert(await fs.readFile(settingsPath, "utf-8") === malformed, "malformed settings remain untouched for manual recovery");

  console.log("\n[4] Real CLI subcommand entry");
  const cli = spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(process.cwd(), "src", "entrypoint", "cli.ts"), "init", "--help"],
    {
      cwd: process.cwd(),
      env: { ...process.env, CCAGENT_HOME: path.join(root, "cli-home", ".ccagent") },
      encoding: "utf-8",
      timeout: 30_000,
    },
  );
  assert(cli.status === 0, "CLI routes the init subcommand without starting the REPL");
  assert(cli.stdout.includes("ccagent init [--skip-test]"), "CLI exposes init usage and offline option");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} init test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nAll init checks passed.");
}
