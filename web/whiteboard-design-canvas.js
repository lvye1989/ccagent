/** Pure raster and scene rules shared by the real Excalidraw editor and tests. */
export const DESIGN_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const DESIGN_SCENE_MAX_BYTES = 10 * 1024 * 1024;
export const DESIGN_IMAGE_MAX_PIXELS = 32 * 1024 * 1024;
export const DESIGN_BASE_MAX_EDGE = 2048;
export const DESIGN_REFERENCE_LIMIT = 2;
const ROLES = new Set(["base", "reference", "result"]);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const u16 = (bytes, offset) => (bytes[offset] << 8) | bytes[offset + 1];
const u32 = (bytes, offset) => ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]);
const le32 = (bytes, offset) => (bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16) + bytes[offset + 3] * 0x1000000);
const ascii = (bytes, offset, size) => String.fromCharCode(...bytes.subarray(offset, offset + size));

function rasterDimensions(bytes, mimeType) {
  if (mimeType === "image/png" && bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) && ascii(bytes, 12, 4) === "IHDR") return { width: u32(bytes, 16), height: u32(bytes, 20) };
  if (mimeType === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if ([0xd9, 0xda].includes(marker)) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = u16(bytes, offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) return { width: u16(bytes, offset + 5), height: u16(bytes, offset + 3) };
      offset += length;
    }
  }
  if (mimeType === "image/webp" && bytes.length >= 20 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP" && le32(bytes, 4) + 8 === bytes.length) {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const kind = ascii(bytes, offset, 4), length = le32(bytes, offset + 4), start = offset + 8;
      if (start + length > bytes.length) break;
      if (kind === "VP8X" && length >= 10) return { width: 1 + bytes[start + 4] + (bytes[start + 5] << 8) + (bytes[start + 6] << 16), height: 1 + bytes[start + 7] + (bytes[start + 8] << 8) + (bytes[start + 9] << 16) };
      if (kind === "VP8L" && length >= 5 && bytes[start] === 0x2f) return { width: 1 + bytes[start + 1] + ((bytes[start + 2] & 0x3f) << 8), height: 1 + (bytes[start + 2] >> 6) + (bytes[start + 3] << 2) + ((bytes[start + 4] & 0x0f) << 10) };
      if (kind === "VP8 " && length >= 10 && bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) return { width: (bytes[start + 6] | (bytes[start + 7] << 8)) & 0x3fff, height: (bytes[start + 8] | (bytes[start + 9] << 8)) & 0x3fff };
      offset = start + length + (length % 2);
    }
  }
  throw new Error("图片内容与格式不符，请重新导出 PNG、JPEG 或 WebP 图片。");
}

export function validateDesignImage(value) {
  if (!value || typeof value !== "object" || !["image/png", "image/jpeg", "image/webp"].includes(value.mimeType) || typeof value.dataURL !== "string") throw new Error("仅支持 PNG、JPEG 和 WebP 图片。");
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.dataURL);
  if (!match || match[1] !== value.mimeType || match[2].length % 4 || match[2].length > Math.ceil(DESIGN_IMAGE_MAX_BYTES / 3) * 4) throw new Error("图片编码无效或图片超过 10MB，请缩小图片后重试。");
  let binary;
  try { binary = atob(match[2]); } catch { throw new Error("图片编码无效。"); }
  if (binary.length > DESIGN_IMAGE_MAX_BYTES || btoa(binary) !== match[2]) throw new Error("图片编码无效或图片超过 10MB。");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const dimensions = rasterDimensions(bytes, value.mimeType);
  if (!Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height) || dimensions.width < 1 || dimensions.height < 1 || dimensions.width * dimensions.height > DESIGN_IMAGE_MAX_PIXELS || dimensions.width > 32768 || dimensions.height > 32768) throw new Error("图片尺寸过大，请使用不超过 3200 万像素的图片。");
  if (value.width !== dimensions.width || value.height !== dimensions.height) throw new Error("图片尺寸与实际内容不符，请重新导入图片。");
  const name = typeof value.name === "string" ? value.name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120).trim() : "";
  return { dataURL: value.dataURL, mimeType: value.mimeType, ...dimensions, name: name || "设计图片" };
}

export function designMetadata(element) {
  const metadata = element?.customData?.ccagentDesign;
  return metadata?.version === 1 && ROLES.has(metadata.role) ? metadata : undefined;
}

function bounds(element) {
  const { x, y, width, height } = element;
  if (![x, y, width, height].every(finite)) return undefined;
  const angle = finite(element.angle) ? element.angle : 0, halfWidth = Math.abs(width * Math.cos(angle) / 2) + Math.abs(height * Math.sin(angle) / 2), halfHeight = Math.abs(width * Math.sin(angle) / 2) + Math.abs(height * Math.cos(angle) / 2), stroke = Math.max(0, Number(element.strokeWidth) || 0) / 2;
  return { left: x + width / 2 - halfWidth - stroke, top: y + height / 2 - halfHeight - stroke, right: x + width / 2 + halfWidth + stroke, bottom: y + height / 2 + halfHeight + stroke };
}

