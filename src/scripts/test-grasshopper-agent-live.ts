/** Opt-in real model + Jev + built-in agent smoke using only our generated fixture. */
import { loadEnv } from "../utils/loadEnv.js";
await loadEnv();
import * as fs from "node:fs/promises";
import * as path from "node:path";
import assert from "node:assert/strict";
import { runChildAgent } from "../agents/runAgent.js";
import { RHINO_AGENT } from "../agents/builtIn/rhinoAgent.js";
import { rhinoActionTool, rhinoObserveTool, rhinoInspectTool } from "../tools/rhinoTools.js";
import { loadPermissionSettings } from "../permissions/permissions.js";
import { readMergedStringSetting } from "../utils/settings.js";
if(!process.argv.includes("--execute")) throw new Error("Requires --execute and a successful npm run test:rhino-live");
const { getRhinoProjectDirectory, rhinoDesktopDirectory } = await import("../tools/rhinoProject.js");
process.env.CCAGENT_RHINO_PROJECT_DIR ??= path.join(rhinoDesktopDirectory(), "CCAGENT-Rhino", "native-tests");
const output = getRhinoProjectDirectory();
process.env.CCAGENT_RHINO_PROJECT_DIR = output;
const native=JSON.parse(await fs.readFile(path.join(output,"toolkit-live-results.json"),"utf8"));
assert.equal(native.failed,0);
const fixture=path.resolve(native.fixture_path);
assert.equal(path.dirname(fixture),output);
assert.match(path.basename(fixture),/^toolkit-fixture-[0-9a-f-]+\.gh$/i);
const events:unknown[]=[];
const abort=new AbortController();
const result=await runChildAgent({
  agentDefinition:RHINO_AGENT,
  prompt:`请实际测试新的 Grasshopper 接口。只使用固定开发测试定义 ${fixture}，禁止创建、烘焙、删除或改变 Rhino 几何。先查询 RhinoInspect capabilities action:run_grasshopper，再观察，inspect定义找到 Input_A、Input_B 输入参数和 Addition 输出组件 GUID。重新观察，再 solve，两个 number 输入各用路径[0]，A=2、B=3，只读取 Addition 输出 index=0。验证结果5。不要调用 Computer Use，不要查看其他定义。父级仅允许该固定测试文件的 inspect/solve。用简短中文报告真实结果，任何工具失败立即停止。`,
  availableTools:[rhinoObserveTool,rhinoInspectTool,rhinoActionTool],
  model:await readMergedStringSetting(process.cwd(),"defaultModel") ?? "deepseek",
  parentToolContext:{cwd:process.cwd(),sessionId:"gh-toolkit-live"},
  permissionSettings:await loadPermissionSettings(process.cwd()),abortSignal:abort.signal,
  onPermissionRequest:async request=>{
    const p=request.input.parameters as Record<string,unknown> | undefined;
    const allowed=request.toolName==="RhinoAction" && request.input.action==="run_grasshopper" && p &&
      path.resolve(String(p.definition_path))===fixture && ["inspect","solve"].includes(String(p.operation));
    events.push({type:"scoped_authorization",allowed,operation:p?.operation});
    return allowed?"allow_once":"deny";
  },
  onProgress:event=>{events.push(event);if(event.type==="text") process.stdout.write(event.text);
    else console.log(JSON.stringify(event.type==="tool_use_done"?{type:event.type,toolName:event.toolName,isError:event.isError}:event));
    if(event.type==="tool_use_done"&&event.isError) abort.abort();},
});
await fs.writeFile(path.join(output,"grasshopper-agent-live.json"),JSON.stringify({result,events},null,2));
assert.equal(result.reason,"completed");
const done=events.filter((event:any)=>event.type==="tool_use_done") as any[];
assert.ok(done.some(e=>e.toolName==="RhinoInspect"));
const solved=done.map(e=>String(e.result?.content??"")).filter(s=>s.includes('"solver_ran": true'));
assert.equal(solved.length,1,"Expected one successful solve result");
assert.match(solved[0],/"values":\s*\[\s*5\s*\]/);
console.log("\nReal built-in rhino_agent Grasshopper smoke: PASS (2 + 3 = 5)");
