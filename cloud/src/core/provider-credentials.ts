import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { database, type DatabaseReader } from './db';
import { audit, settings } from './db/schema';
import { authEnvironment } from './env';
import { HttpError } from './http';
import { validateTrustedUpstreamHost } from './upstream-hosts';

export type CredentialRoute = { id: string; provider: string; baseUrl: string; credentialEnv: string };
export type CredentialWriter = Pick<ReturnType<typeof database>['db'], 'select' | 'insert' | 'update'>;
type CredentialStatus = { configured: boolean; source: 'managed' | 'environment' | 'none' };
const prefix = 'gateway.credential.';
const maximumBytes = 8192;
const invalid = () => new HttpError(503, 'PROVIDER_CREDENTIAL_INVALID', '供应商凭据无法使用，请重新保存该路由的 API Key。');
const unavailable = () => new HttpError(503, 'PROVIDER_CREDENTIAL_STORAGE_UNAVAILABLE', '供应商凭据暂时不可读取，请稍后重试。');
const encoded = z.string().min(1).max(12000).regex(/^[A-Za-z0-9_-]+$/);
const encrypted = z.object({ version: z.literal(1), kind: z.literal('encrypted'), algorithm: z.literal('aes-256-gcm'),
  iv: encoded, ciphertext: encoded, tag: encoded }).strict();
const disabled = z.object({ version: z.literal(1), kind: z.literal('disabled') }).strict();
const envelope = z.discriminatedUnion('kind', [encrypted, disabled]);

function binding(route: CredentialRoute): { key: string; aad: Buffer } {
  try {
    if (!/^[a-z0-9][a-z0-9._:-]{0,79}$/.test(route.id) || !/^[a-z0-9][a-z0-9_-]{0,49}$/.test(route.provider)
      || typeof route.baseUrl !== 'string' || route.baseUrl.length > 500 || /[\p{Cc}\p{Cf}]/u.test(route.baseUrl)) throw new Error();
    const url = new URL(route.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) throw new Error();
    // URL canonicalizes host case, default ports and dot segments. A single trailing slash is equivalent for API base URLs.
    const baseUrl = url.href.replace(/\/$/, '');
    return { key: prefix + route.id, aad: Buffer.from(JSON.stringify(['ccagent-provider-credential:v1', route.id, route.provider, baseUrl])) };
  } catch { throw new HttpError(400, 'INVALID_CREDENTIAL_ROUTE', '供应商凭据对应的路由配置无效。'); }
}
function checkedSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length > maximumBytes || Buffer.byteLength(value, 'utf8') > maximumBytes || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new HttpError(400, 'INVALID_PROVIDER_CREDENTIAL', 'API Key 格式无效；不能包含控制字符，且不能超过 8192 字节。');
  }
  const secret = value.trim();
  if (secret && !/^[\x21-\x7e]+$/.test(secret)) throw new HttpError(400, 'INVALID_PROVIDER_CREDENTIAL', 'API Key 只能包含可见 ASCII 字符，且不能包含内部空白。');
  return secret;
}
function encryptionKey(): Buffer {
  try {
    return Buffer.from(hkdfSync('sha256', Buffer.from(authEnvironment().secret, 'utf8'),
      Buffer.from('ccagent/provider-credentials/hkdf/v1'), Buffer.from('aes-256-gcm/route-bound/v1'), 32));
  } catch { throw new HttpError(503, 'PROVIDER_CREDENTIAL_ENCRYPTION_NOT_READY', '供应商凭据加密服务尚未就绪，请联系管理员。'); }
}
function decode(value: string, size?: number): Buffer {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value || (size !== undefined && bytes.length !== size)) throw invalid();
  return bytes;
}
function decrypt(value: unknown, aad: Buffer): string {
  const parsed = envelope.safeParse(value);
  if (!parsed.success) throw invalid();
  if (parsed.data.kind === 'disabled') throw new HttpError(503, 'PROVIDER_CREDENTIAL_DISABLED', '该路由的供应商凭据已移除，请重新填写 API Key。');
  const key = encryptionKey();
  let plain: Buffer | undefined;
  try {
    const iv = decode(parsed.data.iv, 12), tag = decode(parsed.data.tag, 16), ciphertext = decode(parsed.data.ciphertext);
    if (ciphertext.length > maximumBytes) throw invalid();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad); decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const secret = checkedSecret(plain.toString('utf8'));
    if (!secret) throw invalid();
    return secret;
  } catch { throw invalid(); }
  finally { key.fill(0); plain?.fill(0); }
}
async function storedCredential(key: string, reader: DatabaseReader) {
  try { const [row] = await reader.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1); return row; }
  catch { throw unavailable(); }
}
function legacyCredential(route: CredentialRoute): string | undefined {
  // An administrator-approved custom host must never receive another provider's legacy server Key.
  // Only the original built-in/server-environment trust boundary may use that compatibility path.
  try { validateTrustedUpstreamHost(route.baseUrl); } catch { return; }
  if (!/^CCAGENT_PROVIDER_[A-Z0-9_]{1,64}$/.test(route.credentialEnv)) return;
  const value = process.env[route.credentialEnv];
  if (value === undefined) return;
  try { return checkedSecret(value) || undefined; }
  catch { throw invalid(); }
}

