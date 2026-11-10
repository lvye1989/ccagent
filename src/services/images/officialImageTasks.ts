import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { getCCAgentPath } from "../../utils/paths.js";
import { withFileTransaction, writeJsonAtomically } from "../../utils/fileTransaction.js";
import { getPlatformGatewayClient, PlatformServiceError } from "../../platform/gatewayClient.js";
import { readServiceBinding } from "../../platform/serviceState.js";
import type { DesignRaster } from "./designImageProvider.js";

type Gateway = Pick<Awaited<ReturnType<typeof getPlatformGatewayClient>>, "uploadPrivateImage" | "call" | "callStatus" | "imageTaskStatus" | "download">;
type Receipt = { version: 1; requestId: string; userId: string; origin: string; keyHash: string; model: string; fingerprint: string; inputFileIds: string[]; state: "uploading" | "sending" | "created" | "unknown" | "completed" | "failed"; taskId?: string; updatedAt: number };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const error = (message: string, code = "DESIGN_IMAGE_UNKNOWN"): never => { throw new PlatformServiceError(message, code, 409); };
const taskMessages: Record<string, string> = {
  IMAGE_INPUT_UPLOAD_FAILED: "参考图上传失败，尚未提交生成，预留额度已释放。请重新发起生成；若仍失败，请联系管理员检查图像上传服务。",
  IMAGE_SUPPLIER_REJECTED: "图像服务未接受本次请求，预留额度已释放。请检查生成参数或联系管理员。",
  IMAGE_GENERATION_FAILED: "图像服务生成失败，预留额度已释放。请调整绘图要求后重新生成。",
  IMAGE_CREATE_UNCONFIRMED: "图像请求的提交结果待确认，请继续查询原任务。",
  IMAGE_RESULT_UNCONFIRMED: "图像结果暂未核实，请继续查询原任务。",
  IMAGE_RECONCILIATION_REQUIRED: "图像任务等待服务端核对，请保留调用编号并联系管理员。",
  IMAGE_CALL_CLOSED: "图像调用已关闭，结果未核实，预留额度已释放。",
};
const receiptsFile = () => getCCAgentPath("platform", "image-task-receipts.json");
async function readReceipts(): Promise<Receipt[]> {
  const info = await lstat(receiptsFile()).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return [];
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 2 * 1024 * 1024) return error("本地图像回执无效，请检查原调用记录。");
  const data: unknown = JSON.parse(await readFile(receiptsFile(), "utf8"));
  if (!Array.isArray(data) || data.length > 512 || data.some(item => !item || item.version !== 1 || !uuid.test(item.requestId) || typeof item.userId !== "string" || typeof item.origin !== "string" || !/^[a-f0-9]{64}$/.test(item.keyHash) || !/^[a-f0-9]{64}$/.test(item.fingerprint) || !Array.isArray(item.inputFileIds) || item.inputFileIds.length > 16 || item.inputFileIds.some((id: unknown) => typeof id !== "string" || !uuid.test(id)) || item.taskId !== undefined && !uuid.test(item.taskId) || !["uploading", "sending", "created", "unknown", "completed", "failed"].includes(item.state) || !Number.isFinite(item.updatedAt))) return error("本地图像回执格式无效。");
  return data as Receipt[];
}
async function saveReceipt(receipt: Receipt) {
  // A short shared-index lock; slow uploads/create calls only hold their own request lock.
  await withFileTransaction(receiptsFile(), async () => {
    const data = (await readReceipts()).filter(item => item.requestId === receipt.requestId || !(["completed", "failed"].includes(item.state) && Date.now() - item.updatedAt > 24 * 60 * 60_000));
    const index = data.findIndex(item => item.requestId === receipt.requestId);
    if (index >= 0) data[index] = receipt;
    else { if (data.length >= 512) return error("待核对图像任务已达本机上限，请先继续查询原任务。", "DESIGN_IMAGE_CAPACITY"); data.push(receipt); }
    await writeJsonAtomically(receiptsFile(), data);
  });
}
async function completedResult(receipt: Receipt, gateway: Gateway, signal: AbortSignal, initial?: Record<string, unknown>) {
  try {
    const images = await result(receipt.taskId!, gateway, signal, initial);
    await saveReceipt({ ...receipt, state: "completed", updatedAt: Date.now() }); return { images, model: receipt.model };
  } catch (failure) {
    if (failure instanceof PlatformServiceError && failure.code === "DESIGN_IMAGE_FAILED") await saveReceipt({ ...receipt, state: "failed", updatedAt: Date.now() });
    throw failure;
  }
}
async function binding() {
  const value = await readServiceBinding(); if (!value) return error("请重新连接当前账户的官方服务。", "SERVICE_NOT_CONFIGURED");
  return { userId: value.configuration.userId, origin: value.configuration.origin, keyHash: createHash("sha256").update(value.credential.apiKey).digest("hex") };
}
function sameOwner(receipt: Receipt, current: Awaited<ReturnType<typeof binding>>) {
  if (receipt.userId !== current.userId || receipt.origin !== current.origin || receipt.keyHash !== current.keyHash) return error("原图像任务不属于当前账户、服务地址或平台 Key。", "ACCOUNT_CHANGED");
}
async function knownTask(receipt: Receipt, gateway: Gateway) {
  if (receipt.taskId) return receipt.taskId;
  const call = await gateway.callStatus(receipt.requestId);
  if (call && typeof call.id === "string" && uuid.test(call.id)) return call.id;
  return error(`原图像请求结果尚待确认；请继续查询原任务，不会重新提交。请求编号：${receipt.requestId}`);
}
async function wait(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
  });
}
async function result(taskId: string, gateway: Gateway, signal: AbortSignal, initial?: Record<string, unknown>) {
  let value = initial ?? await (await gateway.imageTaskStatus(taskId, signal)).json() as Record<string, unknown>;
  while (value.status === "queued" || value.status === "processing") {
    if (value.id !== taskId) return error("图像任务回执不匹配。");
    await wait(Math.max(500, Math.min(10000, Number(value.poll_after_ms) || 1500)), signal);
    value = await (await gateway.imageTaskStatus(taskId, signal)).json() as Record<string, unknown>;
  }
  if (value.id !== taskId) return error("图像任务回执不匹配。");
  if (value.status !== "succeeded") {
    const message = typeof value.code === "string" && Object.hasOwn(taskMessages, value.code) ? taskMessages[value.code] : value.status === "failed" ? "图像任务失败。" : "图像任务状态待核实，可继续查询原任务。";
    return error(`${message}调用编号：${taskId}`, value.status === "failed" ? "DESIGN_IMAGE_FAILED" : "DESIGN_IMAGE_UNKNOWN");
  }
  if (!Array.isArray(value.images) || value.images.length !== 1) return error("图像任务未返回一张有效结果。");
  const output: { mimeType: DesignRaster["mimeType"]; bytes: Uint8Array }[] = [];
  for (const image of value.images) {
    if (!image || typeof image.file_id !== "string" || !uuid.test(image.file_id) || !["image/png", "image/jpeg", "image/webp"].includes(image.mime_type)) return error("图像结果回执无效。");
    output.push({ mimeType: image.mime_type, bytes: await gateway.download(image.file_id, signal) });
  }
  return output;
}
export async function runOfficialImageTask(input: { requestId: string; model: string; prompt: string; images: DesignRaster[]; options: Record<string, string>; signal: AbortSignal }, injected?: Gateway) {
  if (!uuid.test(input.requestId)) return error("图像请求编号无效。");
  const current = await binding(), gateway = injected ?? await getPlatformGatewayClient();
  const hash = createHash("sha256").update(JSON.stringify([input.model, input.prompt, input.options]));
  for (const image of input.images) hash.update(image.mimeType).update(image.dataURL);
  const fingerprint = hash.digest("hex");
  let initial: Record<string, unknown> | undefined;
  const receipt = await withFileTransaction(`${receiptsFile()}.${input.requestId}`, async () => {
    const receipts = await readReceipts(); let receipt = receipts.find(item => item.requestId === input.requestId);
    if (receipt) { sameOwner(receipt, current); if (receipt.fingerprint !== fingerprint) return error("同一图像请求编号不能用于不同图片、模型或要求。", "IDEMPOTENCY_CONFLICT"); }
    else {
      receipt = { version: 1, requestId: input.requestId, ...current, model: input.model, fingerprint, inputFileIds: [], state: "uploading", updatedAt: Date.now() }; receipts.push(receipt);
      await saveReceipt(receipt);
    }
    const save = async () => { receipt!.updatedAt = Date.now(); await saveReceipt(receipt!); };
    if (receipt.state === "uploading") {
      for (let index = receipt.inputFileIds.length; index < input.images.length; index++) {
        input.signal.throwIfAborted(); const image = input.images[index]!;
        receipt.inputFileIds.push(await gateway.uploadPrivateImage(Buffer.from(image.dataURL.split(",")[1]!, "base64"), image.mimeType, input.signal)); await save();
      }
      // Durable send barrier: any crash/timeout after this point permits only GET recovery.
      receipt.state = "sending"; await save();
      try {
        initial = await (await gateway.call("images/tasks", { model: input.model, prompt: input.prompt, ...(receipt.inputFileIds.length ? { input_images: receipt.inputFileIds.map(id => `ccagent-file:${id}`) } : {}), ...input.options }, { requestId: input.requestId, signal: input.signal })).json() as Record<string, unknown>;
        if (typeof initial.id !== "string" || !uuid.test(initial.id)) return error("图像任务创建结果待确认，请继续查询原任务。");
        receipt.taskId = initial.id; receipt.state = "created"; await save();
      } catch (error) { receipt.state = "unknown"; await save(); throw error; }
    } else if (!receipt.taskId) { receipt.taskId = await knownTask(receipt, gateway); receipt.state = "created"; await save(); }
    return { ...receipt };
  });
  return completedResult(receipt, gateway, input.signal, initial);
}
/** Resume never needs images, uploads or another createTask request. */
export async function resumeOfficialImageTask(requestId: string, signal: AbortSignal, injected?: Gateway) {
  if (!uuid.test(requestId)) return error("图像请求编号无效。");
  const current = await binding(), gateway = injected ?? await getPlatformGatewayClient();
  const receipt = await withFileTransaction(`${receiptsFile()}.${requestId}`, async () => {
    const receipts = await readReceipts(), receipt = receipts.find(item => item.requestId === requestId);
    if (!receipt) return error("未找到原图像任务回执。", "DESIGN_IMAGE_NOT_FOUND"); sameOwner(receipt, current);
    if (receipt.state === "uploading") return error("原请求尚未提交模型，请重新发起生成。", "DESIGN_IMAGE_NOT_SUBMITTED");
    if (!receipt.taskId) { receipt.taskId = await knownTask(receipt, gateway); receipt.state = "created"; receipt.updatedAt = Date.now(); await saveReceipt(receipt); }
    return { ...receipt };
  });
  return completedResult(receipt, gateway, signal);
}
