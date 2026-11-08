import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { getCCAgentPath } from "../utils/paths.js";
import { withFileTransaction, writeJsonAtomically } from "../utils/fileTransaction.js";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ELEMENTS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ELEMENT_TYPES = new Set(["rectangle", "diamond", "ellipse", "line", "arrow", "freedraw", "text", "image", "frame", "magicframe"]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
type JsonObject = Record<string, unknown>;
export type WhiteboardScene = { type: "excalidraw"; version: 2; elements: JsonObject[]; appState: JsonObject; files: JsonObject };
export type WhiteboardMetadata = { id: string; name: string; revision: number; createdAt: string; updatedAt: string; elementCount: number };
export type Whiteboard = WhiteboardMetadata & { scene: WhiteboardScene };
type Store = { workspace: string; home: string; root: string; directory: string };

export class WhiteboardError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "invalid_whiteboard") { super(message); this.name = "WhiteboardError"; }
}
export class WhiteboardConflictError extends WhiteboardError {
  constructor() { super("画布已被其他窗口更新，请重新打开后再保存。", 409, "conflict"); this.name = "WhiteboardConflictError"; }
}
function invalid(message = "画布数据格式无效。", status = 400): never { throw new WhiteboardError(message, status); }
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !DANGEROUS_KEYS.has(value);
const samePath = (left: string, right: string): boolean => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;

/** Reject non-JSON values and prototype keys before copying or storing input. */
function jsonCopy(value: unknown): unknown {
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (depth > 64) invalid("画布数据嵌套过深。");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") { if (!Number.isFinite(item)) invalid(); return; }
    if (typeof item !== "object" || !item) invalid();
    if (ancestors.has(item)) invalid();
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) invalid();
    ancestors.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (DANGEROUS_KEYS.has(key)) invalid("画布数据包含不支持的字段。");
      visit(child, depth + 1);
    }
    ancestors.delete(item);
  }
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) invalid("画布数据不能超过 10MB。", 413);
  return JSON.parse(serialized) as unknown;
}

function boardName(value: unknown, fallback = "未命名画布"): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) invalid("画布名称需为 160 字以内的文本。");
  return value.trim() || fallback;
}

function validLink(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (typeof value !== "string" || value.length > 4096 || value.trim() !== value || /[\u0000-\u0020\u007f]/.test(value)) return false;
  if (!/^(?:https?:\/\/|mailto:)/i.test(value)) return false;
  try { return ["http:", "https:", "mailto:"].includes(new URL(value).protocol); }
  catch { return false; }
}

/** Only raster image bytes can enter Excalidraw's binary-file map. */
function sceneFiles(value: JsonObject): JsonObject {
  const files: JsonObject = {};
  for (const [key, file] of Object.entries(value)) {
    if (!identifier(key) || !object(file) || file.id !== key || !finite(file.created) || file.created < 0 || typeof file.dataURL !== "string") invalid("画布图片数据无效。");
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(file.dataURL);
    if (!match || match[1] !== file.mimeType || match[2]!.length % 4 !== 0) invalid("仅支持内嵌 PNG、JPEG、WEBP 和 GIF 图片。");
    const bytes = Buffer.from(match[2]!, "base64");
    if (bytes.toString("base64") !== match[2]) invalid("画布图片编码无效。");
    const mime = match[1];
    const signature = mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mime === "image/jpeg" ? bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : mime === "image/gif" ? ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
      : bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    if (!signature) invalid("画布图片内容与格式不符。");
    const entry: JsonObject = { id: key, mimeType: file.mimeType, dataURL: file.dataURL, created: file.created };
    for (const field of ["lastRetrieved", "version"]) {
      if (file[field] !== undefined) {
        if (!finite(file[field]) || (file[field] as number) < 0) invalid("画布图片元数据无效。");
        entry[field] = file[field];
      }
    }
    files[key] = entry;
  }
  return files;
}

