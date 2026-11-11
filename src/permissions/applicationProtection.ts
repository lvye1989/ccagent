import * as path from "node:path";
import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { getCCAgentHome } from "../utils/paths.js";
import { canMaintainApplication, getPlatformHome } from "../platform/account.js";

/** Explicit-target guard, deliberately not an arbitrary-code sandbox. */
export const APPLICATION_PROTECTION_MESSAGE = "应用自身保护：只有服务端核实的应用管理员才能修改 CCAGENT 代码、界面、系统提示词或核心配置。当前账户无此权限或权限暂时无法核验，操作未执行。普通用户请在独立项目中完成设计任务；用户配置请使用设置页面。";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.basename(moduleDirectory) === "permissions"
  ? path.resolve(moduleDirectory, "../..") : path.resolve(moduleDirectory, "..");
const runtimeRoot = path.basename(backendRoot) === "backend" && path.basename(path.dirname(backendRoot)) === "resources"
  ? path.resolve(backendRoot, "../..") : backendRoot;
const rootCache = new Map<string, string[]>();

function applicationRoots(cwd: string): string[] {
  const cached = rootCache.get(cwd);
  if (cached) return cached;
  const roots = [runtimeRoot];
  // A user may select another source checkout or a child of it as a project.
  for (let probe = path.resolve(cwd); ; probe = path.dirname(probe)) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(probe, "package.json"), "utf8"));
      if (pkg.name === "ccdagent" || pkg.name === "ccagent-desktop") roots.push(probe);
    } catch { /* Not an application package. */ }
    if (path.dirname(probe) === probe) break;
  }
  rootCache.set(cwd, roots);
  return roots;
}

function within(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function canonical(target: string): Promise<string> {
  let probe = target;
  while (true) {
    try { return path.resolve(await realpath(probe), path.relative(probe, target)); }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      const parent = path.dirname(probe);
      if (parent === probe) return target;
      probe = parent;
    }
  }
}