/** API-safe projection only. A broken managed record never falls back to a legacy environment Key. */
export async function routeCredentialStatus(route: CredentialRoute, reader: DatabaseReader = database().db): Promise<CredentialStatus> {
  const { key, aad } = binding(route), stored = await storedCredential(key, reader);
  if (stored) {
    try { decrypt(stored.value, aad); return { configured: true, source: 'managed' }; }
    catch (error) { if (error instanceof HttpError) return { configured: false, source: 'managed' }; throw error; }
  }
  try { return legacyCredential(route) ? { configured: true, source: 'environment' } : { configured: false, source: 'none' }; }
  catch (error) { if (error instanceof HttpError) return { configured: false, source: 'environment' }; throw error; }
}

/** Server-only. Do not include its result in API responses, errors, audit data or logs. */
export async function resolveRouteCredential(route: CredentialRoute, reader: DatabaseReader = database().db): Promise<string> {
  const { key, aad } = binding(route), stored = await storedCredential(key, reader);
  if (stored) return decrypt(stored.value, aad);
  const value = legacyCredential(route);
  if (!value) throw new HttpError(503, 'UPSTREAM_NOT_CONFIGURED', '服务供应商尚未配置，请保存该路由的 API Key。');
  return value;
}

/** Caller owns the catalog transaction and its administration lock. Blank input preserves the exact existing record. */
export async function saveRouteCredential(actorId: string, route: CredentialRoute, action: { apiKey?: string; remove?: boolean }, writer: CredentialWriter): Promise<void> {
  const { key, aad } = binding(route);
  if (action.remove !== undefined && typeof action.remove !== 'boolean') throw new HttpError(400, 'INVALID_PROVIDER_CREDENTIAL', '请选择是否移除供应商凭据。');
  const secret = action.apiKey === undefined ? '' : checkedSecret(action.apiKey);
  if (action.remove && secret) throw new HttpError(400, 'INVALID_PROVIDER_CREDENTIAL', '不能同时保存和移除供应商凭据。');
  if (!action.remove && !secret) return;
  let value: z.infer<typeof envelope> = { version: 1, kind: 'disabled' };
  if (secret) {
    const encryption = encryptionKey(), iv = randomBytes(12);
    try {
      const cipher = createCipheriv('aes-256-gcm', encryption, iv); cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      value = { version: 1, kind: 'encrypted', algorithm: 'aes-256-gcm', iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
    } catch { throw new HttpError(503, 'PROVIDER_CREDENTIAL_ENCRYPTION_NOT_READY', '供应商凭据暂时无法保存，请稍后重试。'); }
    finally { encryption.fill(0); }
  }
  try {
    const [existing] = await writer.select({ version: settings.version }).from(settings).where(eq(settings.key, key)).for('update');
    const version = (existing?.version ?? 0) + 1;
    if (existing) await writer.update(settings).set({ value, version, updatedBy: actorId, updatedAt: new Date() }).where(eq(settings.key, key));
    else await writer.insert(settings).values({ key, value, version, updatedBy: actorId });
    await writer.insert(audit).values({ id: randomUUID(), actorId, action: action.remove ? 'routes.credential.remove' : 'routes.credential.save', objectId: route.id,
      result: 'success', metadata: { source: 'managed', operation: action.remove ? 'remove' : existing ? 'replace' : 'create', version } });
  } catch { throw new HttpError(503, 'PROVIDER_CREDENTIAL_STORAGE_UNAVAILABLE', '供应商凭据暂时无法保存，请稍后重试。'); }
}