const STYLE_ENUMS: Record<string, readonly string[]> = {
  currentItemFillStyle: ["hachure", "cross-hatch", "solid", "zigzag"], currentItemStrokeStyle: ["solid", "dashed", "dotted"],
  currentItemTextAlign: ["left", "center", "right"], currentItemRoundness: ["round", "sharp"], currentItemArrowType: ["sharp", "round", "elbow"], theme: ["light", "dark"],
};
function appState(value: JsonObject): JsonObject {
  const state: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (["viewBackgroundColor", "currentItemStrokeColor", "currentItemBackgroundColor"].includes(key)) {
      if (typeof item !== "string" || item.length > 128 || !/^(?:#[0-9a-f]{3,8}|[a-z]{1,32}|(?:rgba?|hsla?)\([\d.,%+\s-]+\))$/i.test(item)) invalid("画布颜色设置无效。");
    } else if (Object.hasOwn(STYLE_ENUMS, key)) {
      if (typeof item !== "string" || !STYLE_ENUMS[key]!.includes(item)) invalid("画布样式设置无效。");
    } else if (["scrollX", "scrollY", "gridSize", "gridStep", "currentItemStrokeWidth", "currentItemRoughness", "currentItemOpacity", "currentItemFontFamily", "currentItemFontSize", "exportScale"].includes(key)) {
      if (item === null && key === "gridSize") { state[key] = item; continue; }
      if (!finite(item) || (!key.startsWith("scroll") && item < 0)) invalid("画布数值设置无效。");
      if (key === "currentItemOpacity" && item > 100) invalid();
    } else if (["gridModeEnabled", "zenModeEnabled", "exportBackground", "exportEmbedScene", "exportWithDarkMode"].includes(key)) {
      if (typeof item !== "boolean") invalid();
    } else if (["currentItemStartArrowhead", "currentItemEndArrowhead"].includes(key)) {
      if (item !== null && (typeof item !== "string" || !/^[a-z-]{1,40}$/.test(item))) invalid();
    } else if (key === "zoom") {
      if (!object(item) || !finite(item.value) || item.value <= 0 || item.value > 1000) invalid("画布缩放设置无效。");
      state.zoom = { value: item.value }; continue;
    } else continue; // Selection, collaborators, dialogs and runtime defaults stay local.
    state[key] = item;
  }
  return state;
}

function cleanScene(input: unknown): WhiteboardScene {
  const value = jsonCopy(input);
  if (!object(value) || value.type !== "excalidraw" || value.version !== 2 || !Array.isArray(value.elements) || !object(value.appState) || !object(value.files)) invalid();
  if (value.elements.length > MAX_ELEMENTS) invalid("画布元素不能超过 10000 个。", 413);
  const files = sceneFiles(value.files);
  const ids = new Set<string>();
  const elements: JsonObject[] = [];
  for (const element of value.elements) {
    if (!object(element) || !identifier(element.id) || ids.has(element.id) || typeof element.type !== "string" || !ELEMENT_TYPES.has(element.type)) invalid("画布包含无效或不支持的元素。");
    ids.add(element.id);
    for (const field of ["x", "y", "width", "height", "angle"]) if (!finite(element[field])) invalid("画布元素坐标无效。");
    if ((element.width as number) < 0 || (element.height as number) < 0) invalid("画布元素尺寸无效。");
    for (const field of ["strokeWidth", "roughness", "opacity", "seed", "version", "versionNonce", "updated", "fontSize", "fontFamily"]) {
      if (element[field] !== undefined && !finite(element[field])) invalid("画布元素数值无效。");
    }
    if (element.isDeleted !== undefined && typeof element.isDeleted !== "boolean") invalid();
    if (!validLink(element.link)) invalid("画布链接仅支持 HTTP、HTTPS 或 mailto。");
    if (["line", "arrow", "freedraw"].includes(element.type)) {
      if (!Array.isArray(element.points) || !element.points.every((point) => Array.isArray(point) && point.length === 2 && point.every(finite))) invalid("画布线条坐标无效。");
    }
    if (element.type === "text" && typeof element.text !== "string") invalid("画布文字无效。");
    if (element.type === "image" && (!identifier(element.fileId) || (!element.isDeleted && !Object.hasOwn(files, element.fileId)))) invalid("画布图片文件缺失。");
    elements.push(element);
  }
  return { type: "excalidraw", version: 2, elements, appState: appState(value.appState), files };
}

/** Refuse symlinks/junctions in every private-store ancestor before creating it. */
async function noLinkedDirectories(directory: string, allowMissing = false): Promise<void> {
  const root = path.parse(directory).root;
  let current = root;
  for (const segment of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (info.isSymbolicLink() || !info.isDirectory()) invalid("白板私有存储目录不安全。", 500);
  }
}
async function storeFor(workspace: string): Promise<Store> {
  if (!path.isAbsolute(workspace)) invalid("工作文件夹无效。");
  const canonical = await realpath(workspace);
  if (!(await lstat(canonical)).isDirectory()) invalid("工作文件夹无效。");
  const key = createHash("sha256").update(canonical).digest("hex");
  const directory = path.resolve(getCCAgentPath("whiteboards", key));
  const root = path.dirname(directory), home = path.dirname(root);
  await noLinkedDirectories(directory, true);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const store = { workspace: canonical, home, root, directory };
  await assertStore(store);
  return store;
}
async function assertStore(store: Store): Promise<void> {
  await noLinkedDirectories(store.directory);
  if (!samePath(await realpath(store.directory), store.directory)) invalid("白板私有存储目录不安全。", 500);
}
async function regularFile(file: string, allowMissing = false): Promise<void> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) invalid("白板存储文件不安全。", 500);
  } catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}
