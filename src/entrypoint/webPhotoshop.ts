import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileTransaction } from "../utils/fileTransaction.js";
import type { Tool } from "../tools/Tool.js";

type TestMode = "connection" | "sample";
type ScriptState = { version: string; documents: number[]; activeDocumentId: number | null };
export type PhotoshopTestResult = {
  ok: boolean; mode: TestMode; message: string; testedAt: string; toolCount: number;
  version?: string; documents?: { count: number; activeDocumentId: number | null };
  output?: { png: string; psd: string }; reportPath: string; workspace: string;
};
const stateScript = "var ids=[]; for(var i=0;i<app.documents.length;i++) ids.push(app.documents[i].id); return {version:app.version,documents:ids,activeDocumentId:app.documents.length?app.activeDocument.id:null};";

/** Parse both MCP errors and the upstream tool's nested application result. */
export function parsePhotoshopResult(content: string, isError?: boolean): unknown {
  if (isError) throw new Error(content.slice(0, 2000));
  const payload = content.includes("\nResult: ") ? content.slice(content.indexOf("\nResult: ") + 9) : content;
  let value: unknown;
  try { value = JSON.parse(payload); } catch { return content; }
  if (value && typeof value === "object" && (value as Record<string, unknown>).ok === false) throw new Error(JSON.stringify(value).slice(0, 2000));
  return value;
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
async function outputDirectory(workspace: string): Promise<{ root: string; folder: string }> {
  const root = await realpath(workspace);
  let folder = root;
  for (const part of ["output", "photoshop-mcp-tests", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`]) {
    const next = path.join(folder, part);
    try {
      const resolved = await realpath(next);
      if (!within(root, resolved)) throw new Error("测试输出目录指向工作文件夹之外，请先修复目录链接。");
      folder = resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(next); folder = await realpath(next);
      if (!within(root, folder)) throw new Error("测试输出目录不在工作文件夹内。");
    }
  }
  return { root, folder };
}

function sampleScript(png: string, psd: string, title: string): string {
  // Fixed ES3-compatible script. No browser-provided code, file path or tool name.
  return `var original=null, created=null, oldUnits=app.preferences.rulerUnits, oldDialogs=app.displayDialogs, result={};
try {
 if(app.documents.length) original=app.activeDocument;
 app.preferences.rulerUnits=Units.PIXELS; app.displayDialogs=DialogModes.NO;
 created=app.documents.add(960,540,72,${JSON.stringify(title)},NewDocumentMode.RGB,DocumentFill.WHITE);
 var background=created.artLayers.add(); background.name='CCAGENT background';
 var dark=new SolidColor(); dark.rgb.red=23; dark.rgb.green=39; dark.rgb.blue=66;
 created.selection.selectAll(); created.selection.fill(dark); created.selection.deselect();
 var heading=created.artLayers.add(); heading.kind=LayerKind.TEXT; heading.name='CCAGENT MCP heading';
 heading.textItem.contents='CCAGENT + Photoshop MCP'; heading.textItem.size=42;
 heading.textItem.position=[64,235]; var white=new SolidColor(); white.rgb.red=255;white.rgb.green=255;white.rgb.blue=255;heading.textItem.color=white;
 var caption=created.artLayers.add();caption.kind=LayerKind.TEXT;caption.name='Web integration test';
 caption.textItem.contents='Photoshop '+app.version+'  |  WEB INTEGRATION TEST';caption.textItem.size=22;caption.textItem.position=[67,295];
 var blue=new SolidColor();blue.rgb.red=117;blue.rgb.green=200;blue.rgb.blue=230;caption.textItem.color=blue;
 var options=new PhotoshopSaveOptions();options.layers=true;created.saveAs(new File(${JSON.stringify(psd)}),options,true,Extension.LOWERCASE);
 created.saveAs(new File(${JSON.stringify(png)}),new PNGSaveOptions(),true,Extension.LOWERCASE);
 result={version:app.version,width:960,height:540,layerCount:created.layers.length,documentId:created.id};
 return result;
} finally {
 try {if(created)created.close(SaveOptions.DONOTSAVECHANGES);}catch(closeError){result.cleanupError=String(closeError);}
 try {if(original)app.activeDocument=original;}catch(restoreError){result.cleanupError=String(restoreError);}
 app.preferences.rulerUnits=oldUnits;app.displayDialogs=oldDialogs;
}`;
}

/** Inspect actual file headers and PSD layers, independent of the tool's success text. */
export async function verifyPhotoshopOutputs(pngPath: string, psdPath: string) {
  const [png, psd] = await Promise.all([readFile(pngPath), readFile(psdPath)]);
  if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("导出的 PNG 文件头无效。");
  if (png.readUInt32BE(16) !== 960 || png.readUInt32BE(20) !== 540) throw new Error("PNG 尺寸与测试图不符。");
  if (psd.length < 40 || psd.subarray(0, 4).toString() !== "8BPS" || psd.readUInt16BE(4) !== 1 || psd.readUInt32BE(14) !== 540 || psd.readUInt32BE(18) !== 960) throw new Error("导出的 PSD 文件头或尺寸无效。");
  let offset = 26;
  const skipBlock = () => { if (offset + 4 > psd.length) throw new Error("PSD 数据截断。"); const size = psd.readUInt32BE(offset); offset += 4 + size; if (offset > psd.length) throw new Error("PSD 数据截断。"); };
  skipBlock(); skipBlock();
  if (offset + 10 > psd.length || psd.readUInt32BE(offset) < 6 || psd.readUInt32BE(offset + 4) < 2) throw new Error("PSD 未保留可编辑图层。");
  const layerCount = Math.abs(psd.readInt16BE(offset + 8));
  if (layerCount < 3) throw new Error("PSD 未保留预期的可编辑图层。");
  const details = (bytes: Buffer) => ({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  return { width: 960, height: 540, layerCount, png: details(png), psd: details(psd) };
}

/** Explicit UI test actions; normal conversation tools keep their existing permission path. */
export async function runPhotoshopWebTest(workspace: string, mode: TestMode, tools: readonly Tool[]): Promise<PhotoshopTestResult> {
  const { root, folder } = await outputDirectory(workspace);
  const relative = (file: string) => path.relative(root, file).split(path.sep).join("/");
  const reportFile = path.join(folder, "report.json");
  const report: PhotoshopTestResult = { ok: false, mode, message: "", testedAt: new Date().toISOString(), toolCount: tools.length, reportPath: relative(reportFile), workspace: root };
  const events: { tool: string; ok: boolean; ms: number }[] = [];
  let verification: unknown;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find((item) => item.name.endsWith(`__${name}`));
    if (!tool || !tool.isEnabled()) throw new Error(`Photoshop MCP 工具 ${name} 不可用，请先连接 MCP。`);
    const started = Date.now();
    try {
      const result = await tool.call(args, { cwd: workspace });
      const text = typeof result.content === "string" ? result.content : result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      const parsed = parsePhotoshopResult(text, result.isError);
      events.push({ tool: name, ok: true, ms: Date.now() - started }); return parsed;
    } catch (error) { events.push({ tool: name, ok: false, ms: Date.now() - started }); throw error; }
  };
  const readState = async (): Promise<ScriptState> => {
    const result = await call("photoshop_execute_script", { document_id: null, code: stateScript, timeout_ms: 15000 }) as ScriptState;
    if (!result || typeof result.version !== "string" || !/^\d+(?:\.\d+){1,3}$/.test(result.version) || !Array.isArray(result.documents) || !result.documents.every((id) => Number.isSafeInteger(id) && id > 0) || new Set(result.documents).size !== result.documents.length || (result.documents.length ? !result.documents.includes(result.activeDocumentId as number) : result.activeDocumentId !== null)) throw new Error("未能读取真实 Photoshop 版本和文档状态。");
    return result;
  };
  // All account workers share the same desktop Photoshop. Serialize test scripts.
  const lock = path.join(os.tmpdir(), "ccagent-photoshop-web-test", "execution");
  try {
    await withFileTransaction(lock, async () => {
      await call("photoshop_ping");
      const before = await readState();
      report.version = before.version;
      report.documents = { count: before.documents.length, activeDocumentId: before.activeDocumentId };
      if (mode === "sample") {
        const png = path.join(folder, "ccagent-photoshop-test.png"), psd = path.join(folder, "ccagent-photoshop-test.psd");
        const sample = await call("photoshop_execute_script", { document_id: null, code: sampleScript(png, psd, `CCAGENT MCP test ${path.basename(folder)}`), timeout_ms: 60000 }) as Record<string, unknown>;
        if (!sample || typeof sample !== "object" || sample.cleanupError) throw new Error(`样例文档未能完成或恢复：${String(sample?.cleanupError ?? "invalid result")}`);
        verification = await verifyPhotoshopOutputs(png, psd);
        const after = await readState();
        if (JSON.stringify(after.documents) !== JSON.stringify(before.documents) || after.activeDocumentId !== before.activeDocumentId) throw new Error("测试前后的文档状态不一致，请检查 Photoshop 窗口。测试文件已保留。");
        report.output = { png: relative(png), psd: relative(psd) };
      }
      report.ok = true;
      report.message = mode === "sample" ? "已通过真实 Photoshop 创建、编辑和导出测试；PNG 尺寸与 PSD 可编辑图层已检查，原文档状态已恢复。" : "真实 Photoshop 脚本响应正常，已读取运行版本和文档状态。";
    });
  } catch (error) {
    report.message = error instanceof Error ? error.message : String(error);
    if (/timeout|timed out|超时/i.test(report.message)) report.message += " Photoshop 中的脚本可能仍在运行；请先等待完成并测试连接，再重新执行样例测试。";
  }
  await writeFile(reportFile, JSON.stringify({ ...report, events, verification }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return report;
}
