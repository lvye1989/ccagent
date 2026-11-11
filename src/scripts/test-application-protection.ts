import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startAccountFixture } from "./helpers/accountFixture.js";
import { enterPlatformAccount, canMaintainApplication } from "../platform/account.js";
import { applicationProtectionReason, isProtectedApplicationPath } from "../permissions/applicationProtection.js";
import { checkPermission } from "../permissions/permissions.js";
import { findToolByName } from "../tools/index.js";
import { runTools } from "../core/agenticLoop.js";
import { QueryEngine } from "../core/queryEngine.js";
import { buildSystemPrompt, renderSystemPrompt } from "../context/systemPrompt.js";
import { clearOutputStyles, setActiveOutputStyle, setCustomOutputStyles } from "../styles/registry.js";
import { resetSettingsCache } from "../config/sources.js";
import { _resetHooksSettingsCache } from "../hooks/runHooks.js";

const previous = { ...process.env };
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-protection-"));
const project = path.join(root, "design project"), app = path.join(root, "application");
await fs.mkdir(project); await fs.mkdir(path.join(app, "web"), { recursive: true });
await fs.writeFile(path.join(app, "package.json"), JSON.stringify({ name: "ccdagent" }));
const applicationFile = path.join(app, "web", "app.js");
await fs.writeFile(applicationFile, "original");
process.env.CCAGENT_HOME = path.join(root, "profile");
process.env.CCAGENT_PLATFORM_HOME = process.env.CCAGENT_HOME;
delete process.env.CCAGENT_AUTH_SESSION_FILE; delete process.env.CCAGENT_ACCOUNT_ID;
let permissions: string[] = [], accessRequests = 0;
const fixture = await startAccountFixture(process.env.CCAGENT_HOME, { handleService: async (request, response, user) => {
  if (request.url !== "/api/account/me") return false;
  accessRequests++;
  response.writeHead(user ? 200 : 401);
  response.end(JSON.stringify(user ? { user, permissions } : { error: "unauthorized" }));
  return true;
} });
await fixture.nativeClient.signIn(fixture.users[0]!.email, fixture.password);
const { home } = await enterPlatformAccount();
await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ disableAllHooks: true }));
resetSettingsCache();
const context = { cwd: app, applicationProtection: true, sessionId: "protection-fixture" };
const write = findToolByName("Write")!;
const input = { file_path: applicationFile, content: "modified" };
const check = (name: string, value: Record<string, unknown>, cwd = app) => applicationProtectionReason(name, value, { ...context, cwd });
const dispatch = (mode: "default" | "full" = "full", onPermissionRequest?: () => Promise<"allow_once">) => runTools([
  { type: "tool_use", id: `write-${accessRequests}`, name: "Write", input },
], context, { permissionMode: mode, permissionSettings: { mode, allow: [], deny: [] }, onPermissionRequest });

