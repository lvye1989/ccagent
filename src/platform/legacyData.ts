import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { getCCAgentHome, getCCAgentPath, getUserSettingsPath } from "../utils/paths.js";
import { getPlatformAccountClient, getPlatformHome, requirePlatformScope } from "./account.js";
import { withFileTransaction, writeJsonAtomically } from "../utils/fileTransaction.js";
import { resetSettingsCache } from "../config/sources.js";
import { SettingsSchema } from "../config/schema.js";
import { storeWebSecret, WEB_SECRET_FILE, WEB_SECRET_PREFIX } from "../utils/webSecrets.js";
import { normalizeFrontmatter, splitFrontmatter } from "../services/skills/parseFrontmatter.js";
import { getProjectPathInfo } from "../context/memory/memdir.js";

export const legacyCategories = ["configuration", "history", "extensions", "credentials"] as const;
type Category = typeof legacyCategories[number];
type Snapshot = { relative: string; category: Category; size: number; mtime: number; ino: number; dev: number };
type EnvironmentFile = { id: string; path: string; size: number; mtime: number; ino: number; dev: number; external: boolean };
type Report = { id: string; state: "complete" | "interrupted"; copied: number; conflicts: number; settingsAdded: number; missingCredentials: number; deferred: number; restartRequired: boolean };
type Plan = { version: 1; id: string; userId: string; origin: string; source: string; destination: string; createdAt: number;
  entries: Snapshot[]; environment: EnvironmentFile[]; canonicalEnvironment?: string; canonicalEnvironmentMissing?: boolean; selection?: string;
  skippedLinks: number; skippedCaches: number; configurationError: boolean; executionFields: number; report?: Report };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const roots: Record<Category, string[]> = {
  configuration: ["settings.json", "AGENT.md", "web-workspaces.json", "web-session-options"],
  history: ["projects", "file-history", "plans", "tasks", "teams", "workfriend", "web-schedules.json"],
  extensions: ["agents", "skills", "commands", "output-styles", "rhino"],
  credentials: ["oauth"],
};
const execution = new Set(["mode", "autoMode", "allow", "deny", "ask", "additionalDirectories", "hooks", "disableAllHooks", "apiKeyHelper", "statusLine", "enableAllProjectMcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers", "enabledPlugins"]);
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const secretField = (name: string) => /^(?:apiKey|api_key|key|clientSecret|client_secret|access_token|refresh_token|token|password|authorization|cookie|x-api-key)$/i.test(name);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const comparable = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const inside = (base: string, file: string) => comparable(file) === comparable(base) || comparable(file).startsWith(comparable(base) + path.sep);
const stamp = (info: Awaited<ReturnType<typeof lstat>>) => ({ size: Number(info.size), mtime: Number(info.mtimeMs), ino: Number(info.ino), dev: Number(info.dev) });
const same = (a: { size: number; mtime: number; ino: number; dev: number }, b: ReturnType<typeof stamp>) => a.size === b.size && a.mtime === b.mtime && a.ino === b.ino && a.dev === b.dev;
const planPath = (id: string) => { if (!uuid.test(id)) throw new Error("导入预览编号无效。"); return getCCAgentPath("imports", "plans", id + ".json"); };

function importableVariable(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|PATH|SHELL|ENV|BASH_ENV|TMP|TEMP|TMPDIR|CCAGENT_HOME|CCAGENT_ENV_FILE)$/i.test(name) &&
    !/^(?:CCAGENT_(?:PLATFORM|ACCOUNT|AUTH|DESKTOP|WEB_WORKER|CLOUD)|NODE_|SSL_|LD_|DYLD_|PYTHONPATH|DATABASE_|POSTGRES_|SUPABASE_|AUTH_|RESEND_|ZPAY_|PAYMENT_|CRON_|BLOB_|VERCEL_|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)/i.test(name);
}

