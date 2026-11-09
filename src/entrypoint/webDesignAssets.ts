import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requirePlatformScope } from "../platform/account.js";
import { DesignImageError, validateDesignRaster, type DesignRaster } from "../services/images/designImageProvider.js";

const TTL = 30 * 60_000, MAX_TOTAL = 480 * 1024 * 1024;
type Asset = { id: string; owner: string; workspace: string; path: string; size: number; created: number; mimeType: DesignRaster["mimeType"]; width: number; height: number; name?: string };
/** Process-local upload receipts. Never load a client-provided filesystem path. */
export function createDesignAssets(getWorkspace: () => string) {
  const assets = new Map<string, Asset>();
  let directory: Promise<string> | undefined, reserved = 0, disposed = false;
  function invalid(message: string, status = 400): never { throw new DesignImageError(message, status, "DESIGN_ASSET_INVALID"); }
  const erase = async (asset: Asset) => { if (assets.delete(asset.id)) { reserved -= asset.size; await rm(asset.path, { force: true }); } };
  const prune = async () => { for (const asset of assets.values()) if (Date.now() - asset.created >= TTL) await erase(asset); };
  const timer = setInterval(() => { void prune().catch(() => {}); }, 60_000); timer.unref();
  async function scope(workspace: string) { const account = await requirePlatformScope(0); if (disposed || workspace !== getWorkspace()) invalid("工作文件夹已切换，请重新上传参考图。", 409); return account.user.id; }
  return {
    async upload(workspace: string, value: unknown) {
      const owner = await scope(workspace); await prune();
      const image = validateDesignRaster(value), bytes = Buffer.from(image.dataURL.split(",")[1]!, "base64");
      if (assets.size >= 32 || reserved + bytes.length > MAX_TOTAL) invalid("临时图片空间已满，请移除不用的图片或稍后重试。", 413);
      reserved += bytes.length;
      const id = randomUUID();
      directory ??= mkdtemp(path.join(os.tmpdir(), "ccagent-design-assets-"));
      const root = await directory, file = path.join(root, id);
      try {
        await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
        if (await scope(workspace) !== owner) invalid("当前账户已切换，请重新上传图片。", 409);
        const asset: Asset = { id, owner, workspace, path: file, size: bytes.length, created: Date.now(), mimeType: image.mimeType, width: image.width, height: image.height, name: image.name };
        assets.set(id, asset);
        return { assetId: id, mimeType: image.mimeType, width: image.width, height: image.height, name: image.name, expiresAt: new Date(asset.created + TTL).toISOString() };
      } catch (error) { reserved -= bytes.length; await rm(file, { force: true }).catch(() => {}); throw error; }
    },
    async read(workspace: string, ids: string[]): Promise<DesignRaster[]> {
      const owner = await scope(workspace); await prune();
      if (!Array.isArray(ids) || ids.length > 16 || new Set(ids).size !== ids.length) invalid("输入图片数量无效。");
      const output: DesignRaster[] = [];
      for (const id of ids) {
        const asset = assets.get(id);
        if (!asset || asset.owner !== owner || asset.workspace !== workspace) invalid("临时图片不存在或已过期，请重新上传。", 410);
        const info = await lstat(asset.path);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== asset.size) invalid("临时图片文件无效。");
        output.push(validateDesignRaster({ ...asset, dataURL: `data:${asset.mimeType};base64,${(await readFile(asset.path)).toString("base64")}` }));
      }
      if (await scope(workspace) !== owner) invalid("当前账户已切换。", 409);
      return output;
    },
    async remove(workspace: string, id: string) { const owner = await scope(workspace), asset = assets.get(id); if (!asset || asset.owner !== owner || asset.workspace !== workspace) invalid("临时图片不存在。", 404); await erase(asset); return { removed: true }; },
    dispose() { disposed = true; clearInterval(timer); for (const asset of assets.values()) void erase(asset).catch(() => {}); void directory?.then(root => rmdir(root).catch(() => {})).catch(() => {}); },
  };
}