try {
  for (const mode of ["default", "plan", "auto", "full"] as const) {
    const result = await checkPermission({ tool: write, input, ...context, mode,
      settings: { mode, allow: ["Write(*)"], deny: [] }, sessionRules: { allow: ["Write(*)"], deny: [] } });
    assert.equal(result.behavior, "deny", `${mode} and allow rules must not grant an ordinary user maintenance access`);
  }
  assert.ok(await check("Edit", { file_path: "web/../web/app.js", old_string: "original", new_string: "changed" }));
  assert.ok(await check("Write", { ...input, applicationProtection: false, isAdmin: true, permissions: ["admin.read", "roles.write", "settings.write"] }), "model-authored role and protection flags confer no authority");
  assert.ok(await check("Write", { file_path: path.join(home, "settings.json") }, project));
  assert.ok(await check("Write", { file_path: path.join(project, ".ccagent/settings.json") }, project));
  assert.ok(await check("mcp__fixture__write", { path: applicationFile }));
  assert.ok(await check("RhinoSequence", { steps: [{ action: "import_export", parameters: { operation: "export", file_path: path.join(app, "model.3dm") } }] }));
  assert.ok(await check("PowerShell", { command: `Set-Content -LiteralPath '${applicationFile}' -Value changed` }));
  assert.ok(await check("Bash", { command: `git -C '${app.replaceAll("\\", "/")}' reset --hard` }, project));
  assert.ok(await check("mcp__fixture__execute", { code: `open(${JSON.stringify(applicationFile)}, 'w').write('changed')` }));
  assert.ok(await check("PowerShell", { command: "npm run build" }));
  assert.equal(await check("Read", { file_path: applicationFile }), undefined);
  assert.equal(await check("PowerShell", { command: `Get-Content -LiteralPath '${applicationFile}'` }), undefined);
  assert.equal(await check("PowerShell", { command: `Set-Content -LiteralPath '${path.join(project, "notes.txt")}' -Value hello` }), undefined);
  assert.equal(await check("PowerShell", { command: "python generate_report.py" }, project), undefined);
  assert.equal(await check("Write", { file_path: path.join(project, "site-analysis.md"), content: "# 场地分析" }, project), undefined);
  assert.equal(await check("MemoryWrite", { file_name: "site-notes.md", content: "已确认的场地条件" }, project), undefined);
  await fs.symlink(path.join(app, "web"), path.join(project, "linked-app"), process.platform === "win32" ? "junction" : "dir");
  assert.ok(await isProtectedApplicationPath(path.join(project, "linked-app", "new.js"), app), "non-existing symlink leaves are protected");
  console.log("PASS ordinary-user modes, relative/absolute/core configuration paths, commands, MCP, nested Rhino, symlinks; user projects and read-only calls remain available");

  // A permissive hook must never run for a blocked application edit.
  const marker = path.join(root, "hook-executed"), hook = path.join(root, "allow-hook.cjs");
  await fs.writeFile(hook, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'called'); process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}));`);
  await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: `node "${hook.replaceAll("\\", "/")}"` }] }] } }));
  resetSettingsCache(); _resetHooksSettingsCache();
  assert.equal((await dispatch()).executions[0]!.result.isError, true);
  assert.equal(await fs.readFile(applicationFile, "utf8"), "original");
  assert.equal(await fs.stat(marker).catch(() => null), null);
  await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ disableAllHooks: true }));
  resetSettingsCache(); _resetHooksSettingsCache();
  permissions = ["admin.read"];
  assert.equal(await canMaintainApplication(), false, "dashboard read access alone is insufficient");
  permissions = ["admin.read", "roles.write", "settings.write"];
  assert.equal(await canMaintainApplication(), true);
  assert.ok(!(await dispatch()).executions[0]!.result.isError);
  assert.equal(await fs.readFile(applicationFile, "utf8"), "modified");
  await fs.writeFile(applicationFile, "original");
  const revoked = await dispatch("default", async () => { permissions = []; return "allow_once"; });
  assert.equal(revoked.executions[0]!.result.isError, true);
  assert.equal(await fs.readFile(applicationFile, "utf8"), "original", "revocation during approval prevents dispatch");
  fixture.setUnavailable(true);
  assert.ok(await check("Write", input));
  fixture.setUnavailable(false);
  console.log("PASS real dispatch: hook cannot bypass, live administrator can edit, revoked/read-only/offline identities cannot");

  const engine = new QueryEngine({ model: "fixture-unused", toolContext: context,
    initialMessages: [{ role: "assistant", content: "export must not overwrite app code" }] });
  const events = [];
  for await (const event of engine.submitMessage(`/export ${applicationFile}`)) events.push(event);
  assert.ok(events.some(event => event.type === "command" && event.kind === "error"));
  assert.equal(await fs.readFile(applicationFile, "utf8"), "original");
  setCustomOutputStyles([{ name: "DesignFixture", description: "fixture", prompt: "Use concise Chinese.", source: "user", keepCodingInstructions: false }]);
  setActiveOutputStyle("DesignFixture");
  const prompt = renderSystemPrompt(await buildSystemPrompt({ cwd: project, temporaryChat: true, applicationProtection: true }));
  for (const content of ["建筑", "城市规划", "风景园林", "城市更新", "规范版本", "可点击的真实文件地址", "只有经服务端核实", "完全权限模式也不等于管理员"]) assert.ok(prompt.includes(content), content);
  assert.ok(!prompt.includes("When solving coding tasks"));
  console.log("PASS slash export protection and design/admin guidance survive custom output styles");
} finally {
  clearOutputStyles(); resetSettingsCache(); _resetHooksSettingsCache();
  await fixture.close();
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("ccagent-protection-")) throw new Error("Unsafe cleanup");
  // Remove the junction itself before recursively cleaning this owned fixture.
  await fs.rm(path.join(project, "linked-app"), { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
}
