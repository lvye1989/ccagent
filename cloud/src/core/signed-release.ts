import { z } from 'zod';
import { verifyManifest, type SignedUpdate } from '../../../desktop/update-manifest.cjs';
import { HttpError } from './http';

export const signedUpdateInput = z.custom<SignedUpdate>(value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  // Full shape, bounds and signature are checked before persistence. Keep stored
  // announcements readable after expiry; installation always re-verifies time.
  return JSON.stringify(value).length <= 16384;
});
export function validateSignedRelease(update: SignedUpdate, version: string, downloadUrl: string) {
  try {
    const keys = z.record(z.string(), z.string().max(8192)).parse(JSON.parse(process.env.CCAGENT_RELEASE_PUBLIC_KEYS || '{}'));
    const payload = verifyManifest(update, keys);
    if (payload.version !== version || payload.artifact.url !== downloadUrl) throw new Error('RELEASE_ARTIFACT_MISMATCH');
  } catch { throw new HttpError(400, 'INVALID_SIGNED_UPDATE', '更新清单的签名、有效期、版本或下载链接无效，请核对正式发布产物。'); }
}
