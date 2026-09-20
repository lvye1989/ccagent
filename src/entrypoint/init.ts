import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { deflateSync } from "node:zlib";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { collectViaProvider } from "../services/api/providers/providerStream.js";
import type { ModelProfile } from "../services/api/providers/profile.js";
import { getCCAgentHome, getUserSettingsPath } from "../utils/paths.js";

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";
const DEFAULT_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_QWEN_MODEL = "qwen3.8-omni-flash";

export interface InitPrompter {
  ask(label: string, fallback: string): Promise<string>;
  secret(label: string, hasExisting: boolean): Promise<string>;
  confirm(label: string, defaultYes: boolean): Promise<boolean>;
  close(): void;
}

export interface InitConnectionConfig {
  deepseek?: { apiKey: string; baseURL: string; model: string };
  qwen?: { apiKey: string; baseURL: string; model: string };
}

export interface InitConnectionResult {
  provider: "DeepSeek" | "Qwen vision";
  ok: boolean;
  detail: string;
}

export interface InitCommandOptions {
  homeDir?: string;
  output?: NodeJS.WritableStream;
  prompter?: InitPrompter;
  skipConnectivity?: boolean;
  connectionTester?: (config: InitConnectionConfig) => Promise<InitConnectionResult[]>;
}

interface ExistingFiles {
  settings: Record<string, unknown>;
  envPath: string;
  envText: string;
  env: Record<string, string>;
}

class ReadlineInitPrompter implements InitPrompter {
  private readonly output: NodeJS.WritableStream;
  private readonly input: NodeJS.ReadableStream;
  private readonly terminal: boolean;
  private readonly rl: ReturnType<typeof createInterface>;

  constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
    this.input = input;
    this.output = output;
    this.terminal = Boolean((input as NodeJS.ReadStream).isTTY && (output as NodeJS.WriteStream).isTTY);
    this.rl = createInterface({ input, output, terminal: this.terminal });
  }

  async ask(label: string, fallback: string): Promise<string> {
    const answer = (await this.rl.question(`${label} [${fallback}]: `)).trim();
    return answer || fallback;
  }

  async secret(label: string, hasExisting: boolean): Promise<string> {
    const suffix = hasExisting ? " [已配置，回车保留]: " : ": ";
    if (!this.terminal) return (await this.rl.question(label + suffix)).trim();

    // readline has no public password mode. Suppress its terminal echo while
    // retaining normal line editing, then print the newline ourselves.
    const internal = this.rl as unknown as { _writeToOutput?: (text: string) => void };
    const original = internal._writeToOutput;
    this.output.write(label + suffix);
    internal._writeToOutput = () => {};
    try {
      return (await this.rl.question("")).trim();
    } finally {
      internal._writeToOutput = original;
      this.output.write("\n");
    }
  }

  async confirm(label: string, defaultYes: boolean): Promise<boolean> {
    const hint = defaultYes ? "Y/n" : "y/N";
    const answer = (await this.rl.question(`${label} [${hint}]: `)).trim().toLowerCase();
    if (!answer) return defaultYes;
    return ["y", "yes", "是", "好", "配置"].includes(answer);
  }

  close(): void {
    this.rl.close();
    // Retain references through the lifetime of readline; this also makes the
    // stream ownership explicit for injected test streams.
    void this.input;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function readExistingFiles(settingsPath: string, defaultEnvPath: string): Promise<ExistingFiles> {
  let settings: Record<string, unknown> = {};
  try {
    const text = await fs.readFile(settingsPath, "utf-8");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("settings root must be a JSON object");
    }
    settings = parsed as Record<string, unknown>;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`无法安全读取现有 settings.json：${(error as Error).message}`);
    }
  }

  const configuredEnvPath = objectValue(settings.env).CCAGENT_ENV_FILE;
  const envPath = typeof configuredEnvPath === "string" && configuredEnvPath.trim()
    ? path.resolve(process.cwd(), configuredEnvPath.trim())
    : defaultEnvPath;
  let envText = "";
  try {
    envText = await fs.readFile(envPath, "utf-8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { settings, envPath, envText, env: parseEnv(envText) };
}

export function parseEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2] ?? "";
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[match[1]!] = value;
  }
  return result;
}

function envValue(value: string): string {
  return /^[A-Za-z0-9_./:@-]*$/.test(value) ? value : JSON.stringify(value);
}

/** Preserve comments and unknown keys while updating only init-owned values. */
export function mergeEnv(text: string, updates: Record<string, string>): string {
  const remaining = new Map(Object.entries(updates));
  const lines = text ? text.replace(/\r\n/g, "\n").split("\n") : [];
  const output = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key = match?.[1];
    if (!key || !Object.hasOwn(updates, key)) return line;
    const value = updates[key]!;
    remaining.delete(key);
    return `${key}=${envValue(value)}`;
  });
  while (output.length > 0 && output[output.length - 1] === "") output.pop();
  if (output.length > 0 && remaining.size > 0) output.push("");
  for (const [key, value] of remaining) output.push(`${key}=${envValue(value)}`);
  return output.join("\n") + "\n";
}