async function regularFile(file: string, expected?: ReturnType<typeof stamp>, maximum = 2 * 1024 * 1024): Promise<Buffer> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum || (expected && !same(expected, stamp(info)))) throw new Error("来源文件已变化、不是普通文件或超出限制，请重新预览。");
  const handle = await open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    if (!same(stamp(info), stamp(await handle.stat()))) throw new Error("来源文件已变化，请重新预览。");
    const bytes = await handle.readFile();
    if (!same(stamp(info), stamp(await handle.stat()))) throw new Error("来源文件已变化，请重新预览。");
    return bytes;
  } finally { await handle.close(); }
}
async function jsonFile(file: string, maximum?: number): Promise<Record<string, unknown>> {
  try { const parsed: unknown = JSON.parse((await regularFile(file, undefined, maximum)).toString("utf8")); if (object(parsed)) return parsed; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; }
  throw new Error("配置文件格式无效，原文件已保留，请先修复后再导入。");
}
async function destination(file: string): Promise<string> {
  const logical = path.resolve(getCCAgentHome()), base = await realpath(logical), absolute = path.resolve(file);
  // Windows launchers may retain an 8.3 home path while realpath returns the
  // long form. Check either spelling, then build only under the canonical root.
  const relative = path.relative(inside(logical, absolute) ? logical : base, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("导入目标超出当前账户目录。");
  let current = base;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    if (!(await lstat(current)).isDirectory() || (await lstat(current)).isSymbolicLink() || !inside(base, await realpath(current))) throw new Error("导入目标包含链接目录，原文件已保留。");
  }
  return path.join(base, relative);
}

export async function previewLegacyData(sourceInput?: unknown) {
  const session = await requirePlatformScope(0), account = await getPlatformAccountClient();
  const supplied = sourceInput === undefined || sourceInput === "" ? getPlatformHome() : sourceInput;
  if (typeof supplied !== "string" || supplied.length > 4096 || !path.isAbsolute(supplied)) throw new Error("请提供原 CCAGENT 数据目录的绝对路径。");
  const sourceInfo = await lstat(supplied), source = await realpath(supplied), target = await realpath(getCCAgentHome());
  const accounts = path.join(await realpath(getPlatformHome()), "accounts");
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink() || inside(accounts, source) || inside(target, source) ||
    (path.basename(path.dirname(source)).toLowerCase() === "accounts" && /^[a-f0-9]{32}$/.test(path.basename(source)))) throw new Error("请选择尚未归属账户的原数据目录，不能导入其他账户目录。");
  const plan: Plan = { version: 1, id: randomUUID(), userId: session.user.id, origin: account.origin, source, destination: target, createdAt: Date.now(),
    entries: [], environment: [], skippedLinks: 0, skippedCaches: 0, configurationError: false, executionFields: 0 };
  let total = 0;
  async function walk(relative: string, category: Category, depth = 0) {
    if (depth > 32) throw new Error("来源目录层级过深，请分批整理后导入。");
    const full = path.join(source, relative), info = await lstat(full).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) return;
    if (info.isSymbolicLink()) { plan.skippedLinks++; return; }
    if (!inside(source, await realpath(full))) throw new Error("来源文件超出所选目录。");
    if (info.isDirectory()) {
      if (category === "extensions" && [".git", "node_modules", "__pycache__", ".venv", ".cache"].includes(path.basename(full))) { plan.skippedCaches++; return; }
      for (const name of await readdir(full)) await walk(path.join(relative, name), category, depth + 1);
    } else if (info.isFile()) {
      total += info.size;
      if (plan.entries.length >= 20000 || total > 16 * 1024 ** 3 || info.size > 2 * 1024 ** 3) throw new Error("来源数据过大，请分批整理后导入。");
      plan.entries.push({ relative: relative.split(path.sep).join("/"), category, ...stamp(info) });
    }
  }
  for (const category of legacyCategories) for (const root of roots[category]) await walk(root, category);
  let raw: Record<string, unknown> = {};
  try { raw = await jsonFile(path.join(source, "settings.json")); }
  catch { plan.configurationError = true; }
  plan.executionFields = Object.keys(raw).filter(key => execution.has(key)).length;
  const candidates = [path.join(source, ".env"), path.join(source, WEB_SECRET_FILE)];
  const canonicalEnv = object(raw.env) && typeof raw.env.CCAGENT_ENV_FILE === "string" && !raw.env.CCAGENT_ENV_FILE.includes("${") ? path.resolve(source, raw.env.CCAGENT_ENV_FILE) : undefined;
  if (canonicalEnv) candidates.push(canonicalEnv);
  for (const file of candidates) {
    const info = await lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    const canonical = await realpath(file);
    if (plan.environment.some(item => comparable(item.path) === comparable(canonical))) continue;
    plan.environment.push({ id: createHash("sha256").update(canonical).digest("hex").slice(0, 24), path: canonical, external: !inside(source, canonical), ...stamp(info) });
  }
  if (canonicalEnv) { const canonical = await realpath(canonicalEnv).catch(() => ""); plan.canonicalEnvironment = plan.environment.find(item => comparable(item.path) === comparable(canonical))?.id; plan.canonicalEnvironmentMissing = !plan.canonicalEnvironment; }
  await destination(planPath(plan.id)); await writeJsonAtomically(planPath(plan.id), plan);
  return { id: plan.id, source, destination: target, expiresAt: new Date(plan.createdAt + 15 * 60_000).toISOString(), historyDisabled: (await jsonFile(getUserSettingsPath())).cleanupPeriodDays === 0,
    categories: legacyCategories.map(id => ({ id, files: plan.entries.filter(entry => entry.category === id).length + (id === "credentials" ? plan.environment.length + (plan.entries.some(entry => entry.relative === "settings.json") ? 1 : 0) : 0),
      bytes: plan.entries.filter(entry => entry.category === id).reduce((sum, entry) => sum + entry.size, 0) + (id === "credentials" ? plan.environment.reduce((sum, item) => sum + item.size, 0) : 0) })),
    environmentFiles: plan.environment.map(({ id, path, external, size }) => ({ id, path, external, size })),
    skippedLinks: plan.skippedLinks, skippedCaches: plan.skippedCaches, configurationError: plan.configurationError, executionFields: plan.executionFields, canonicalEnvironmentMissing: plan.canonicalEnvironmentMissing };
}