function alive(elements) { return elements.filter((element) => !element.isDeleted); }
export function selectDesignBase(elements, baseImageId) {
  const candidates = alive(elements).filter((element) => element.type === "image" && designMetadata(element)?.role === "base");
  const base = baseImageId ? candidates.find((element) => element.id === baseImageId) : candidates.at(-1);
  if (!base) throw new Error("请先导入需要勾画的原图。");
  return base;
}

/** No live elements are changed. A fresh base starts beside existing drawings. */
export function buildDesignImageSkeleton(elements, image, role, { imageId, fileId, baseImageId, requestId } = {}) {
  if (!ROLES.has(role) || !/^[A-Za-z0-9_-]{1,128}$/.test(imageId || "") || !/^[A-Za-z0-9_-]{1,128}$/.test(fileId || "")) throw new Error("设计图片操作无效。");
  if (role === "base" && Math.max(image.width, image.height) > DESIGN_BASE_MAX_EDGE) throw new Error("原图边长不能超过 2048 像素，请缩小图片后重新导入。");
  const active = alive(elements), base = role === "base" || (role === "result" && !baseImageId) ? undefined : selectDesignBase(elements, baseImageId);
  const related = base ? active.filter((element) => designMetadata(element)?.baseImageId === base.id) : [];
  const references = related.filter((element) => designMetadata(element)?.role === "reference");
  if (role === "reference" && references.length >= DESIGN_REFERENCE_LIMIT) throw new Error("每张原图最多使用 2 张参考图，请先删除不用的参考图。");
  const maxWidth = role === "reference" ? 320 : 960, maxHeight = role === "reference" ? 240 : 720;
  const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height), width = image.width * scale, height = image.height * scale;
  let x = 0, y = 0;
  if (!base) {
    const boxes = active.map(bounds).filter(Boolean);
    if (boxes.length) { x = Math.max(...boxes.map((box) => box.right)) + 96; y = Math.min(...boxes.map((box) => box.top)); }
  } else if (role === "reference") {
    x = base.x + base.width + 64; y = base.y + references.reduce((sum, element) => sum + element.height + 40, 0);
  } else {
    const results = related.filter((element) => designMetadata(element)?.role === "result");
    x = base.x + results.reduce((sum, element) => sum + element.width + 64, 0); y = base.y + base.height + 96;
  }
  const metadata = { version: 1, role, name: image.name, width: image.width, height: image.height, ...(base ? { baseImageId: base.id } : {}), ...(requestId ? { requestId } : {}) };
  return { type: "image", id: imageId, x, y, width, height, angle: 0, fileId, status: "saved", scale: [1, 1], crop: null, locked: role === "base", customData: { ccagentDesign: metadata } };
}

function imageData(element, files) {
  const file = files[element.fileId];
  const image = validateDesignImage({ ...file, width: designMetadata(element)?.width, height: designMetadata(element)?.height, name: designMetadata(element)?.name });
  return { elementId: element.id, ...image };
}

/** Export a temporary frame; never add crop frames or clear references on the live board. */
export function designExportPlan(elements, files, baseImageId) {
  const base = selectDesignBase(elements, baseImageId), original = imageData(base, files);
  if (Math.max(original.width, original.height) > DESIGN_BASE_MAX_EDGE) throw new Error("原图边长不能超过 2048 像素，请缩小图片后重新导入。");
  if (!finite(base.angle) || Math.abs(base.angle) > 0.000001 || base.crop || base.scale?.[0] !== 1 || base.scale?.[1] !== 1 || !finite(base.width) || !finite(base.height) || base.width <= 0 || base.height <= 0 || Math.abs((base.width / base.height) / (original.width / original.height) - 1) > 0.000001) throw new Error("原图已旋转、裁剪、翻转或改变比例，请恢复原图比例后再生成。");
  const area = { left: base.x, top: base.y, right: base.x + base.width, bottom: base.y + base.height };
  const renderable = alive(elements).filter((element) => {
    if (["frame", "magicframe", "iframe", "embeddable"].includes(element.type)) return false;
    if (element.id !== base.id && designMetadata(element)) return false;
    const box = bounds(element);
    return box && box.right >= area.left && box.left <= area.right && box.bottom >= area.top && box.top <= area.bottom;
  }).map((element) => ({ ...element, frameId: null }));
  const referenceElements = alive(elements).filter((element) => element.type === "image" && designMetadata(element)?.role === "reference" && designMetadata(element)?.baseImageId === base.id);
  if (referenceElements.length > DESIGN_REFERENCE_LIMIT) throw new Error("参考图超过 2 张，请先删除不用的参考图。");
  const width = original.width, height = original.height;
  return {
    base: original, references: referenceElements.map((element) => imageData(element, files)), elements: renderable,
    frame: { type: "frame", id: "ccagent_design_export_frame", x: base.x, y: base.y, width: base.width, height: base.height, angle: 0, children: [], name: null },
    width, height, scale: width / base.width, hasMarkup: renderable.some((element) => element.id !== base.id),
  };
}

export function assertDesignSceneSize(scene) {
  if (new TextEncoder().encode(JSON.stringify(scene)).byteLength > DESIGN_SCENE_MAX_BYTES) throw new Error("导入后画布将超过 10MB，请缩小图片或删除不用的图片后重试。");
}