export function buildUserSettings(
  existing: Record<string, unknown>,
  input: {
    envPath: string;
    language: string;
    deepseekBaseURL: string;
    deepseekModel: string;
    configureQwen: boolean;
    qwenBaseURL?: string;
    qwenModel?: string;
  },
): Record<string, unknown> {
  const env = { ...objectValue(existing.env), CCAGENT_ENV_FILE: input.envPath };
  const models = objectValue(existing.models);
  const deepseek = {
    ...objectValue(models.deepseek),
    protocol: "${DEEPSEEK_PROTOCOL:-openai-responses}",
    model: "${DEEPSEEK_MODEL:-deepseek-flash}",
    baseURL: "${DEEPSEEK_BASE_URL:-https://api.deepseek.com}",
    apiKey: "${DEEPSEEK_API_KEY}",
  };
  const nextModels: Record<string, unknown> = { ...models, deepseek };
  const roles: Record<string, unknown> = { ...objectValue(existing.modelRoles) };

  if (input.configureQwen) {
    nextModels["qwen-omni"] = {
      ...objectValue(models["qwen-omni"]),
      protocol: "${QWEN_PROTOCOL:-openai-chat}",
      model: "${QWEN_MODEL:-qwen3.8-omni-flash}",
      baseURL: "${DASHSCOPE_BASE_URL}",
      apiKey: "${DASHSCOPE_API_KEY}",
      maxTokens: 4096,
    };
    roles.computerUse = "qwen-omni";
    roles.image = "qwen-omni";
    roles.multimodal = "qwen-omni";
  }

  return {
    ...existing,
    env,
    language: input.language,
    defaultModel:
      typeof existing.defaultModel === "string" && existing.defaultModel.trim()
        ? existing.defaultModel
        : "deepseek",
    models: nextModels,
    ...(Object.keys(roles).length > 0 ? { modelRoles: roles } : {}),
  };
}

