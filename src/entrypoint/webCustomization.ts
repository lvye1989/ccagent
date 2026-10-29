/** Web editors write the same definitions and settings consumed by the CLI. */
import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getUserSettingsPath, getCCAgentPath } from "../utils/paths.js";
import { readJsonSettingsFile, updateUserSettings } from "../utils/settings.js";
import { loadSettingSources } from "../config/sources.js";
import { loadProfiles } from "../services/api/providers/profile.js";
import { streamMessage } from "../services/api/streaming.js";
import { getAllAgents } from "../agents/registry.js";
import { getProjectAgentsDir, getUserAgentsDir } from "../agents/loadAgentsDir.js";
import { loadSkillsFromDir, getProjectSkillsDir, getUserSkillsDir } from "../services/skills/loadSkillsDir.js";
import { validateServerConfig, loadMcpConfigs } from "../services/mcp/config.js";
import { storeWebSecret, resolveWebSecret } from "../utils/webSecrets.js";
import { loadRagConnections, searchRag, validateServiceUrl, type RagConnection } from "../services/rag.js";
import { getActiveTeam } from "../state/teamContext.js";
import { splitFrontmatter } from "../services/skills/parseFrontmatter.js";
import { stringify as yamlStringify } from "yaml";
import { isAgentTeamsEnabled } from "../utils/agentTeamsEnabled.js";

export interface TeamRole { name: string; prompt: string; agentType: string }
export interface TeamPreset { id: string; name: string; description: string; enabled: boolean; roles: TeamRole[] }
export interface CustomizationContext { workspace: string; defaultModel: string }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error(`${label} is required (up to ${max} characters).`);
  return value.trim();
}
export function safeDefinitionName(value: unknown): string {
  const name = text(value, "Name", 64);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.endsWith(".") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || ["__proto__", "prototype", "constructor"].includes(name)) throw new Error("Use a safe name containing letters, numbers, dots, underscores or hyphens.");
  return name;
}
export async function userSettings(): Promise<Record<string, unknown>> {
  const { raw, parseError } = await readJsonSettingsFile<Record<string, unknown>>(getUserSettingsPath());
  if (parseError || (raw !== null && (typeof raw !== "object" || Array.isArray(raw)))) throw new Error("Repair user settings.json before saving; it was left untouched.");
  return raw ?? {};
}
function map(value: unknown): Record<string, unknown> { return value === undefined ? {} : object(value); }
async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temp, file);
}