export async function importLegacyData(input: { id?: unknown; categories?: unknown; environmentFiles?: unknown; confirmOwned?: unknown; enableHistory?: unknown }): Promise<Report> {
  const session = await requirePlatformScope(0), account = await getPlatformAccountClient();
  if (typeof input.id !== "string" || input.confirmOwned !== true || !Array.isArray(input.categories) || !input.categories.length ||
    input.categories.some(category => !legacyCategories.includes(category as Category)) || !Array.isArray(input.environmentFiles) || input.environmentFiles.some(id => typeof id !== "string")) throw new Error("请先预览，选择类别，并确认原数据属于当前账户。");
  const file = await destination(planPath(input.id)), selected = new Set(input.categories as Category[]), approvedEnvironment = new Set(input.environmentFiles as string[]);
  return withFileTransaction(file, async () => {
    const plan = await jsonFile(file, 64 * 1024 * 1024) as unknown as Plan;
    if (plan.version !== 1 || plan.id !== input.id || plan.userId !== session.user.id || plan.origin !== account.origin || comparable(plan.destination) !== comparable(await realpath(getCCAgentHome()))) throw new Error("导入预览不属于当前账户。");
    const selection = digest({ categories: [...selected].sort(), environmentFiles: [...approvedEnvironment].sort(), enableHistory: input.enableHistory === true });
    if (plan.selection && plan.selection !== selection) throw new Error("此预览已用于其他选择，请重新扫描后导入。");
    if (plan.report) return plan.report;
    if (Date.now() - plan.createdAt > 15 * 60_000 || Date.now() < plan.createdAt) throw new Error("导入预览已过期，请重新扫描。");
    if (plan.configurationError && selected.has("configuration")) throw new Error("来源 settings.json 需要修复，原文件已保留；可单独导入历史数据。");
    if ([...approvedEnvironment].some(id => !plan.environment.some(item => item.id === id))) throw new Error("环境文件不在此次预览范围内。");
    plan.selection = selection; await writeJsonAtomically(file, plan);
    const report: Report = { id: plan.id, state: "interrupted", copied: 0, conflicts: 0, settingsAdded: 0, missingCredentials: 0, deferred: plan.executionFields, restartRequired: selected.has("configuration") || selected.has("extensions") || selected.has("credentials") };
    const stage = await destination(getCCAgentPath("imports", "staging", plan.id, "placeholder"));
    const stageRoot = path.dirname(stage);
    try {
      await mkdir(stageRoot, { recursive: true, mode: 0o700 });
      const variables: Record<string, string> = {};
      let raw: Record<string, unknown> = {};
      const configuration = plan.entries.find(entry => entry.relative === "settings.json");
      if (configuration && !plan.configurationError && (selected.has("configuration") || selected.has("credentials"))) {
        const value: unknown = JSON.parse((await regularFile(path.join(plan.source, "settings.json"), configuration)).toString("utf8"));
        if (!object(value)) throw new Error("来源配置已变化，请重新预览。"); raw = value;
      }
      const canonical = plan.environment.find(item => item.id === plan.canonicalEnvironment);
      const canonicalAvailable = !plan.canonicalEnvironmentMissing && (!canonical || !canonical.external || approvedEnvironment.has(canonical.id));
      if (selected.has("credentials") && canonicalAvailable) {
        if (object(raw.env)) for (const [key, value] of Object.entries(raw.env)) if (importableVariable(key) && typeof value === "string") variables[key] = value;
        for (const env of plan.environment) if (!env.external || approvedEnvironment.has(env.id)) {
          if (canonical && env.id !== canonical.id && path.basename(env.path) === ".env") continue;
          const parsed = dotenv.parse(await regularFile(env.path, env));
          for (const [key, value] of Object.entries(parsed)) if (importableVariable(key) && value) variables[key] = value;
        }
      }
      if (Object.keys(variables).length > 1024) throw new Error("环境变量过多，请分批整理后导入。");
      const staged: { entry: Snapshot; file: string }[] = [];
      const resolveSource = (value: string): string => {
        const visited = new Set<string>();
        for (let index = 0; index < 20; index++) {
          const ref = /^\$\{(CCAGENT_WEB_KEY_[A-Z0-9_]+)\}$/.exec(value);
          if (!ref) return value;
          if (visited.has(ref[1]!) || !variables[ref[1]!]) return "";
          visited.add(ref[1]!); value = variables[ref[1]!]!;
        }
        return "";
      };
      // Validate and stage the entire chosen source before exposing new account files.
      for (const entry of plan.entries.filter(item => selected.has(item.category))) {
        if (entry.relative === "settings.json" || entry.relative === "web-schedules.json" || entry.relative === "workfriend/schedules.json") continue;
        const origin = path.resolve(plan.source, entry.relative);
        if (!inside(plan.source, origin) || !inside(plan.source, await realpath(origin)) || !same(entry, stamp(await lstat(origin))) || (await lstat(origin)).isSymbolicLink()) throw new Error("来源文件已变化，请重新预览。");
        const stagedFile = path.join(stageRoot, entry.relative); await destination(stagedFile);
        await copyFile(origin, stagedFile, constants.COPYFILE_EXCL); await chmod(stagedFile, 0o600);
        if (!same(entry, stamp(await lstat(origin)))) throw new Error("来源文件在复制时发生变化，请重新预览。");
        await utimes(stagedFile, new Date(), new Date()); staged.push({ entry, file: stagedFile });
      }
      // Preserve the original project layout and also make Windows path aliases
      // discoverable through the workspace spelling used by the current UI.
      const aliases = new Map<string, Set<string>>(), transcriptAliases = new Map<string, string>();
      for (const item of staged) if (/^projects\/[^/]+\/[a-f0-9-]{36}\.jsonl$/.test(item.entry.relative)) {
        const handle = await open(item.file, "r");
        try {
          const buffer = Buffer.alloc(64 * 1024), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const meta: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0]!);
          if (!object(meta) || meta.type !== "session_meta" || typeof meta.cwd !== "string" || !path.isAbsolute(meta.cwd) || meta.sessionId !== path.basename(item.entry.relative, ".jsonl")) continue;
          const workspace = await realpath(meta.cwd), key = (await getProjectPathInfo(workspace)).projectKey, old = item.entry.relative.split("/")[1]!;
          if (old !== key) { const keys = aliases.get(old) ?? new Set<string>(); keys.add(key); aliases.set(old, keys); transcriptAliases.set(item.entry.relative, key); }
        } catch { /* Unavailable workspaces and malformed transcripts retain their original layout. */ }
        finally { await handle.close(); }
      }
      await requirePlatformScope(0);
      await withFileTransaction(getUserSettingsPath(), async () => {
        // Serialize retention changes with file installation so imported history
        // cannot be reported complete while the current account discards sessions.
        const target = await jsonFile(getUserSettingsPath());
        if (selected.has("history") && target.cleanupPeriodDays === 0 && input.enableHistory !== true) throw new Error("当前已关闭会话保存；请先开启会话保存，或勾选导入后保留会话。");
        if (selected.has("history") && target.cleanupPeriodDays === 0 && input.enableHistory === true) target.cleanupPeriodDays = 30;
        const installed = new Set<string>();
        for (const item of staged) {
          const relativePaths = [item.entry.relative], parts = item.entry.relative.split("/");
          const candidates = parts[0] === "projects" ? aliases.get(parts[1]!) : undefined;
          const key = candidates?.size === 1 ? [...candidates][0] : transcriptAliases.get(item.entry.relative);
          if (key) relativePaths.push(["projects", key, ...parts.slice(2)].join("/"));
          for (const relative of relativePaths) {
            const target = await destination(path.join(plan.destination, relative));
            try { await link(item.file, target); report.copied++; installed.add(relative); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; report.conflicts++; }
          }
        }
        if (selected.has("history")) await mergeSchedules(plan, report);
        const secret = async (identity: string, value: string) => {
          if (!selected.has("credentials") || !value || value.length > 8192 || /[\r\n\0]/.test(value)) { report.missingCredentials++; return "${CCAGENT_IMPORT_UNSET_" + createHash("sha256").update(plan.id + identity).digest("hex").slice(0, 24).toUpperCase() + "}"; }
          return storeWebSecret("import:" + plan.id + ":" + identity, value);
        };
        async function sanitize(value: unknown, field = "", identity = "root", depth = 0, sensitive = false): Promise<unknown> {
          if (depth > 30) throw new Error("配置层级过深，请整理后导入。");
          if (typeof value === "string") {
            if (/^(clientIdEnv|clientSecretEnv)$/i.test(field)) { const ref = await secret(identity, resolveSource(variables[value] || "")); return ref.slice(2, -1); }
            const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback: string | undefined) => resolveSource(variables[name] || "") || fallback || `\u0001${name}\u0001`);
            if (secretField(field) || sensitive) return value ? secret(identity, expanded.includes("\u0001") ? "" : expanded) : "";
            const matches = [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g)];
            let rewritten = value;
            for (const match of matches) rewritten = rewritten.replace(match[0], await secret(identity + ":" + match[1], resolveSource(variables[match[1]!] || "") || match[2] || ""));
            return rewritten;
          }
          if (Array.isArray(value)) return Promise.all(value.map((item, index) => sanitize(item, field, identity + ":" + index, depth + 1, sensitive)));
          if (object(value)) { const next: Record<string, unknown> = {}; for (const [key, item] of Object.entries(value)) if (!forbidden.has(key)) next[key] = await sanitize(item, key, identity + ":" + key, depth + 1, sensitive || ["headers", "env"].includes(field)); return next; }
          return value;
        }
        if (selected.has("configuration")) {
          for (const [key, value] of Object.entries(raw)) {
            if (forbidden.has(key) || execution.has(key) || ["env", "agentStates", "skillStates", "mcpServerStates"].includes(key) || (key === "cleanupPeriodDays" && value === 0)) continue;
            if (["models", "mcpServers", "modelRoles"].includes(key) && object(value)) {
              const entries = object(target[key]) ? target[key] as Record<string, unknown> : {};
              for (const [id, definition] of Object.entries(value)) if (!forbidden.has(id) && !id.startsWith("ccagent:")) {
                const prior = entries[id], marker = object(prior) && object(prior.legacyImport) ? prior.legacyImport : undefined;
                const repair = ["models", "mcpServers"].includes(key) && selected.has("credentials") && object(prior) && (key !== "models" || prior.disabled === true) && marker?.source === digest(plan.source) && marker.definition === digest(definition) && marker.snapshot === digest(Object.fromEntries(Object.entries(prior).filter(([name]) => name !== "legacyImport")));
                if (Object.hasOwn(entries, id) && !repair) continue;
                const before = report.missingCredentials;
                const imported = await sanitize(definition, "", key + ":" + id);
                if (object(imported) && report.missingCredentials > before) { if (key === "models") imported.disabled = true; imported.legacyImport = { source: digest(plan.source), definition: digest(definition), snapshot: digest(imported) }; }
                entries[id] = imported; report.settingsAdded++;
                if (key === "mcpServers") { const states = object(target.mcpServerStates) ? target.mcpServerStates : {}; if (!Object.hasOwn(states, id)) states[id] = "close"; target.mcpServerStates = states; }
              }
              target[key] = entries;
            } else if (["ragConnections", "agentTeamPresets"].includes(key) && Array.isArray(value)) {
              const entries = Array.isArray(target[key]) ? target[key] as unknown[] : [];
              for (const definition of value) if (object(definition) && typeof definition.id === "string") {
                const index = entries.findIndex(item => object(item) && item.id === definition.id), prior = entries[index];
                const marker = object(prior) && object(prior.legacyImport) ? prior.legacyImport : undefined;
                const repair = selected.has("credentials") && object(prior) && marker?.source === digest(plan.source) && marker.definition === digest(definition) && marker.snapshot === digest(Object.fromEntries(Object.entries(prior).filter(([name]) => name !== "legacyImport")));
                if (index >= 0 && !repair) continue;
                const before = report.missingCredentials;
                const imported = { ...await sanitize(definition, "", key + ":" + definition.id) as Record<string, unknown>, enabled: false };
                if (report.missingCredentials > before) Object.assign(imported, { legacyImport: { source: digest(plan.source), definition: digest(definition), snapshot: digest(imported) } });
                if (index >= 0) entries[index] = imported; else entries.push(imported);
                report.settingsAdded++;
              }
              target[key] = entries;
            } else if (!Object.hasOwn(target, key)) { target[key] = await sanitize(value, key, key); report.settingsAdded++; }
          }
        }
        if (selected.has("credentials")) {
          const env = object(target.env) ? target.env : {};
          for (const [name, value] of Object.entries(variables)) if (!name.startsWith(WEB_SECRET_PREFIX) && !Object.hasOwn(env, name) && name !== "DEEPSEEK_API_KEY") { env[name] = await secret("env:" + name, resolveSource(value)); report.settingsAdded++; }
          if (!env.CCAGENT_ENV_FILE && !process.env.CCAGENT_ENV_FILE && variables.DEEPSEEK_API_KEY) {
            const envFile = await destination(getCCAgentPath("imports", plan.id + ".env"));
            // Other provider variables stay namespaced and cannot replace
            // existing account settings through canonical-file precedence.
            await writeFile(envFile, `DEEPSEEK_API_KEY=${JSON.stringify(resolveSource(variables.DEEPSEEK_API_KEY))}\n`, { flag: "wx", mode: 0o600 });
            env.CCAGENT_ENV_FILE = envFile;
          }
          target.env = env;
        }
        if (selected.has("extensions")) for (const [root, key] of [["agents", "agentStates"], ["skills", "skillStates"]]) {
          const states = object(target[key!]) ? target[key!] as Record<string, unknown> : {};
          for (const item of staged.filter(item => installed.has(item.entry.relative) && item.entry.relative.startsWith(root + "/"))) {
            if (root === "skills" && path.basename(item.entry.relative) !== "SKILL.md") continue;
            let name = root === "agents" ? path.basename(item.entry.relative, ".md") : item.entry.relative.split("/")[1]!;
            if (root === "agents" || root === "skills") {
              const split = splitFrontmatter((await regularFile(item.file)).toString("utf8"));
              name = root === "skills" ? normalizeFrontmatter(split.raw, split.body).name || name : typeof split.raw.name === "string" ? split.raw.name : name;
            }
            if (forbidden.has(name)) continue;
            if (!Object.hasOwn(states, name)) states[name] = "close";
          }
          target[key!] = states;
        }
        if (!SettingsSchema.safeParse(target).success) throw new Error("导入配置需要修复，当前配置保持原状。");
        await requirePlatformScope(0); await destination(getUserSettingsPath()); await writeJsonAtomically(getUserSettingsPath(), target); resetSettingsCache();
      });
      report.state = "complete"; plan.report = report; await writeJsonAtomically(file, plan);
      return report;
    } catch {
      plan.report = report; await writeJsonAtomically(file, plan);
      throw new Error("导入未全部完成，已复制的记录和原文件均已保留。请重新预览后继续；导入报告保存在当前账户目录。");
    } finally {
      const stagingBase = await realpath(getCCAgentPath("imports", "staging"));
      if (inside(stagingBase, stageRoot) && path.basename(stageRoot) === plan.id) await rm(stageRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}

async function mergeSchedules(plan: Plan, report: Report) {
  for (const relative of ["web-schedules.json", "workfriend/schedules.json"]) {
    const entry = plan.entries.find(item => item.relative === relative); if (!entry) continue;
    let parsed: unknown;
    try { parsed = JSON.parse((await regularFile(path.join(plan.source, relative), entry)).toString("utf8")); } catch { report.deferred++; continue; }
    const web = relative === "web-schedules.json", rows = web ? parsed : object(parsed) ? parsed.schedules : undefined;
    if (!Array.isArray(rows) || rows.some(item => !object(item) || typeof item.id !== "string" || (web ?
      !uuid.test(item.id) || !["workspace", "title", "prompt", "model", "createdAt", "nextRunAt"].every(key => typeof item[key] === "string") ||
        !Number.isFinite(Date.parse(String(item.nextRunAt))) || !["none", "daily", "weekly"].includes(String(item.repeat)) :
      !["cwd", "workdayEnd", "workSummary", "moodSummary", "createdAt", "checkInAt"].every(key => typeof item[key] === "string") ||
        !Number.isFinite(Date.parse(String(item.checkInAt))) || !["pending", "fired", "cancelled"].includes(String(item.status))))) { report.deferred++; continue; }
    const file = await destination(path.join(plan.destination, relative));
    await withFileTransaction(file, async () => {
      let previous: unknown;
      try { previous = JSON.parse((await regularFile(file)).toString("utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const existing = previous === undefined ? [] : web ? previous : object(previous) ? previous.schedules : undefined;
      if (!Array.isArray(existing)) throw new Error("当前定时任务格式无效，原文件已保留。");
      for (const item of rows as Record<string, unknown>[]) {
        if (existing.some(other => object(other) && other.id === item.id)) { report.conflicts++; continue; }
        const next = { ...item };
        if (web) { next.status = "paused"; next.mode = ["default", "plan", "auto"].includes(String(next.mode)) ? next.mode : "default"; delete next.runOwner; delete next.runId; next.lastError = "从原数据导入，已暂停。请核对内容后手动启用。"; }
        else if (next.status === "pending") next.status = "cancelled";
        existing.push(next); report.copied++;
      }
      await writeJsonAtomically(file, web ? existing : { version: 1, schedules: existing });
    });
  }
}
