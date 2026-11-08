import type { Tool, ToolResult } from "../tools/Tool.js";

export type SketchupWebTestResult = {
  ok: boolean;
  mcpConnected: boolean;
  sketchupConnected: boolean;
  message: string;
  toolCount: number;
  /** Actual SketchUp application version, when explicitly reported upstream. */
  version?: string;
  /** Ruby extension version; this is not the SketchUp application version. */
  pluginVersion?: string;
  warning?: string;
};

type ObjectValue = Record<string, unknown>;
const objectValue = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const VERSION_TOOL = "mcp__app-sketchup__get_version";
const MODEL_TOOL = "mcp__app-sketchup__get_model_info";
const MAX_RESULT_CHARS = 1_000_000;

/**
 * sketchup-mcp2 0.4.0 returns JSON strings, sometimes inside MCP/JSON-RPC
 * envelopes. Decode only these bounded, explicit wrappers; never execute code.
 */
function payload(value: unknown, depth = 0): ObjectValue {
  if (depth > 10) throw new Error("invalid-result");
  if (typeof value === "string") {
    if (!value.length || value.length > MAX_RESULT_CHARS) throw new Error("invalid-result");
    return payload(JSON.parse(value) as unknown, depth + 1);
  }
  if (!objectValue(value) || value.isError === true || value.ok === false || value.success === false
    || (value.error !== undefined && value.error !== null && value.error !== "")) throw new Error("invalid-result");
  if ("content" in value) {
    if (typeof value.content === "string") return payload(value.content, depth + 1);
    if (!Array.isArray(value.content) || !value.content.length) throw new Error("invalid-result");
    const parts: string[] = [];
    let length = 0;
    for (const block of value.content) {
      if (!objectValue(block) || block.type !== "text" || typeof block.text !== "string") throw new Error("invalid-result");
      length += block.text.length + 1;
      if (length > MAX_RESULT_CHARS) throw new Error("invalid-result");
      parts.push(block.text);
    }
    return payload(parts.join("\n"), depth + 1);
  }
  if ("result" in value) return payload(value.result, depth + 1);
  if ("structuredContent" in value) return payload(value.structuredContent, depth + 1);
  return value;
}

function parseResult(result: ToolResult): ObjectValue {
  return payload(result);
}

function extensionVersion(value: unknown): string | undefined {
  return typeof value === "string" && /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/.test(value) ? value : undefined;
}

function meetsFloor(version: string, floor: string): boolean {
  const components = version.split(".").map(Number);
  const minimum = floor.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (components[index] !== minimum[index]) return components[index]! > minimum[index]!;
  }
  return true;
}

function applicationVersion(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 32 || !/^[1-9]\d{1,3}(?:\.\d{1,6}){1,3}$/.test(value)) return undefined;
  const major = Number(value.split(".")[0]);
  return (major >= 17 && major <= 99) || (major >= 2017 && major <= 2099) ? value : undefined;
}

function validVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

/** Validate the real Ruby get_model_info contract, including an empty model. */
function validModel(model: ObjectValue): boolean {
  if (typeof model.path !== "string" || model.path.length > 32_768 || typeof model.title !== "string" || model.title.length > 4096
    || model.units !== "mm" || typeof model.entity_count !== "number" || !Number.isSafeInteger(model.entity_count) || model.entity_count < 0
    || !Array.isArray(model.layers) || !model.layers.every((layer) => typeof layer === "string") || !("bounding_box_mm" in model)) return false;
  const bounds = model.bounding_box_mm;
  if (bounds === null) return true;
  if (!objectValue(bounds) || !validVector(bounds.min) || !validVector(bounds.max)) return false;
  const maximum = bounds.max;
  return bounds.min.every((coordinate, index) => coordinate <= maximum[index]!);
}

/**
 * Read-only runtime check for the catalog-owned SketchUp MCP adapter. The
 * upstream tools do not declare readOnlyHint, so exact names form the allowlist.
 * Never call eval_ruby, screenshots, exports, generation, or model mutations.
 */
export async function runSketchupWebTest(workspace: string, tools: readonly Tool[]): Promise<SketchupWebTestResult> {
  const report: SketchupWebTestResult = { ok: false, mcpConnected: false, sketchupConnected: false, message: "", toolCount: tools.length };
  try {
    const versions = tools.filter((tool) => tool.name === VERSION_TOOL);
    const models = tools.filter((tool) => tool.name === MODEL_TOOL);
    if (versions.length !== 1 || models.length !== 1 || !versions[0]!.isEnabled() || !models[0]!.isEnabled()) {
      report.message = "SketchUp MCP 检查工具不可用，请先安装并连接插件。";
      return report;
    }
    const versionResult = await versions[0]!.call({}, { cwd: workspace });
    if (versionResult.isError) throw new Error("tool-error");
    report.mcpConnected = true;
    const compatibility = parseResult(versionResult);
    const pythonVersion = extensionVersion(compatibility.python_version);
    const pluginVersion = extensionVersion(compatibility.ruby_version);
    const rubyFloor = extensionVersion(compatibility.min_compatible_ruby);
    const pythonFloor = extensionVersion(compatibility.ruby_min_compatible_python);
    if (!pythonVersion || !pluginVersion || !rubyFloor || !pythonFloor || compatibility.compatible !== true
      || !meetsFloor(pluginVersion, rubyFloor) || !meetsFloor(pythonVersion, pythonFloor)) {
      report.message = "MCP 已响应，尚未确认 SketchUp 扩展兼容并连接；请启动 SketchUp 中的 MCP Server，并检查两端版本。";
      return report;
    }
    report.pluginVersion = pluginVersion;
    // A successful compatibility handshake alone must never pass the UI test.
    if (!models[0]!.isEnabled()) {
      report.message = "SketchUp MCP 已停用，请重新连接插件后测试。";
      return report;
    }
    const model = parseResult(await models[0]!.call({}, { cwd: workspace }));
    if (!validModel(model)) {
      report.message = "MCP 已响应，但模型信息无效，尚未确认 SketchUp 真实连接。";
      return report;
    }
    const reportedVersions = [compatibility.sketchup_version, model.sketchup_version].filter((value) => value !== undefined);
    const actualVersions = reportedVersions.map(applicationVersion);
    if (actualVersions.some((version) => !version) || new Set(actualVersions).size > 1) {
      report.message = "MCP 已响应，但 SketchUp 应用版本信息无效，尚未通过连接检查。";
      return report;
    }
    if (actualVersions[0]) report.version = actualVersions[0];
    else report.warning = "当前桥接版本未提供 SketchUp 应用版本；扩展版本单独显示。此检查仅验证连接和模型读取。";
    report.ok = true;
    report.sketchupConnected = true;
    report.message = "SketchUp 已真实连接，已只读获取当前模型信息。";
    return report;
  } catch {
    // Upstream diagnostics may contain model paths, account names or secrets.
    report.message = report.mcpConnected
      ? "MCP 已响应，但 SketchUp 连接检查失败；请确认 SketchUp 已启动且扩展中的 MCP Server 正在运行。"
      : "SketchUp MCP 检查失败，请重新连接插件后重试。";
    return report;
  }
}
