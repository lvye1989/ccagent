import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGenerateImageTool } from "../tools/generateImageTool.js";
import { validateDesignRaster, DesignImageError } from "../services/images/designImageProvider.js";
import { sanitizeToolProgress, toolProgressSummary } from "../tools/toolProgress.js";

const cwd = await mkdtemp(path.join(os.tmpdir(), "ccagent-image-tool-"));
const raster = validateDesignRaster({ dataURL: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFe0AAAAASUVORK5CYII=" });
const requests: Parameters<typeof import("../services/images/designImageProvider.js").generateDesignImage>[0][] = [];
const resumed: string[] = [], stages: string[] = [];
const tool = createGenerateImageTool({
  generate: async input => { requests.push(input); input.onProgress?.("后台正在生成图片"); return { images: [raster], provider: "official", model: "fixture" }; },
  resume: async id => { resumed.push(id); return { images: [raster], provider: "official", model: "fixture" }; },
});
const context = { cwd, sessionId: "session", messageId: "message", toolUseId: "image", onToolProgress: ({ detail }: { detail: string }) => stages.push(detail) };
const receipt = (result: Awaited<ReturnType<typeof tool.call>>) => { assert(!result.isError, String(result.content)); return JSON.parse(String(result.content).match(/```ccagent-image-result\n([^\n]+)/)![1]!); };
try {
  const first = receipt(await tool.call({ prompt: "一张社区公园效果图" }, context));
  assert.equal(requests[0]!.references.length, 0); assert.equal(requests[0]!.resolution, "1K");
  assert.equal(requests[0]!.requestId, first.request_id); assert(stages.includes("后台正在生成图片"));
  assert((await readFile(first.files[0].path)).equals(Buffer.from(raster.dataURL.split(",")[1]!, "base64")));
  const again = receipt(await tool.call({ prompt: "一张社区公园效果图" }, context));
  assert.equal(again.request_id, first.request_id, "Same tool invocation keeps its idempotency key");
  receipt(await tool.call({ operation: "resume", request_id: first.request_id }, { ...context, toolUseId: "resume" }));
  assert.deepEqual(resumed, [first.request_id]); assert.equal(requests.length, 2, "Resume never calls generation");
  const source = path.join(cwd, "原图.png"); await writeFile(source, Buffer.from(raster.dataURL.split(",")[1]!, "base64"));
  receipt(await tool.call({ prompt: "保留构图，增加树木", input_images: ["原图.png"] }, { ...context, toolUseId: "edit" }));
  assert.equal(requests.at(-1)!.references[0]!.dataURL, raster.dataURL);
  await writeFile(first.files[0].path, "user-edited file");
  assert((await tool.call({ operation: "resume", request_id: first.request_id }, context)).isError);
  assert.equal(await readFile(first.files[0].path, "utf8"), "user-edited file", "Existing user edits are never overwritten");
  const count = requests.length;
  for (const input of [{ prompt: "x", output_directory: "../outside" }, { prompt: "x", input_images: ["missing.png"] }, { prompt: "x", input_images: ["https://example.org/a.png"] }, { prompt: "x", resolution: "2K", background: "transparent" }, { operation: "resume", request_id: first.request_id, prompt: "x" }]) assert((await tool.call(input, context)).isError);
  const controller = new AbortController(); controller.abort();
  assert((await tool.call({ prompt: "x" }, { ...context, abortSignal: controller.signal })).isError);
  assert.equal(requests.length, count, "Invalid paths, options and cancellation reject before generation");
  assert.equal(toolProgressSummary("PowerShell", { command: "Get-Content web/app.js | Select-Object -First 5" }), "Get-Content web/app.js | Select-Object -First 5");
  assert.equal(toolProgressSummary("Write", { file_path: "result.txt", content: "private document" }), "result.txt");
  const masked = sanitizeToolProgress('curl -H "Authorization: Bearer private-value" --api-key "key-value"; $env:API_KEY="another-value"');
  for (const secret of ["private-value", "key-value", "another-value"]) assert(!masked.includes(secret));
  assert(sanitizeToolProgress("x".repeat(1000)).length <= 300);
  const failedTool = createGenerateImageTool({ generate: async () => { throw new DesignImageError("额度不足", 409, "DESIGN_IMAGE_FAILED"); }, resume: async () => { throw new Error("must not resume"); } });
  assert.match(String((await failedTool.call({ prompt: "x" }, context)).content), /原任务已明确失败，无需 resume/);
  console.log("GenerateImage tool passed: generation/edit/resume, stable IDs, saved bytes, no overwrite, validation/cancellation and safe progress summaries.");
} finally { await rm(cwd, { recursive: true, force: true }); }