async function assertTransaction(store: Store, file: string): Promise<void> {
  await assertStore(store);
  await regularFile(file, true);
  await regularFile(`${file}.transaction`, true);
  try {
    const lock = await lstat(`${file}.transaction.lock`);
    if (lock.isSymbolicLink() || !lock.isDirectory()) invalid("白板存储锁不安全。", 500);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function metadata(board: Whiteboard): WhiteboardMetadata {
  const { id, name, revision, createdAt, updatedAt, elementCount } = board;
  return { id, name, revision, createdAt, updatedAt, elementCount };
}
async function readBoard(store: Store, id: string): Promise<Whiteboard> {
  const file = path.join(store.directory, `${id}.json`);
  await assertStore(store);
  try { await regularFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WhiteboardError("画布不存在。", 404, "not_found"); throw error; }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let value: unknown;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES) invalid("画布存储文件无效。", 500);
    value = JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally { await handle.close(); }
  await assertStore(store);
  if (!object(value) || value.id !== id || typeof value.name !== "string" || boardName(value.name) !== value.name || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 1 || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) invalid("画布存储数据无效。", 500);
  const scene = cleanScene(value.scene);
  return { id, name: value.name, revision: value.revision as number, createdAt: value.createdAt, updatedAt: value.updatedAt,
    elementCount: scene.elements.filter((element) => !element.isDeleted).length, scene };
}
async function persist(store: Store, board: Whiteboard): Promise<void> {
  const file = path.join(store.directory, `${board.id}.json`);
  await assertTransaction(store, file);
  if (Buffer.byteLength(JSON.stringify(board, null, 2) + "\n", "utf8") > MAX_BYTES) invalid("画布数据不能超过 10MB。", 413);
  await writeJsonAtomically(file, board);
}

/** Account-private and canonical-workspace-private Excalidraw document actions. */
export async function handleWhiteboard(action: string, input: Record<string, unknown>, workspace: string): Promise<
  { workspace: string; boards: WhiteboardMetadata[] } | { workspace: string; board: Whiteboard | WhiteboardMetadata }
> {
  try {
    if (!["list", "create", "open", "save"].includes(action)) invalid("不支持的白板操作。");
    jsonCopy(input);
    const id = action === "open" || action === "save" ? input.id : undefined;
    if ((action === "open" || action === "save") && (typeof id !== "string" || !UUID.test(id))) invalid("画布 ID 无效。");
    if (action === "save" && (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1)) invalid("保存时必须提供有效的画布版本。");
    const name = action === "create" ? boardName(input.name) : input.name === undefined ? undefined : boardName(input.name);
    const scene = action === "create" ? cleanScene(input.scene === undefined ? { type: "excalidraw", version: 2, elements: [], appState: {}, files: {} } : input.scene)
      : action === "save" ? cleanScene(input.scene) : undefined;
    const store = await storeFor(workspace);
    if (action === "list") {
      const entries = await readdir(store.directory);
      const boards: WhiteboardMetadata[] = [];
      for (const entry of entries) if (entry.endsWith(".json") && UUID.test(entry.slice(0, -5))) boards.push(metadata(await readBoard(store, entry.slice(0, -5))));
      boards.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
      return { workspace: store.workspace, boards };
    }
    if (action === "open") return { workspace: store.workspace, board: await readBoard(store, id as string) };
    const boardId = action === "create" ? randomUUID() : id as string;
    const file = path.join(store.directory, `${boardId}.json`);
    await assertTransaction(store, file);
    return await withFileTransaction(file, async () => {
      await assertTransaction(store, file);
      const previous = action === "save" ? await readBoard(store, boardId) : undefined;
      if (previous && previous.revision !== input.revision) throw new WhiteboardConflictError();
      if (previous && previous.revision >= Number.MAX_SAFE_INTEGER) invalid("画布版本已超出可保存范围。", 409);
      const now = new Date().toISOString();
      const board: Whiteboard = { id: boardId, name: name ?? previous?.name ?? "未命名画布", revision: (previous?.revision ?? 0) + 1,
        createdAt: previous?.createdAt ?? now, updatedAt: now, elementCount: scene!.elements.filter((element) => !element.isDeleted).length, scene: scene! };
      await persist(store, board);
      return { workspace: store.workspace, board: action === "create" ? board : metadata(board) };
    });
  } catch (error) {
    if (error instanceof WhiteboardError) throw error;
    throw new WhiteboardError("白板数据暂时无法读取或保存，请检查私有存储目录。", 500, "storage_error");
  }
}
