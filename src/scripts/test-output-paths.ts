import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { fileWriteTool } from "../tools/fileWriteTool.js";
import { fileEditTool } from "../tools/fileEditTool.js";
import { multiEditTool } from "../tools/multiEditTool.js";
import { workfriendDeliverTool } from "../tools/workfriendDeliverTool.js";
import { pdfToMarkdownTool } from "../tools/documentConversionTools.js";
import { getAdditionalAllowedRoots, setAdditionalAllowedRoots } from "../tools/pathUtils.js";

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-output-paths-")));
const workspace = path.join(root, "工作 空间"), home = path.join(root, "账户 数据"), external = path.join(root, "授权 交付目录");
await fs.mkdir(workspace); await fs.mkdir(home);
const previousRoots = [...getAdditionalAllowedRoots()];
const environmentNames = ["CCAGENT_HOME", "CCAGENT_ACCOUNT_ID", "CCAGENT_PYTHON", "NODE_OPTIONS", "DASHSCOPE_API_KEY", "DASHSCOPE_TTS_URL", "QWEN_API_KEY", "QWEN_TTS_MODEL"];
const previousEnvironment = new Map(environmentNames.map(name => [name, process.env[name]]));
for (const name of environmentNames) delete process.env[name];
process.env.CCAGENT_HOME = home;
const context = { cwd: workspace };
let checks = 0, voiceRequests = 0;
const check = (value: unknown, label: string) => { assert.ok(value, label); console.log(`PASS ${++checks}. ${label}`); };
const wav = Buffer.alloc(44); wav.write("RIFF", 0); wav.writeUInt32LE(36, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
const server = createServer(async (request, response) => {
  if (request.url === "/audio.wav") { response.writeHead(200, { "content-type": "audio/wav" }); response.end(wav); return; }
  voiceRequests++;
  let body = ""; for await (const chunk of request) body += chunk;
  assert.equal(JSON.parse(body).input.text, "Synthetic local voice fixture.");
  const address = server.address(); assert(address && typeof address !== "string");
  response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ output: { audio: { url: `http://127.0.0.1:${address.port}/audio.wav` } } }));
});