export async function listTeamPresets(): Promise<TeamPreset[]> {
  const config = await userSettings();
  return Array.isArray(config.agentTeamPresets) ? config.agentTeamPresets as TeamPreset[] : [];
}
export async function sessionTeamInstructions(selection: string): Promise<string> {
  if (selection === "off") return "Agent Teams is disabled for this conversation. Do not create a team or spawn named teammates.";
  if (!isAgentTeamsEnabled()) throw new Error("Agent Teams is closed globally. Enable it in Agent Teams first.");
  const common = "The user selected Agent Teams for this conversation. Use TeamCreate, Agent with team_name/name/run_in_background, and SendMessage to coordinate actual teammates. Collect their results before answering, then TeamDelete when all are finished. All tools retain the current permission rules. If a preset role needs a custom instruction, include it in that teammate's prompt.";
  if (selection === "auto") return common + " Choose and compose the team roles from the user's current task. Explain the division of work briefly and create the team when work requires it.";
  const preset = (await listTeamPresets()).find((p) => p.id === selection && p.enabled);
  if (!preset) throw new Error("Selected team is missing or disabled.");
  return common + `\nTeam preset: ${preset.name}\nMission: ${preset.description}\nRoles:\n` + preset.roles.map((r) => `- ${r.name} (subagent_type=${r.agentType}): ${r.prompt}`).join("\n");
}
function optionsFile(workspace: string) { return getCCAgentPath("web-session-options", createHash("sha256").update(workspace).digest("hex") + ".json"); }
export async function readSessionTeam(workspace: string, id: string): Promise<string> {
  try { return JSON.parse(await readFile(optionsFile(workspace), "utf8"))[id] ?? "off"; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return "off"; throw e; }
}
export async function saveSessionTeam(workspace: string, id: string, selection: string): Promise<void> {
  let values: Record<string, string> = {};
  try { values = JSON.parse(await readFile(optionsFile(workspace), "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  values[id] = selection;
  await atomicJson(optionsFile(workspace), values);
}

export async function modelText(model: string, prompt: string, system: string): Promise<string> {
  const profiles = (await loadProfiles()).profiles;
  if (!Object.hasOwn(profiles, model)) throw new Error("Choose a configured model in Settings first.");
  const stream = streamMessage({ model, messages: [{ role: "user", content: prompt }], system, maxTokens: 4000, thinking: { type: "disabled" }, signal: AbortSignal.timeout(60000), querySource: "foreground" });
  let output = "";
  try {
    while (true) {
      const next = await stream.next();
      if (next.done) {
        if (next.value.stopReason === "error" || !output.trim()) throw new Error("No model output.");
        return output;
      }
      if (next.value.type === "text") output += next.value.text;
      if (output.length > 60000) throw new Error("Model output too large.");
    }
  } catch {
    throw new Error("Model request failed or timed out. Check endpoint, protocol, model and API key in Settings.");
  } finally { await stream.return(undefined as never); }
}
function parseDraft(output: string): Record<string, unknown> {
  const value = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return object(JSON.parse(value)); } catch { throw new Error("The model did not return valid JSON. Retry or edit the fields manually."); }
}

async function draft(body: Record<string, unknown>, context: CustomizationContext) {
  const kind = body.kind;
  const request = text(body.request, "Requirements", 12000);
  if (kind === "mcp") {
    try {
      const raw = object(JSON.parse(request));
      const servers = raw.mcpServers ? object(raw.mcpServers) : null;
      if (servers) {
        const entries = Object.entries(servers);
        if (entries.length !== 1) throw new Error("Add one MCP server at a time.");
        return { name: entries[0]![0], config: entries[0]![1] };
      }
      if (raw.config) return raw;
      return { name: body.name || "custom-mcp", config: raw };
    } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
    if (/^https?:\/\/\S+$/.test(request)) {
      const url = validateServiceUrl(request);
      return { name: new URL(url).hostname.replace(/[^a-zA-Z0-9-]/g, "-") + "-mcp", config: { type: "http", url } };
    }
  }
  const formats: Record<string, string> = {
    agent: '{"name":"safe-ascii-id","description":"when to use","prompt":"full agent instructions","tools":"Read,Glob,Grep"}',
    team: '{"id":"safe-ascii-id","name":"team display name","description":"mission","roles":[{"name":"safe-ascii-role","agentType":"general-purpose","prompt":"role instructions"}]}',
    mcp: '{"name":"safe-ascii-id","config":{"type":"stdio","command":"npx","args":["-y","official-package"]}} or {"name":"id","config":{"type":"http","url":"https://..."}}',
  };
  if (!formats[String(kind)]) throw new Error("Unknown draft type.");
  const schema = formats[String(kind)];
  return parseDraft(await modelText(typeof body.model === "string" ? body.model : context.defaultModel, request,
    `You edit CCAGENT configuration. Return exactly one JSON object, no Markdown, with this shape: ${schema}. Use the user's language for prose. Never run tools or commands. Never invent credentials. MCP requires a concrete package, URL or command; if insufficient details, return {"error":"explain what the user must supply"}. Agent tool names are Read, Write, Edit, Bash, Glob, Grep, PowerShell, WebFetch, WebSearch, KnowledgeSearch. Available agent types: ${getAllAgents().map((a) => a.agentType).join(", ")}. Teams have 1-8 roles.`));
}

async function saveAgent(body: Record<string, unknown>, context: CustomizationContext) {
  const name = safeDefinitionName(body.name);
  const description = text(body.description, "Description");
  const prompt = text(body.prompt, "Instructions", 30000);
  const scope = body.scope === "user" ? "user" : "project";
  const dir = scope === "user" ? getUserAgentsDir() : getProjectAgentsDir(context.workspace);
  const existing = getAllAgents().find((agent) => agent.agentType === name);
  const edit = body.edit === true;
  if (!edit && existing) throw new Error("An Agent with this name already exists. Choose another name or edit it.");
  if (edit && (!existing || existing.source !== scope || !existing.filePath)) throw new Error("Only the original user or project Agent can be edited.");
  const file = edit ? existing!.filePath! : path.join(dir, name + ".md");
  if (path.dirname(file) !== dir) throw new Error("Agent file is outside its definition directory.");
  await mkdir(dir, { recursive: true });
  if ((await lstat(file).catch(() => null))?.isSymbolicLink()) throw new Error("Cannot edit a linked Agent file.");
  const tools = typeof body.tools === "string" ? body.tools.split(",").map((v) => v.trim()).filter(Boolean) : [];
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
  if (model && !Object.hasOwn((await loadProfiles(context.workspace)).profiles, model)) throw new Error("Agent model must be a configured profile, or leave it blank to inherit.");
  const previous = edit ? splitFrontmatter(await readFile(file, "utf8")) : undefined;
  if (previous?.parseError) throw new Error("Agent frontmatter is invalid; existing file was preserved.");
  const metadata = { ...previous?.raw, name, description, tools: tools.length ? tools : undefined, model };
  const content = "---\n" + yamlStringify(metadata) + "---\n" + prompt + "\n";
  if (edit) {
    const tmp = file + "." + randomUUID() + ".tmp";
    await writeFile(tmp, content, { flag: "wx" }); await rename(tmp, file);
  } else await writeFile(file, content, { flag: "wx" });
  return { name, scope };
}

async function importLocalSkill(body: Record<string, unknown>, context: CustomizationContext) {
  let source = path.resolve(text(body.path, "Local skill path", 4096));
  if ((await lstat(source)).isFile()) { if (path.basename(source).toLowerCase() !== "skill.md") throw new Error("Choose SKILL.md or its directory."); source = path.dirname(source); }
  const loaded = await loadSkillsFromDir(source, "user");
  const skill = loaded.skills.find((s) => path.dirname(s.filePath) === source || s.baseDir === source || path.basename(s.baseDir) === path.basename(source));
  if (!skill) throw new Error("No valid SKILL.md in the selected directory.");
  const name = safeDefinitionName(skill.name);
  const destination = path.join(body.scope === "user" ? getUserSkillsDir() : getProjectSkillsDir(context.workspace), name);
  const canonical = await realpath(source);
  if (destination === canonical || destination.startsWith(canonical + path.sep)) throw new Error("Source cannot contain the installation directory.");
  const stage = destination + "." + randomUUID() + ".tmp";
  let count = 0, total = 0;
  try {
    await cp(source, stage, { recursive: true, errorOnExist: true, force: false, filter: async (src) => {
      const info = await lstat(src);
      if (info.isSymbolicLink()) throw new Error("Linked files cannot be imported; copy a regular skill folder.");
      if ([".git", "node_modules", ".env"].includes(path.basename(src))) return false;
      total += info.isFile() ? info.size : 0;
      if (++count > 2000 || total > 20 * 1024 * 1024) throw new Error("Skill package exceeds 2000 files or 20 MB.");
      return true;
    } });
    await mkdir(path.dirname(destination), { recursive: true });
    if (await lstat(destination).then(() => true, () => false)) throw new Error("Skill already exists; existing files were preserved.");
    await rename(stage, destination);
  } catch (error) { await rm(stage, { force: true, recursive: true }); throw error; }
  return { name };
}

function publicUrl(value: string | undefined): string {
  if (!value) return "";
  try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); } catch { return ""; }
}
async function modelsView(context: CustomizationContext) {
  const { profiles } = await loadProfiles(context.workspace);
  const own = map((await userSettings()).models);
  return { defaultModel: context.defaultModel, models: Object.values(profiles).map((p) => ({ id: p.id, protocol: p.protocol, model: p.model, baseURL: publicUrl(p.baseURL), hasKey: Boolean(p.apiKey), maxTokens: p.maxTokens, contextWindow: p.contextWindow, editable: Object.hasOwn(own, p.id) })) };
}
async function saveModel(body: Record<string, unknown>, context: CustomizationContext) {
  const config = await userSettings();
  const id = safeDefinitionName(body.id);
  const models = map(config.models);
  if (!["anthropic", "openai-chat", "openai-responses", "gemini"].includes(String(body.protocol))) throw new Error("Choose a supported protocol.");
  const endpoint = validateServiceUrl(text(body.baseURL, "API address", 4096)).replace(/\/$/, "");
  if (new URL(endpoint).search) throw new Error("API address cannot contain query credentials.");
  const old = models[id] ? object(models[id]) : {};
  const next: Record<string, unknown> = { ...old, protocol: body.protocol, model: text(body.model, "Model name", 200), baseURL: endpoint };
  for (const key of ["maxTokens", "contextWindow"]) {
    const value = body[key];
    if (value !== undefined && value !== "") { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1 || n > 10000000) throw new Error(`Invalid ${key}.`); next[key] = n; }
    else if (value === "") delete next[key];
  }
  if (typeof body.apiKey === "string" && body.apiKey.trim()) next.apiKey = await storeWebSecret("model:" + id, body.apiKey);
  else if (!old.apiKey) next.apiKey = "";
  await updateUserSettings({ models: { ...models, [id]: next }, ...(body.makeDefault === true ? { model: id, defaultModel: id } : {}) });
  return { id };
}