function expandPath(value: string): string {
  let expanded = value.replace(/^file:\/\//i, "");
  try { if (/^file:\/\//i.test(value)) expanded = fileURLToPath(value); } catch { /* Fall through to lexical guard. */ }
  expanded = expanded.replace(/^(?:~|\$HOME|\$env:USERPROFILE|%USERPROFILE%)(?=[\\/]|$)/i, homedir())
    .replace(/^(?:\$env:CCAGENT_HOME|\$CCAGENT_HOME|%CCAGENT_HOME%)(?=[\\/]|$)/i, getCCAgentHome());
  if (process.platform === "win32") {
    // Git Bash drive syntax, Win32 case/short-name/junction aliases and trailing dots.
    expanded = expanded.replace(/^\/([a-z])\//i, "$1:/").replace(/^\\\\\?\\/, "")
      .split(/[\\/]/).map(part => part === "." || part === ".." ? part : part.replace(/[ .]+$/, "")).join(path.sep);
  }
  return expanded;
}

/** Check real paths, including a non-existing leaf below a junction/symlink. */
export async function isProtectedApplicationPath(value: string, cwd: string): Promise<boolean> {
  const target = path.resolve(cwd, expandPath(value));
  const actual = await canonical(target);
  for (const root of new Set([...applicationRoots(cwd), ...applicationRoots(target), ...applicationRoots(actual)])) {
    const actualRoot = await canonical(root);
    // Also reject replacing/removing a parent of the installation.
    if (within(target, root) || within(root, target) || within(actual, actualRoot) || within(actualRoot, actual)) return true;
  }
  const configEntries = ["settings.json", "settings.local.json", "state.json", "mcp.json", ".env", "AGENT.md", "AGENTS.md", "agents", "skills", "commands", "hooks", "plugins", "output-styles", "platform"];
  for (const base of new Set([getCCAgentHome(), getPlatformHome()])) {
    const home = await canonical(base);
    if (within(home, actual) || configEntries.some(entry => within(actual, path.join(home, entry)))) return true;
  }
  // Project-local executable/configuration inputs affect the application too.
  const normalized = actual.replace(/\\/g, "/").toLowerCase();
  return /\/(?:\.ccagent|\.claude)\/(?:settings(?:\.local)?\.json|\.env|mcp\.json|agents|skills|commands|hooks|plugins|output-styles)(?:\/|$)/.test(normalized)
    || (within(actual, await canonical(cwd)) && /^(?:agent|agents)\.md$/i.test(path.basename(actual)));
}

const READ_TOOLS = new Set(["Read", "ReadImage", "AnalyzeData", "Grep", "Glob", "KnowledgeSearch", "WebSearch", "WebFetch", "classic_words", "ListMcpResources", "ReadMcpResource", "RhinoObserve", "RhinoInspect", "ComputerObserve"]);
const PATH_KEY = /^(?:file_?(?:path|name)|path|paths|output_?(?:path|dir|directory|file)|target_?path|destination(?:_path)?|directory|dir|folder|cwd|working_?directory)$/i;
const CODE_KEY = /^(?:command|commands|script|code|python_code|javascript|expression|text)$/i;

function explicitReadCommand(command: string): boolean {
  // This intentionally accepts only a single plain read command, not a shell parser.
  if (/[;|&<>`\r\n]/.test(command) || /\$\(|\$\{/.test(command)) return false;
  return /^(?:Get-Content|Get-Item|Get-ChildItem|Test-Path|Select-String|Get-FileHash|Get-Location|cat|head|tail|ls|pwd|rg|grep|stat|wc)(?:\s|$)/i.test(command.trim())
    && !/\s(?:--pre|--pre-glob|--exec|--files-from)(?:[=\s]|$)/i.test(command);
}

function pathsInCode(text: string): string[] {
  const result = new Set<string>();
  const looksLikePath = (s: string) => !/^https?:\/\//i.test(s) && !/[\r\n]/.test(s)
    && (/^(?:[a-z]:[\\/]|[\\/]|~[\\/]|\$env:|\$HOME|%USERPROFILE%|%CCAGENT_HOME%)/i.test(s)
      || /^[.\w@-]+[\\/][^<>|]*$/.test(s) || /^(?:[\w.-]+\.[\w.-]+|\.env|src|web|dist|desktop|rhino|node_modules|\.git|\.ccagent)$/i.test(s));
  const remainder = text.replace(/"([^"\r\n]*)"|'([^'\r\n]*)'/g, (whole, double: string | undefined, single: string | undefined) => {
    const value = (double ?? single ?? "").replace(/\\\\/g, "\\");
    if (looksLikePath(value) && !/["';(){}]/.test(value)) { result.add(value); return " "; }
    return whole; // An inline program may contain nested quoted file paths.
  });
  for (const token of remainder.split(/[\s"'`;|&()<>,={}\[\]]+/)) if (token && looksLikePath(token)) result.add(token);
  return [...result];
}

async function codeTargetsApplication(command: string, cwd: string): Promise<boolean> {
  if (explicitReadCommand(command)) return false;
  const targets = pathsInCode(command);
  for (const target of targets) if (await isProtectedApplicationPath(target, cwd)) return true;
  // Build/install/reset and other implicit-target mutations run in cwd.
  return targets.length === 0 && /\b(?:npm|npx|pnpm|yarn|git|python\w*|node|powershell|pwsh|cmd|bash|sh|rm|mv|cp|mkdir|touch|del|rmdir|Remove-Item|Set-Content|Add-Content|Out-File|New-Item|Move-Item|Copy-Item|Rename-Item|Invoke-Expression)\b/i.test(command)
    && await isProtectedApplicationPath(cwd, cwd);
}

export async function applicationProtectionReason(toolName: string, input: Record<string, unknown>, context: { cwd: string; applicationProtection?: boolean }): Promise<string | undefined> {
  if (!context.applicationProtection || READ_TOOLS.has(toolName)) return undefined;
  const visit = async (value: unknown, key = "", depth = 0): Promise<boolean> => {
    if (depth > 20) throw new Error("Application protection input nesting exceeds limit");
    if (typeof value === "string") {
      if (PATH_KEY.test(key) && value.trim() && await isProtectedApplicationPath(value, context.cwd)) return true;
      // Inline scripts and computer typing are checked without relying on an MCP readOnlyHint.
      return CODE_KEY.test(key) && await codeTargetsApplication(value, context.cwd);
    }
    if (Array.isArray(value)) { for (const item of value) if (await visit(item, key, depth + 1)) return true; }
    else if (value && typeof value === "object") {
      for (const [childKey, item] of Object.entries(value)) if (await visit(item, childKey, depth + 1)) return true;
    }
    return false;
  };
  // Importing an existing model is read-only with respect to its file.
  if (toolName === "RhinoAction" && input.action === "import_export" && (input.parameters as Record<string, unknown> | undefined)?.operation === "import") return undefined;
  return await visit(input) && !(await canMaintainApplication()) ? APPLICATION_PROTECTION_MESSAGE : undefined;
}

export async function assertApplicationProtection(toolName: string, input: Record<string, unknown>, context: { cwd: string; applicationProtection?: boolean }): Promise<void> {
  const reason = await applicationProtectionReason(toolName, input, context);
  if (reason) throw new Error(reason);
}