try {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  process.env.DASHSCOPE_API_KEY = "synthetic-test-key-never-sent-outside-loopback";
  process.env.DASHSCOPE_TTS_URL = `http://127.0.0.1:${address.port}/tts`;
  process.env.QWEN_TTS_MODEL = "synthetic-local-tts";
  // Exercise the real document output resolver, staging and atomic commit with
  // a synthetic local extractor; this is not document-rendering acceptance.
  const extractor = path.join(root, "synthetic-extractor.cjs");
  await fs.writeFile(extractor, `if (process.argv[1]?.endsWith('convert.py')) { const fs = require('node:fs'); if (!fs.readFileSync(process.argv[2], 'utf8').startsWith('%PDF-')) throw new Error('FIXTURE_SOURCE_INVALID'); fs.writeFileSync(process.argv[3], '# Synthetic local extraction\\n\\n中文路径 fixture.\\n'); console.log('synthetic-local-extractor'); process.exit(0); }`);
  process.env.CCAGENT_PYTHON = process.execPath;
  process.env.NODE_OPTIONS = `--require="${extractor.replaceAll("\\", "/")}"`;
  const source = path.join(workspace, "中文 原文.pdf"); await fs.writeFile(source, "%PDF-1.4\nSynthetic document path fixture only.\n%%EOF\n");

  const documentRoot = path.join(root, "尚未存在的 授权文档目录");
  setAdditionalAllowedRoots([documentRoot]);
  const document = path.join(documentRoot, "一级 子目录", "二级", "中文 提取.md");
  const converted = await pdfToMarkdownTool.call({ source_path: source, output_path: document }, context);
  check(!converted.isError, `Document conversion creates a previously nonexistent approved root: ${String(converted.content)}`);
  check((await fs.readFile(document, "utf8")).includes("中文路径 fixture"), "Document output is committed at the exact approved absolute path.");
  const before = await fs.readFile(document);
  check((await pdfToMarkdownTool.call({ source_path: source, output_path: document }, context)).isError, "Document collision requires explicit overwrite.");
  check((await fs.readFile(document)).equals(before), "Document collision preserves all original bytes.");
  check(!(await pdfToMarkdownTool.call({ source_path: source, output_path: document, overwrite: true }, context)).isError, "Explicit document overwrite commits a new staged result.");
  const relativeDocument = path.join("文档 相对路径", "新建 子目录", "提取.md");
  check(!(await pdfToMarkdownTool.call({ source_path: source, output_path: relativeDocument }, context)).isError, "Document conversion creates nested workspace-relative output parents.");
  check((await fs.readFile(path.join(workspace, relativeDocument), "utf8")).includes("中文路径 fixture"), "Relative document conversion commits in the active workspace.");

  setAdditionalAllowedRoots([]);
  const relative = path.join("新建 空间", "一级", "中文 文件.txt"), absolute = path.join(workspace, relative);
  check(!(await fileWriteTool.call({ file_path: relative, content: "初始 第一段\n第二段" }, context)).isError, "Write accepts workspace-relative Chinese paths and creates nested parents.");
  check((await fs.readFile(absolute, "utf8")).startsWith("初始"), "Relative Write resolves against the active workspace.");
  check(!(await fileEditTool.call({ file_path: absolute, old_string: "第一段", new_string: "已编辑" }, context)).isError, "Edit accepts an exact absolute Chinese path.");
  check(!(await multiEditTool.call({ file_path: relative, edits: [{ old_string: "第二段", new_string: "批量完成" }] }, context)).isError, "MultiEdit accepts the same relative path.");
  const edited = await fs.readFile(absolute, "utf8");
  check((await multiEditTool.call({ file_path: absolute, edits: [{ old_string: "不存在的内容", new_string: "错误" }] }, context)).isError, "MultiEdit reports unmatched edits.");
  check(await fs.readFile(absolute, "utf8") === edited, "Failed MultiEdit preserves the original file.");
  const outside = path.join(root, "未授权 外部目录", "禁止.txt");
  check((await fileWriteTool.call({ file_path: outside, content: "Do not write" }, context)).isError, "Write rejects an external destination before creating parents.");
  check(!(await fs.stat(path.dirname(outside)).catch(() => null)), "Denied Write does not create the external parent.");
  check((await workfriendDeliverTool.call({ format: "word", content: "Fixture", output_path: path.join(root, "未授权.docx") }, context)).isError, "Word delivery rejects an unapproved absolute destination.");
  check((await workfriendDeliverTool.call({ format: "voice", content: "Synthetic local voice fixture.", output_path: path.join(root, "未授权.wav") }, context)).isError && voiceRequests === 0, "Voice rejects an unapproved destination before any synthesis request.");
  check((await pdfToMarkdownTool.call({ source_path: source, output_path: path.join(root, "未授权.md") }, context)).isError, "Document conversion rejects an unapproved absolute destination.");
  const relativeWord = path.join("工作区 交付", "相对 报告.docx");
  check(!(await workfriendDeliverTool.call({ format: "word", content: "Workspace relative fixture", output_path: relativeWord }, context)).isError, "Word delivery supports a nested workspace-relative destination.");
  check((await fs.readFile(path.join(workspace, relativeWord))).subarray(0, 2).toString() === "PK", "Relative Word output is created in the active workspace.");

  setAdditionalAllowedRoots([external]);
  const granted = path.join(external, "用户指定 新建子目录", "结果.txt");
  check(!(await fileWriteTool.call({ file_path: granted, content: "外部 已授权" }, context)).isError, "Write creates a nonexistent approved external destination.");
  check(!(await fileEditTool.call({ file_path: granted, old_string: "已授权", new_string: "已修改" }, context)).isError, "Edit honors the same external-directory grant.");
  check(!(await multiEditTool.call({ file_path: granted, edits: [{ old_string: "已修改", new_string: "批量修改" }] }, context)).isError, "MultiEdit honors the same external-directory grant.");
  const word = path.join(external, "Word 输出", "报告 中文.docx");
  check(!(await workfriendDeliverTool.call({ format: "word", title: "路径测试", content: "保持用户指定目录。", output_path: word }, context)).isError, "Word delivery creates exact approved Chinese/space path and nested parents.");
  const wordBefore = await fs.readFile(word); check(wordBefore.subarray(0, 2).toString() === "PK", "Generated Word bytes have the DOCX ZIP signature.");
  check((await workfriendDeliverTool.call({ format: "word", content: "Replace blocked", output_path: word }, context)).isError, "Word collision requires explicit overwrite.");
  check((await fs.readFile(word)).equals(wordBefore), "Word collision preserves original bytes.");
  check(!(await workfriendDeliverTool.call({ format: "word", content: "Replacement allowed", output_path: word, overwrite: true }, context)).isError, "Explicit Word overwrite succeeds at the requested path.");
  const audio = path.join(external, "语音 输出", "播报 中文.wav");
  check(!(await workfriendDeliverTool.call({ format: "voice", content: "Synthetic local voice fixture.", output_path: audio }, context)).isError, "Loopback-only voice fixture writes the exact approved WAV path.");
  check((await fs.readFile(audio)).equals(wav) && voiceRequests === 1, "Voice fixture saves the downloaded bytes once.");
  check((await workfriendDeliverTool.call({ format: "voice", content: "Synthetic local voice fixture.", output_path: audio }, context)).isError && voiceRequests === 1, "Existing voice destination is rejected before sending another synthesis request.");
  check(!(await workfriendDeliverTool.call({ format: "voice", content: "Synthetic local voice fixture.", output_path: audio, overwrite: true }, context)).isError && voiceRequests === 2, "Explicit voice overwrite replaces the exact requested path once.");
  const parentFile = path.join(workspace, "不可作为 目录.txt"); await fs.writeFile(parentFile, "keep");
  check((await fileWriteTool.call({ file_path: path.join(parentFile, "child.txt"), content: "bad" }, context)).isError, "A parent that is a file fails without silently choosing another output directory.");
  check(await fs.readFile(parentFile, "utf8") === "keep", "Parent-file error leaves its bytes unchanged.");

  const deniedRoot = path.join(root, "链接 外部目标"); await fs.mkdir(deniedRoot);
  const deniedExisting = path.join(deniedRoot, "已有.txt"); await fs.writeFile(deniedExisting, "preserve external bytes");
  const junction = path.join(workspace, "重定向 目录"); await fs.symlink(deniedRoot, junction, process.platform === "win32" ? "junction" : "dir");
  try {
    check((await fileWriteTool.call({ file_path: path.join(junction, "escape.txt"), content: "bad" }, context)).isError, "Write rejects a workspace junction escaping approved roots.");
    check((await fileEditTool.call({ file_path: path.join(junction, "已有.txt"), old_string: "preserve", new_string: "bad" }, context)).isError, "Edit rejects a junction redirect to an existing external file.");
    check((await multiEditTool.call({ file_path: path.join(junction, "已有.txt"), edits: [{ old_string: "preserve", new_string: "bad" }] }, context)).isError, "MultiEdit rejects the same existing-file junction escape.");
    check((await workfriendDeliverTool.call({ format: "word", content: "bad", output_path: path.join(junction, "escape.docx") }, context)).isError, "Word delivery rejects the same junction escape.");
    check((await pdfToMarkdownTool.call({ source_path: source, output_path: path.join(junction, "escape.md") }, context)).isError, "Document conversion rejects the same junction escape.");
    check((await fs.readdir(deniedRoot)).length === 1 && await fs.readFile(deniedExisting, "utf8") === "preserve external bytes", "Rejected junction operations preserve existing external files and create no new outputs.");
  } finally { await fs.unlink(junction); }
  console.log(`Output paths: ${checks} checks passed. Actual local file tools and staged document output; synthetic local document extractor and loopback TTS only, no paid supplier requests.`);
} finally {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  setAdditionalAllowedRoots(previousRoots);
  for (const [name, value] of previousEnvironment) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  const canonicalTemp = await fs.realpath(os.tmpdir());
  assert.equal(path.dirname(root), canonicalTemp); assert.match(path.basename(root), /^ccagent-output-paths-/);
  await fs.rm(root, { recursive: true, force: true });
}
