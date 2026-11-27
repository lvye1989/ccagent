import fs from 'node:fs/promises';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createRequire } from 'node:module';
const { canonical, verifyManifest } = createRequire(import.meta.url)('../desktop/update-manifest.cjs');

export async function releasePolicy(args, env) {
  const development = args.includes('--prepare-only') || args.includes('--dir') || args.includes('--unsigned-development');
  if (args.includes('--unsigned-development') && args.includes('--copy-desktop')) throw new Error('Unsigned development builds cannot use the formal desktop delivery command');
  if (development) return { development: true, keys: {} };
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CCAGENT_RELEASE_PUBLIC_KEYS_FILE', 'CCAGENT_RELEASE_KEY_ID', 'CCAGENT_RELEASE_PRIVATE_KEY_FILE', 'CCAGENT_RELEASE_DOWNLOAD_BASE', 'CCAGENT_RELEASE_CERTIFICATE_SHA256']) {
    if (!env[name]) throw new Error(`Formal release requires ${name}; use --unsigned-development only for an isolated nonrelease installer`);
  }
  if (!/^[a-f0-9]{64}$/.test(env.CCAGENT_RELEASE_CERTIFICATE_SHA256)) throw new Error('Invalid release certificate fingerprint');
  const base = new URL(env.CCAGENT_RELEASE_DOWNLOAD_BASE);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) throw new Error('Release download base must be an HTTPS directory');
  const keys = JSON.parse(await fs.readFile(env.CCAGENT_RELEASE_PUBLIC_KEYS_FILE, 'utf8'));
  if (!keys || typeof keys !== 'object' || Array.isArray(keys) || !Object.hasOwn(keys, env.CCAGENT_RELEASE_KEY_ID)) throw new Error('Release key must be pinned in the public keyring');
  for (const value of Object.values(keys)) if (typeof value !== 'string' || createPublicKey(value).asymmetricKeyType !== 'ed25519') throw new Error('Release keyring accepts only Ed25519 public keys');
  const privateKey = createPrivateKey(await fs.readFile(env.CCAGENT_RELEASE_PRIVATE_KEY_FILE, 'utf8'));
  if (privateKey.asymmetricKeyType !== 'ed25519' || !createPublicKey(privateKey).equals(createPublicKey(keys[env.CCAGENT_RELEASE_KEY_ID]))) throw new Error('Release private key does not match pinned key');
  return { development: false, keys, keyId: env.CCAGENT_RELEASE_KEY_ID, privateKey, base: base.href, certificate: env.CCAGENT_RELEASE_CERTIFICATE_SHA256 };
}
export function signedManifest(policy, { version, artifactName, size, sha256 }, now = Date.now()) {
  if (policy.development) throw new Error('Development builds cannot issue a signed update');
  const payload = { schemaVersion: 1, keyId: policy.keyId, version, platform: 'win32-x64', channel: 'stable',
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 86400000).toISOString(),
    artifact: { url: new URL(artifactName, policy.base).href, size, sha256, signerCertificateSha256: policy.certificate } };
  const envelope = { payload, signature: sign(null, Buffer.from(canonical(payload)), policy.privateKey).toString('base64url') };
  verifyManifest(envelope, policy.keys, now);
  return envelope;
}
