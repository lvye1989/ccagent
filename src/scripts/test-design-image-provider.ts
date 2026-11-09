import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { deflateSync } from "node:zlib";
import { SecureCredentialStore } from "../platform/secureStore.js";

const previous = { ...process.env };
const temporary = await mkdtemp(path.join(os.tmpdir(), "ccagent-design-provider-"));
const homeA = path.join(temporary, "account-a"), homeB = path.join(temporary, "account-b"), workspace = path.join(temporary, "workspace");
await Promise.all([mkdir(homeA), mkdir(homeB), mkdir(workspace)]);
for (const key of ["IMAGE_EDIT_PROVIDER", "IMAGE_EDIT_MODEL", "IMAGE_EDIT_BASE_URL", "IMAGE_EDIT_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY", "NODE_TLS_REJECT_UNAUTHORIZED"]) delete process.env[key];
process.env.CCAGENT_HOME = homeA;
process.env.IMAGE_EDIT_API_KEY = "fixture-inherited-personal-key";
const { getDesignImageConfig, saveDesignImageConfig, validateDesignRaster, generateDesignImage, DesignImageError } = await import("../services/images/designImageProvider.js");
type Dependencies = import("../services/images/designImageProvider.js").DesignImageDependencies;
type Raster = import("../services/images/designImageProvider.js").DesignRaster;
let passed = 0;
const test = async (name: string, action: () => Promise<void> | void) => { await action(); console.log("PASS " + name); passed++; };
function crc32(bytes: Buffer): number { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; }
function png(red: number, width = 64, height = 48): Buffer {
  const chunk = (name: string, data: Buffer) => { const type = Buffer.from(name), head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(Buffer.concat([type, data]))); return Buffer.concat([head, type, data, tail]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const offset = y * (width * 3 + 1) + 1 + x * 3; pixels[offset] = red; pixels[offset + 1] = 96; pixels[offset + 2] = 144; }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
const raster = (red: number): Raster => validateDesignRaster({ dataURL: "data:image/png;base64," + png(red).toString("base64") });
const base = raster(20), annotated = raster(240), reference = raster(100), reference2 = raster(140);
const input = (references: Raster[] = [reference]) => ({ prompt: "在勾画区域绘制两层街角公共建筑，保留原路网", kind: "architecture" as const, base, annotated, references, signal: new AbortController().signal, requestId: "design-fixture-01" });
const key = "fixture-user-key-do-not-expose";
const output = png(80);
const outputData = "data:image/png;base64," + output.toString("base64");
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const dashResponse = (image: string) => response({ output: { choices: [{ message: { content: [{ image }] } }] } });
const saveDash = () => saveDesignImageConfig({ provider: "dashscope", model: "qwen-image-2.0-pro", baseURL: "https://dashscope.aliyuncs.com/api/v1", apiKey: key }, workspace);
try {
  await test("environment default is a captured explicit edit credential, not a changing workspace model", async () => {
    const first = await getDesignImageConfig(workspace);
    assert.equal(first.configured, true); assert.equal(first.provider, "dashscope"); assert.equal(first.maxReferences, 1);
    assert.equal(JSON.stringify(first).includes("fixture-inherited"), false);
    process.env.IMAGE_EDIT_BASE_URL = "https://workspace-attacker.invalid/v1";
    process.env.IMAGE_EDIT_MODEL = "vision-only"; process.env.IMAGE_EDIT_API_KEY = "workspace-value";
    process.env.QWEN_BASE_URL = "https://vision.invalid"; process.env.QWEN_MODEL = "qwen3-vl";
    assert.deepEqual(await getDesignImageConfig(workspace), first);
  });
  await test("raster bytes determine dimensions; mismatches, SVG, corruption and excessive pixels fail", () => {
    assert.equal(base.width, 64); assert.equal(base.height, 48);
    assert.throws(() => validateDesignRaster({ ...base, width: 65 }), /实际内容/);
    assert.throws(() => validateDesignRaster({ dataURL: "data:image/svg+xml;base64,PHN2Zy8+" }), /PNG/);
    assert.throws(() => validateDesignRaster({ ...base, dataURL: base.dataURL.slice(0, -4) }), /PNG|Base64/);
    const tooWide = png(20); tooWide.writeUInt32BE(9000, 16);
    assert.throws(() => validateDesignRaster({ dataURL: "data:image/png;base64," + tooWide.toString("base64") }), /尺寸/);
    assert.throws(() => validateDesignRaster({ ...base, mimeType: "image/jpeg" }), /PNG/);
    const fakeWebp = Buffer.alloc(30); fakeWebp.write("RIFF"); fakeWebp.writeUInt32LE(22, 4); fakeWebp.write("WEBP", 8); fakeWebp.write("VP8X", 12); fakeWebp.writeUInt32LE(1000, 16);
    assert.throws(() => validateDesignRaster({ dataURL: "data:image/webp;base64," + fakeWebp.toString("base64") }), /WebP/);
  });
  await test("new personal key is account-isolated and DPAPI-encrypted on Windows; public settings contain no key", async () => {
    const config = await saveDash(); assert.equal(config.configured, true); assert.equal(config.source, "user");
    const settings = await readFile(path.join(homeA, "settings.json"), "utf8"); assert.equal(settings.includes(key), false); assert.equal(settings.includes("apiKey"), false);
    const encrypted = JSON.parse(await readFile(path.join(homeA, "credentials", "design-image.json"), "utf8"));
    if (process.platform === "win32") { assert.equal(encrypted.protection, "windows-dpapi"); assert.equal(JSON.stringify(encrypted).includes(key), false); }
    process.env.CCAGENT_HOME = homeB;
    const other = await getDesignImageConfig(workspace); assert.equal(other.source, "environment");
    assert.equal(await readFile(path.join(homeB, "credentials", "design-image.json"), "utf8").catch(() => ""), "");
    process.env.CCAGENT_HOME = homeA;
  });
  await test("DashScope submits original, annotated and reference bytes once with the user's instructions", async () => {
    let calls = 0;
    const result = await generateDesignImage(input(), workspace, { fetch: (async (url, options) => {
      calls++; assert.equal(url, "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
      assert.equal(options?.redirect, "error"); assert.equal((options?.headers as Record<string,string>).authorization, "Bearer " + key);
      const body = JSON.parse(String(options?.body)); assert.equal(body.model, "qwen-image-2.0-pro");
      const content = body.input.messages[0].content;
      assert.deepEqual(content.slice(0, 3).map((item: {image:string}) => item.image), [base.dataURL, annotated.dataURL, reference.dataURL]);
      assert.ok(content[3].text.includes("两层街角公共建筑")); assert.ok(content[3].text.includes("图1")); assert.equal(body.parameters.n, 1);
      return dashResponse(outputData);
    }) as typeof fetch });
    assert.equal(calls, 1); assert.equal(result.images[0]?.dataURL, outputData); assert.equal(result.provider, "dashscope");
  });
  await test("provider-specific image cap and mismatched annotation fail before sending any provider request", async () => {
    let calls = 0; const dependencies: Dependencies = { fetch: (async () => { calls++; return dashResponse(outputData); }) as typeof fetch };
    await assert.rejects(() => generateDesignImage(input([reference, reference2]), workspace, dependencies), /最多支持 1/);
    await assert.rejects(() => generateDesignImage({ ...input(), annotated: { ...annotated, width: 63 } }, workspace, dependencies), /实际内容/);
    assert.equal(calls, 0);
  });
  await test("blank keys cannot redirect an existing credential; invalid endpoint/vision model fail", async () => {
    await assert.rejects(() => saveDesignImageConfig({ provider: "openai", baseURL: "https://other.invalid/v1", model: "custom-edit" }, workspace), /重新填写/);
    await assert.rejects(() => saveDesignImageConfig({ provider: "dashscope", baseURL: "https://user:password@example.com", model: "qwen-image-2.0-pro", apiKey: key }, workspace), /凭据/);
    await assert.rejects(() => saveDesignImageConfig({ provider: "dashscope", model: "qwen3-vl", apiKey: key }, workspace), /视觉读图/);
    await assert.rejects(() => saveDesignImageConfig({ provider: "openai", baseURL: "http://10.1.1.1/v1", model: "custom-edit", apiKey: key }, workspace), /HTTPS/);
    assert.equal((await getDesignImageConfig(workspace)).provider, "dashscope");
  });
  await test("OpenAI-compatible edit uses multipart with all four images, never a text-only generation", async () => {
    await saveDesignImageConfig({ provider: "openai", model: "gpt-image-1.5", baseURL: "http://127.0.0.1:51234/v1", apiKey: key }, workspace);
    const config = await getDesignImageConfig(workspace); assert.equal(config.maxReferences, 2);
    await generateDesignImage(input([reference, reference2]), workspace, { fetch: (async (url, options) => {
      assert.equal(url, "http://127.0.0.1:51234/v1/images/edits");
      assert.ok(options?.body instanceof FormData); const form = options.body as FormData;
      assert.equal(form.get("model"), "gpt-image-1.5"); assert.equal(form.get("n"), "1"); assert.equal(form.getAll("image[]").length, 4);
      for (const [index, image] of [base, annotated, reference, reference2].entries()) {
        const file = form.getAll("image[]")[index] as Blob;
        assert.equal(Buffer.from(await file.arrayBuffer()).toString("base64"), image.dataURL.split(",")[1]);
      }
      return response({ data: [{ b64_json: output.toString("base64") }] });
    }) as typeof fetch });
  });
  await test("supplier errors and fetch exceptions never expose key, raw response, prompt or endpoint details", async () => {
    for (const fake of [async () => new Response(key + base.dataURL, { status: 401 }), async () => response({ error: { message: key + base.dataURL } }), async () => { throw new Error(key + base.dataURL); }]) {
      let calls = 0;
      await assert.rejects(() => generateDesignImage(input(), workspace, { fetch: (async () => { calls++; return fake(); }) as typeof fetch }), error => {
        assert.ok(error instanceof DesignImageError); assert.equal(error.message.includes(key), false); assert.equal(error.message.includes(base.dataURL), false); return true;
      });
      assert.equal(calls, 1);
    }
  });
  await test("supplier output URLs block local/private/mapped/reserved DNS results and redirect protocols", async () => {
    let downloads = 0;
    for (const [url, address] of [["http://images.example.com/out.png", "93.184.216.34"], ["https://localhost/out.png", "93.184.216.34"], ["https://127.0.0.1/out.png", "93.184.216.34"], ["https://images.example.com/out.png", "10.0.0.1"], ["https://images.example.com/out.png", "::ffff:127.0.0.1"], ["https://images.example.com/out.png", "2001:0db8::1"], ["https://images.example.com:444/out.png", "93.184.216.34"]]) {
      await assert.rejects(() => generateDesignImage(input(), workspace, {
        fetch: (async () => response({ data: [{ url }] })) as typeof fetch,
        lookup: async () => [{ address: address!, family: address!.includes(":") ? 6 : 4 }],
        download: async () => { downloads++; return { bytes: output, contentType: "image/png" }; },
      }), /HTTPS|内网|保留地址/);
    }
    assert.equal(downloads, 0);
  });
  await test("validated public DNS answers are pinned for download; mixed public/private answers fail closed", async () => {
    const url = "https://images.example.com/output.png?signed=fixture", records = [{ address: "93.184.216.34", family: 4 }]; let downloads = 0;
    const dependencies: Dependencies = { fetch: (async () => response({ data: [{ url }] })) as typeof fetch, lookup: async () => records,
      download: async (selected, addresses, signal) => { downloads++; assert.equal(selected.toString(), url); assert.deepEqual(addresses, records); assert.equal(signal.aborted, false); return { bytes: output, contentType: "image/png" }; } };
    assert.equal((await generateDesignImage(input(), workspace, dependencies)).images[0]?.width, 64); assert.equal(downloads, 1);
    await assert.rejects(() => generateDesignImage(input(), workspace, { ...dependencies, lookup: async () => [...records, { address: "192.168.0.1", family: 4 }] }), /内网/);
    assert.equal(downloads, 1);
  });
  await test("aborted requests never retry, and cancellation interrupts pending result DNS lookup", async () => {
    const controller = new AbortController(); controller.abort(); let calls = 0;
    await assert.rejects(() => generateDesignImage({ ...input(), signal: controller.signal }, workspace, { fetch: (async () => { calls++; return response({}); }) as typeof fetch }), /已取消/);
    assert.equal(calls, 0);
    const waiting = new AbortController();
    const promise = generateDesignImage({ ...input(), signal: waiting.signal }, workspace, { fetch: (async () => response({ data: [{ url: "https://images.example.com/out.png" }] })) as typeof fetch, lookup: async () => new Promise(() => {}) });
    setTimeout(() => waiting.abort(), 30);
    await assert.rejects(() => promise, /已取消/);
  });
  await test("bounded supplier JSON and malformed output are rejected without leaking bytes", async () => {
    const tooLarge = new Response("{}", { headers: { "content-length": String(17 * 1024 * 1024) } });
    await assert.rejects(() => generateDesignImage(input(), workspace, { fetch: (async () => tooLarge) as typeof fetch }), /内容过大/);
    await assert.rejects(() => generateDesignImage(input(), workspace, { fetch: (async () => response({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] })) as typeof fetch }), /PNG/);
    await assert.rejects(() => generateDesignImage(input(), workspace, { fetch: (async () => response({ data: [{ b64_json: output.toString("base64") }, { b64_json: output.toString("base64") }] })) as typeof fetch }), /一张/);
  });
  await test("revision/endpoint tampering cannot reuse a stored credential, and clear disables inherited fallback", async () => {
    const file = path.join(homeA, "settings.json"), settings = JSON.parse(await readFile(file, "utf8"));
    settings.whiteboardDesignImage.baseURL = "https://attacker.invalid/v1/images/edits";
    await writeFile(file, JSON.stringify(settings)); assert.equal((await getDesignImageConfig(workspace)).configured, false);
    let calls = 0;
    await assert.rejects(() => generateDesignImage(input(), workspace, { fetch: (async () => { calls++; return response({}); }) as typeof fetch }), /先配置/);
    assert.equal(calls, 0);
    const cleared = await saveDesignImageConfig({ clear: true }, workspace); assert.equal(cleared.configured, false); assert.equal(cleared.source, "none");
    const credential = new SecureCredentialStore(path.join(homeA, "credentials", "design-image.json")); assert.equal(await credential.read(), null);
  });
  console.log(`Design image provider: ${passed} checks passed; no supplier calls or installations.`);
} finally {
  for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
  Object.assign(process.env, previous);
  const resolved = path.resolve(temporary), allowed = path.resolve(os.tmpdir()) + path.sep;
  if (resolved.startsWith(allowed) && path.basename(resolved).startsWith("ccagent-design-provider-")) await rm(resolved, { recursive: true, force: true });
}
