/** Pure raster/routing gates; end-to-end gateway coverage lives in test-kie-native-images. */
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { validateDesignRaster, validateImageGenerationOptions, selectDesignImageRoute, saveDesignImageConfig, type DesignImageConfig } from "../services/images/designImageProvider.js";
function crc32(bytes: Buffer): number { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; }
function png(width = 64, height = 48): Buffer {
  const chunk = (name: string, data: Buffer) => { const type = Buffer.from(name), head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(Buffer.concat([type, data]))); return Buffer.concat([head, type, data, tail]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk("IEND", Buffer.alloc(0))]);
}
const image = (bytes: Buffer) => ({ dataURL: "data:image/png;base64," + bytes.toString("base64") });
assert.equal(validateDesignRaster(image(png())).width, 64);
assert.throws(() => validateDesignRaster({ ...image(png()), width: 65 }), /实际内容/);
assert.throws(() => validateDesignRaster({ dataURL: "data:image/svg+xml;base64,PHN2Zy8+" }), /PNG/);
assert.throws(() => validateDesignRaster({ dataURL: image(png()).dataURL.slice(0, -4) }), /PNG|Base64/);
const large = image(png(4097, 4097)); assert.throws(() => validateDesignRaster(large), /输入图片尺寸/); assert.equal(validateDesignRaster(large, "output").width, 4097);
const tooWide = png(); tooWide.writeUInt32BE(8193, 16); assert.throws(() => validateDesignRaster(image(tooWide), "output"), /生成图片尺寸/);
assert.throws(() => validateImageGenerationOptions({ aspect_ratio: "27:16", resolution: "4K" }), /仅支持 1K/);
assert.throws(() => validateImageGenerationOptions({ resolution: "2K", background: "transparent" }), /仅支持 1K/);
assert.equal(validateImageGenerationOptions({ resolution: "4K" }).background, undefined);
const routes = ["flare", "sunburst"].flatMap(variant => ["text-to-image", "image-to-image"].map(mode => ({ id: `${variant}-${mode}`, name: variant, upstreamModel: `gpt-image-2-5-${variant}-${mode}` })));
const config: DesignImageConfig = { configured: true, provider: "official", model: "sunburst-image-to-image", baseURL: "", source: "official", hasKey: true, maxReferences: 16, routes, defaultExplicit: true };
assert.equal(selectDesignImageRoute(config, 0).id, "sunburst-text-to-image"); assert.equal(selectDesignImageRoute(config, 1).id, "sunburst-image-to-image");
assert.throws(() => selectDesignImageRoute({ ...config, routes: routes.filter(route => route.id !== "sunburst-text-to-image") }, 0), /暂未开放/);
assert.equal(selectDesignImageRoute({ ...config, defaultExplicit: false, routes: routes.filter(route => route.id !== "sunburst-text-to-image") }, 0).id, "flare-text-to-image");
await assert.rejects(saveDesignImageConfig({ provider: "openai", apiKey: "ignored-legacy-key" }, "."), /管理员统一管理/);
console.log("Design image provider gates passed: actual raster bytes, explicit input/output bounds, generation options, gateway default and same-family pairing, unavailable mode, and removed personal configuration.");