export async function handleCustomization(resource: string, method: string, body: Record<string, unknown>, context: CustomizationContext): Promise<unknown> {
  if (method === "GET") {
    if (resource === "models") return modelsView(context);
    if (resource === "teams") return { teams: await listTeamPresets(), enabled: isAgentTeamsEnabled(), activeTeam: getActiveTeam()?.teamName ?? null };
    if (resource === "rag") return { connections: (await loadRagConnections()).map(({ apiKey, ...c }) => ({ ...c, hasKey: Boolean(resolveWebSecret(apiKey)) })) };
    if (resource === "settings") {
      const sources = await loadSettingSources(context.workspace);
      const effective = Object.assign({}, ...sources.map((s) => s.raw ?? {}));
      return { settings: Object.fromEntries(["language", "effortLevel", "alwaysThinkingEnabled", "cleanupPeriodDays", "mode", "outputStyle", "prefersReducedMotion"].map((key) => [key, effective[key]])), settingsPath: getUserSettingsPath(), defaultModel: context.defaultModel };
    }
    throw new Error("Unknown customization resource.");
  }
  if (method !== "POST") throw new Error("Method not supported.");
  if (resource === "draft") { const result = await draft(body, context); if (result.error) throw new Error(String(result.error)); return result; }
  if (resource === "agents") return saveAgent(body, context);
  if (resource === "local-skill") return importLocalSkill(body, context);
  if (resource === "models") return saveModel(body, context);
  if (resource === "model-test") {
    const selected = text(body.id, "Model profile", 64);
    return { ok: true, reply: (await modelText(selected, "Reply with OK only.", "This is a connection test. No tools.")).slice(0, 500) };
  }
  const config = await userSettings();
  if (resource === "settings") {
    const patch: Record<string, unknown> = {};
    if (body.language !== undefined) patch.language = text(body.language, "Language", 80);
    if (body.outputStyle !== undefined) patch.outputStyle = text(body.outputStyle, "Output style", 80);
    if (body.effortLevel !== undefined) { if (!["low", "medium", "high", "max"].includes(String(body.effortLevel))) throw new Error("Invalid effort level."); patch.effortLevel = body.effortLevel; }
    if (body.mode !== undefined) { if (!["default", "plan", "auto", "full"].includes(String(body.mode))) throw new Error("Invalid permission mode."); patch.mode = body.mode; }
    for (const key of ["alwaysThinkingEnabled", "prefersReducedMotion"]) if (body[key] !== undefined) { if (typeof body[key] !== "boolean") throw new Error(`Invalid ${key}.`); patch[key] = body[key]; }
    if (body.cleanupPeriodDays !== undefined) { if (!Number.isInteger(body.cleanupPeriodDays) || Number(body.cleanupPeriodDays) < 0 || Number(body.cleanupPeriodDays) > 3650) throw new Error("Retention must be 0–3650 days."); patch.cleanupPeriodDays = body.cleanupPeriodDays; }
    await updateUserSettings(patch); return { ok: true };
  }
  if (resource === "mcp") {
    const name = safeDefinitionName(body.name);
    if (Object.hasOwn((await loadMcpConfigs(context.workspace)).servers, name)) throw new Error("An MCP server with this name already exists.");
    const parsed = validateServerConfig(name, body.config, "user");
    if (!parsed.ok) throw new Error(parsed.error);
    const server = parsed.value;
    if (server.type === "http" || server.type === "sse") validateServiceUrl(server.url);
    await updateUserSettings({ mcpServers: { ...map(config.mcpServers), [name]: server } });
    return { name };
  }
  if (resource === "teams") {
    if (getActiveTeam()) throw new Error("Finish the active team before changing team configurations.");
    const teams = await listTeamPresets();
    if (body.op === "global") {
      if (typeof body.enabled !== "boolean") throw new Error("Invalid enabled state.");
      if (!body.enabled && getActiveTeam()) throw new Error("Finish the active team before closing Agent Teams.");
      await updateUserSettings({ agentTeams: body.enabled }); return { ok: true };
    }
    const id = safeDefinitionName(body.id);
    const old = teams.find((t) => t.id === id);
    if (body.op === "state") {
      if (!old || typeof body.enabled !== "boolean") throw new Error("Unknown team or invalid state.");
      old.enabled = body.enabled;
    } else {
      if (old && body.edit !== true) throw new Error("Team already exists; edit it or choose another ID.");
      if (!Array.isArray(body.roles) || body.roles.length < 1 || body.roles.length > 8) throw new Error("A team needs 1–8 roles.");
      const roles = body.roles.map((r) => {
        const role = object(r); const agentType = text(role.agentType || "general-purpose", "Agent type", 100);
        if (!getAllAgents().some((a) => a.agentType === agentType)) throw new Error(`Unknown Agent type: ${agentType}`);
        return { name: safeDefinitionName(role.name), agentType, prompt: text(role.prompt, "Role instructions", 6000) };
      });
      if (new Set(roles.map((r) => r.name)).size !== roles.length) throw new Error("Role names must be unique.");
      const next = { id, name: text(body.name, "Team name", 100), description: text(body.description, "Team mission"), enabled: old?.enabled ?? true, roles };
      if (old) teams.splice(teams.indexOf(old), 1, next); else teams.push(next);
    }
    await updateUserSettings({ agentTeamPresets: teams }); return { id };
  }
  if (resource === "rag") {
    const connections = await loadRagConnections();
    const id = safeDefinitionName(body.id); const old = connections.find((c) => c.id === id);
    if (body.op === "search") { if (!old) throw new Error("Knowledge connection not found."); return { documents: await searchRag(old, text(body.query, "Query", 8000)) }; }
    if (body.op === "state") {
      if (!old || typeof body.enabled !== "boolean") throw new Error("Unknown knowledge connection or state.");
      old.enabled = body.enabled;
    } else {
      const topK = Number(body.topK ?? 5); if (!Number.isSafeInteger(topK) || topK < 1 || topK > 20) throw new Error("topK must be 1–20.");
      const connection: RagConnection = { id, name: text(body.name, "Knowledge base name", 100), url: validateServiceUrl(text(body.url, "Retrieval endpoint", 4096)), enabled: old?.enabled ?? true, topK, collection: typeof body.collection === "string" ? body.collection.trim().slice(0, 200) : "", ...(old?.apiKey ? { apiKey: old.apiKey } : {}) };
      if (new URL(connection.url).search) throw new Error("Use an authorization key instead of URL query credentials.");
      if (typeof body.apiKey === "string" && body.apiKey.trim()) connection.apiKey = await storeWebSecret("rag:" + id, body.apiKey);
      if (old) connections.splice(connections.indexOf(old), 1, connection); else connections.push(connection);
    }
    await updateUserSettings({ ragConnections: connections }); return { id };
  }
  throw new Error("Unknown customization resource.");
}
