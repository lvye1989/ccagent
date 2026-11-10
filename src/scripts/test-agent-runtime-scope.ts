/** Shared sub-agent loop against a synthetic loopback provider; no paid APIs or native actions. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { getBuiltInAgents } from "../agents/builtIn/index.js";
import { resolveAgentTools } from "../agents/resolveAgentTools.js";
import { runChildAgent } from "../agents/runAgent.js";
import type { AgentDefinition } from "../agents/types.js";
import type { Tool, ToolContext } from "../tools/Tool.js";
import { clearMcpTools, findToolByName, getAllTools, registerMcpTools } from "../tools/index.js";
import { loginForTest } from "./helpers/accountFixture.js";
import { resetSettingsCache } from "../config/sources.js";

const originalEnvironment = { ...process.env }, originalCwd = process.cwd();
const temporaryParent = await fs.realpath(os.tmpdir());
const temporary = await fs.realpath(await fs.mkdtemp(path.join(temporaryParent, "ccagent-agent-scope-")));
const workspace = path.join(temporary, "workspace");
await fs.mkdir(workspace);
for (const key of Object.keys(process.env)) {
  if (/API.?KEY|SECRET|TOKEN/i.test(key) || /^(ANTHROPIC|OPENAI|QWEN|DASHSCOPE|OLLAMA|GEMINI)_/i.test(key) ||
      ["CCAGENT_HOME", "CCAGENT_PLATFORM_HOME", "CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_CLOUD_URL", "CCAGENT_ENV_FILE", "NODE_TLS_REJECT_UNAUTHORIZED"].includes(key)) delete process.env[key];
}
process.env.CCAGENT_DISABLE_STREAM_LOG = "1";
process.chdir(workspace);

type RequestedCall = { name: string; input?: Record<string, unknown> };
type Scenario = { name: string; calls: RequestedCall[]; beforeReply?: () => void; requests: Array<{ tools: string[] }> };
let scenario: Scenario | undefined;
const supplierErrors: string[] = [], contexts: Array<{ name: string; context: ToolContext }> = [];
const executions = new Map<string, number>();
const originalCalls = new Map<Tool, Tool["call"]>();
const fakeCall = (name: string): Tool["call"] => async (_input, context) => {
  executions.set(name, (executions.get(name) ?? 0) + 1);
  contexts.push({ name, context });
  return { content: `FIXTURE_TOOL:${name}` };
};
// Even a regression can only invoke in-memory fixtures, never write or operate the computer.
for (const name of ["Read", "ReadImage", "Glob", "Write", "MultiEdit", "PowerShell", "Bash", "Agent", "Mail", "ComputerAction", "WorkfriendDeliver"]) {
  const tool = findToolByName(name);
  assert.ok(tool, `Registered fixture tool ${name} exists`);
  originalCalls.set(tool, tool.call); tool.call = fakeCall(name);
}
const mcpWrite: Tool = {
  name: "mcp__scope_fixture__write", description: "In-memory writable MCP fixture", inputSchema: { type: "object", properties: {} },
  isEnabled: () => true, isReadOnly: () => false, call: fakeCall("mcp__scope_fixture__write"),
};
registerMcpTools([mcpWrite]);
const supplier = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    assert.ok(scenario, "A fixture scenario must be active");
    let raw = ""; for await (const bytes of request) raw += bytes;
    const body = JSON.parse(raw);
    scenario.requests.push({ tools: (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name) });
    const toolTurn = scenario.requests.length === 1;
    if (toolTurn) scenario.beforeReply?.();
    const delta = toolTurn ? { role: "assistant", tool_calls: scenario.calls.map((call, index) => ({ index, id: `fixture-${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) } })) } : { role: "assistant", content: "Fixture completed." };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: toolTurn ? "tool_calls" : "stop" }], usage: { prompt_tokens: 30, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    supplierErrors.push(error instanceof Error ? error.message : String(error));
    if (!response.headersSent) response.writeHead(500);
    response.end("Fixture request failed");
  }
});
await new Promise<void>(resolve => supplier.listen(0, "127.0.0.1", resolve));
const address = supplier.address(); assert.ok(address && typeof address !== "string");
const account = await loginForTest(path.join(temporary, "profile"));
const builtIns = getBuiltInAgents();
const definition = (name: string) => { const agent = builtIns.find(candidate => candidate.agentType === name); assert.ok(agent); return agent; };
const read = findToolByName("Read")!, write = findToolByName("Write")!, agentTool = findToolByName("Agent")!;
let assertions = 0;
function pass(label: string) { assertions++; console.log(`PASS ${label}`); }

async function run(name: string, agent: AgentDefinition, calls: RequestedCall[], options: {
  parentScope?: readonly Tool[]; available?: Tool[]; beforeReply?: () => void; signal?: AbortSignal;
} = {}) {
  executions.clear(); contexts.length = 0;
  scenario = { name, calls, requests: [], beforeReply: options.beforeReply };
  const result = await runChildAgent({
    agentDefinition: agent, prompt: `Run synthetic fixture ${name}.`, model: "agent-scope-fixture", permissionMode: "full",
    availableTools: options.available ?? getAllTools(),
    parentToolContext: {
      cwd: workspace, sessionId: `parent-${name}`, notificationOwnerSessionId: "root-conversation", strictNotificationScope: true,
      temporaryChat: true, agentTeamsAllowed: false, officialVisionOnly: true, abortSignal: options.signal,
      ...(options.parentScope === undefined ? {} : { scopedTools: options.parentScope }),
    },
  });
  const results = result.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(block => block.type === "tool_result");
  const byName = new Map(calls.map((call, index) => [call.name, results.find(block => block.tool_use_id === `fixture-${index}`)]));
  return { result, requests: scenario.requests, byName };
}

try {
  await fs.writeFile(path.join(account.home, "settings.json"), JSON.stringify({ disableAllHooks: true, mcpServers: {}, models: {
    "agent-scope-fixture": { protocol: "openai-chat", model: "synthetic-subagent", baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture-only", maxTokens: 512, contextWindow: 131072 },
  } }));
  resetSettingsCache();
  const explore = definition("Explore"), imageReader = definition("image_reader"), general = definition("general-purpose");
  const exploreResolved = resolveAgentTools(explore, getAllTools());
  assert.equal(exploreResolved.hasWildcard, false); assert.deepEqual(exploreResolved.invalidTools, []);
  assert.ok(exploreResolved.resolvedTools.every(tool => tool.isReadOnly()));
  for (const name of ["Write", "Edit", "MultiEdit", "PowerShell", "Bash", "Mail", "ComputerAction", "Agent", mcpWrite.name]) {
    assert.ok(!exploreResolved.resolvedTools.some(tool => tool.name === name));
  }
  pass("Explore has a closed, registered, read-only tool list with no writable MCP or shell tools");

  const forbidden = ["Write", "MultiEdit", "PowerShell", "Bash", "Mail", "ComputerAction", "WorkfriendDeliver", "Agent", mcpWrite.name];
  const explored = await run("explore-forged", explore, [{ name: "Read" }, ...forbidden.map(name => ({ name }))]);
  assert.equal(explored.result.reason, "completed"); assert.equal(executions.get("Read"), 1);
  for (const name of forbidden) { assert.equal(executions.get(name) ?? 0, 0); assert.equal(explored.byName.get(name)?.is_error, true); }
  assert.deepEqual(explored.requests[0]!.tools, exploreResolved.resolvedTools.map(tool => tool.name));
  pass("Full-mode Explore rejects forged editing, shell, sending, application, MCP, and recursive Agent calls at dispatch");

  const image = await run("image-reader-forged", imageReader, [{ name: "ReadImage" }, { name: "Glob" }, { name: "Write" }, { name: "Agent" }, { name: mcpWrite.name }]);
  assert.equal(image.result.reason, "completed"); assert.deepEqual(image.requests[0]!.tools, ["ReadImage", "Glob"]);
  assert.equal(executions.get("ReadImage"), 1); assert.equal(executions.get("Glob"), 1);
  for (const name of ["Write", "Agent", mcpWrite.name]) { assert.equal(executions.get(name) ?? 0, 0); assert.equal(image.byName.get(name)?.is_error, true); }
  const imageContext = contexts.find(item => item.name === "ReadImage")!.context;
  assert.equal(imageContext.officialVisionOnly, true); assert.equal(imageContext.defaultModel, "agent-scope-fixture");
  assert.equal(imageContext.notificationOwnerSessionId, "root-conversation"); assert.equal(imageContext.strictNotificationScope, true);
  assert.equal(imageContext.temporaryChat, true); assert.equal(imageContext.agentTeamsAllowed, false);
  assert.ok(imageContext.sessionId?.startsWith("parent-image-reader-forged/agent-image_reader-"));
  assert.deepEqual(imageContext.scopedTools?.map(tool => tool.name), ["ReadImage", "Glob"]); assert.ok(Object.isFrozen(imageContext.scopedTools));
  pass("image_reader executes only ReadImage/Glob and preserves official vision, account/session, temporary, and Teams boundaries");

  const narrow = await run("general-parent-scope", general, [{ name: "Read" }, { name: "Write" }, { name: "Agent" }, { name: mcpWrite.name }], { parentScope: [read, write, agentTool] });
  assert.equal(narrow.result.reason, "completed"); assert.deepEqual(narrow.requests[0]!.tools, ["Read", "Write"]);
  assert.equal(executions.get("Read"), 1); assert.equal(executions.get("Write"), 1);
  for (const name of ["Agent", mcpWrite.name]) { assert.equal(executions.get(name) ?? 0, 0); assert.equal(narrow.byName.get(name)?.is_error, true); }
  pass("general-purpose retains authorized parent Read/Write capabilities without restoring MCP tools or recursive Agent");

  const authorizedMcp = await run("general-authorized-mcp", general, [{ name: mcpWrite.name }], { parentScope: [mcpWrite] });
  assert.equal(authorizedMcp.result.reason, "completed"); assert.deepEqual(authorizedMcp.requests[0]!.tools, [mcpWrite.name]);
  assert.equal(executions.get(mcpWrite.name), 1); assert.notEqual(authorizedMcp.byName.get(mcpWrite.name)?.is_error, true);
  pass("general-purpose still executes explicitly authorized writable MCP capabilities within the parent scope");

  for (const [name, scope] of [["empty", []], ["different-instance", [{ ...read }]], ["ambiguous", [read, { ...read }]]] as const) {
    const restricted = await run(`parent-${name}`, general, [{ name: "Read" }, { name: "Write" }, { name: "Agent" }], { parentScope: scope });
    assert.equal(restricted.result.reason, "completed"); assert.deepEqual(restricted.requests[0]!.tools, []);
    assert.equal(executions.size, 0); assert.ok([...restricted.byName.values()].every(block => block?.is_error === true));
  }
  pass("empty, different-instance, and ambiguous parent scopes cannot expand from the global registry");

  const intersection = await run("image-parent-intersection", imageReader, [{ name: "ReadImage" }, { name: "Glob" }, { name: "Read" }], { parentScope: [read] });
  assert.equal(intersection.result.reason, "completed"); assert.deepEqual(intersection.requests[0]!.tools, []);
  assert.equal(executions.size, 0); assert.ok([...intersection.byName.values()].every(block => block?.is_error === true));
  pass("a specialized child also intersects its allowlist with the parent's capabilities");

  let enabled = true;
  const late: Tool = { name: "LateScopeFixture", description: "In-memory late disable fixture", inputSchema: { type: "object", properties: {} }, isEnabled: () => enabled, isReadOnly: () => true, call: fakeCall("LateScopeFixture") };
  const disabled = await run("late-disabled", general, [{ name: late.name }], { parentScope: [late], available: [late], beforeReply: () => { enabled = false; } });
  assert.equal(disabled.result.reason, "completed"); assert.deepEqual(disabled.requests[0]!.tools, [late.name]);
  assert.equal(executions.size, 0); assert.equal(disabled.byName.get(late.name)?.is_error, true);
  pass("a tool disabled after its schema was sent remains blocked at the actual execution boundary");

  const abort = new AbortController();
  const stopped = await run("inherited-stop", general, [{ name: "Read" }], { parentScope: [read], signal: abort.signal, beforeReply: () => abort.abort() });
  assert.equal(stopped.result.reason, "aborted"); assert.equal(executions.size, 0);
  pass("the parent's cancellation signal stops child model/tool execution when no explicit child signal is supplied");
  assert.deepEqual(supplierErrors, []);
} finally {
  for (const [tool, call] of originalCalls) tool.call = call;
  clearMcpTools();
  supplier.closeAllConnections(); await new Promise<void>(resolve => supplier.close(() => resolve()));
  await account.close(); process.chdir(originalCwd);
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment); resetSettingsCache();
  const relative = path.relative(temporaryParent, temporary);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(temporary).startsWith("ccagent-agent-scope-"));
  await fs.rm(temporary, { recursive: true, force: true });
}
console.log(`Agent runtime scope: ${assertions} checks passed; loopback fixtures only.`);