async function writePrivateFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(filePath, 0o600);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function redTestPng(): Buffer {
  const width = 32;
  const height = 32;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((1 + width * 3) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const pixel = row + 1 + x * 3;
      raw[pixel] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function responseText(content: Awaited<ReturnType<typeof collectViaProvider>>["content"]): string {
  return content
    .filter((block): block is Extract<(typeof content)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

async function testProfile(
  provider: InitConnectionResult["provider"],
  profile: ModelProfile,
  messages: MessageParam[],
  secrets: string[],
): Promise<InitConnectionResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const result = await collectViaProvider(profile, {
      model: profile.id,
      messages,
      maxTokens: 128,
      signal: controller.signal,
      querySource: "background",
      thinking: { type: "disabled" },
    });
    const text = responseText(result.content);
    if (!text) throw new Error("provider returned no text");
    if (provider === "Qwen vision" && !/red/i.test(text)) {
      throw new Error("vision response did not identify the red test image");
    }
    return { provider, ok: true, detail: "连接与响应验证通过" };
  } catch (error: unknown) {
    let detail = error instanceof Error ? error.message : String(error);
    for (const secret of secrets) if (secret) detail = detail.replaceAll(secret, "<redacted>");
    detail = detail.replace(/sk-[A-Za-z0-9_-]+/g, "<redacted>").replace(/\s+/g, " ").slice(0, 400);
    return { provider, ok: false, detail };
  } finally {
    clearTimeout(timer);
  }
}

export async function testInitConnections(config: InitConnectionConfig): Promise<InitConnectionResult[]> {
  const results: InitConnectionResult[] = [];
  if (config.deepseek) {
    const profile: ModelProfile = {
      id: "deepseek",
      protocol: "openai-responses",
      model: config.deepseek.model,
      baseURL: config.deepseek.baseURL,
      apiKey: config.deepseek.apiKey,
    };
    results.push(await testProfile(
      "DeepSeek",
      profile,
      [{ role: "user", content: "Reply exactly INIT_OK." }],
      [config.deepseek.apiKey],
    ));
  }
  if (config.qwen) {
    const profile: ModelProfile = {
      id: "qwen-omni",
      protocol: "openai-chat",
      model: config.qwen.model,
      baseURL: config.qwen.baseURL,
      apiKey: config.qwen.apiKey,
    };
    const image = {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: redTestPng().toString("base64"),
      },
    };
    results.push(await testProfile(
      "Qwen vision",
      profile,
      [{
        role: "user",
        content: [
          { type: "text", text: "Identify the dominant color in this image. Reply with one English color word." },
          image,
        ],
      } as unknown as MessageParam],
      [config.qwen.apiKey],
    ));
  }
  return results;
}

export async function runInitCommand(
  argv: string[] = [],
  options: InitCommandOptions = {},
): Promise<number> {
  const output = options.output ?? process.stdout;
  if (argv.includes("--help") || argv.includes("-h")) {
    output.write([
      "Usage: ccagent init [--skip-test]",
      "",
      "Create or safely update ~/.ccagent/.env and ~/.ccagent/settings.json.",
      "API keys are written only to the private .env file.",
      "",
    ].join("\n"));
    return 0;
  }

  const homeDir = options.homeDir ?? getCCAgentHome();
  const settingsPath = options.homeDir ? path.join(homeDir, "settings.json") : getUserSettingsPath();
  const existing = await readExistingFiles(settingsPath, path.join(homeDir, ".env"));
  const envPath = existing.envPath;
  const prompter = options.prompter ?? new ReadlineInitPrompter(process.stdin, output);

  output.write([
    "CCAGENT 用户级初始化",
    `配置目录: ${homeDir}`,
    `密钥文件: ${envPath}`,
    "已有配置会安全合并，API Key 不会写入 settings.json。",
    "",
  ].join("\n"));

  try {
    const language = await prompter.ask(
      "响应语言",
      typeof existing.settings.language === "string" ? existing.settings.language : "zh-CN",
    );
    const deepseekApiKeyInput = await prompter.secret(
      "DeepSeek API Key",
      Boolean(existing.env.DEEPSEEK_API_KEY),
    );
    const deepseekApiKey = deepseekApiKeyInput || existing.env.DEEPSEEK_API_KEY || "";
    const deepseekBaseURL = await prompter.ask(
      "DeepSeek Base URL",
      existing.env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL,
    );
    const deepseekModel = await prompter.ask(
      "DeepSeek 模型",
      existing.env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL,
    );

    const configureQwen = await prompter.confirm(
      "配置 Qwen 视觉感知",
      true,
    );
    let qwenApiKey = existing.env.DASHSCOPE_API_KEY || "";
    let qwenBaseURL = existing.env.DASHSCOPE_BASE_URL || DEFAULT_QWEN_BASE_URL;
    let qwenModel = existing.env.QWEN_MODEL || DEFAULT_QWEN_MODEL;
    if (configureQwen) {
      const keyInput = await prompter.secret("DashScope API Key", Boolean(qwenApiKey));
      qwenApiKey = keyInput || qwenApiKey;
      qwenBaseURL = await prompter.ask("DashScope Base URL", qwenBaseURL);
      qwenModel = await prompter.ask("Qwen 视觉模型", qwenModel);
    }

    const settings = buildUserSettings(existing.settings, {
      envPath,
      language,
      deepseekBaseURL,
      deepseekModel,
      configureQwen,
      qwenBaseURL,
      qwenModel,
    });
    const envUpdates: Record<string, string> = {
      DEEPSEEK_API_KEY: deepseekApiKey,
      DEEPSEEK_PROTOCOL: "openai-responses",
      DEEPSEEK_MODEL: deepseekModel,
      DEEPSEEK_BASE_URL: deepseekBaseURL,
    };
    if (configureQwen) {
      Object.assign(envUpdates, {
        DASHSCOPE_API_KEY: qwenApiKey,
        DASHSCOPE_BASE_URL: qwenBaseURL,
        QWEN_PROTOCOL: "openai-chat",
        QWEN_MODEL: qwenModel,
      });
    }

    await writePrivateFile(envPath, mergeEnv(existing.envText, envUpdates));
    await writePrivateFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    output.write(`\n✓ 已写入 ${envPath}\n✓ 已写入 ${settingsPath}\n`);

    const skipConnectivity = options.skipConnectivity || argv.includes("--skip-test");
    if (skipConnectivity) {
      output.write("- 已按要求跳过连接测试。\n");
      return 0;
    }

    const connectionConfig: InitConnectionConfig = {
      ...(deepseekApiKey
        ? { deepseek: { apiKey: deepseekApiKey, baseURL: deepseekBaseURL, model: deepseekModel } }
        : {}),
      ...(configureQwen && qwenApiKey
        ? { qwen: { apiKey: qwenApiKey, baseURL: qwenBaseURL, model: qwenModel } }
        : {}),
    };
    if (!connectionConfig.deepseek) output.write("- DeepSeek：未填写 API Key，跳过连接测试。\n");
    if (configureQwen && !connectionConfig.qwen) output.write("- Qwen vision：未填写 API Key，跳过连接测试。\n");

    const tester = options.connectionTester ?? testInitConnections;
    const results = await tester(connectionConfig);
    for (const result of results) {
      output.write(`${result.ok ? "✓" : "✗"} ${result.provider}：${result.detail}\n`);
    }
    const failed = results.some((result) => !result.ok);
    output.write(failed
      ? "配置已保存，但至少一个连接测试失败；修正 ~/.ccagent/.env 后重新运行 ccagent init。\n"
      : "初始化完成。现在可以在任意目录运行 ccagent。\n");
    return failed ? 1 : 0;
  } finally {
    prompter.close();
  }
}
