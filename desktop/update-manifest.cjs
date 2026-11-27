const { createPublicKey, verify } = require('node:crypto');

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function versionParts(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/.test(value)) throw new Error('UPDATE_INVALID_VERSION');
  return value.split('.').map(Number);
}
function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.slice().sort().join(',')) throw new Error('UPDATE_INVALID_MANIFEST');
}
/** Trust only keys bundled by the release build. The manifest cannot supply its own key. */
function verifyManifest(envelope, trustedKeys, now = Date.now()) {
  exactKeys(envelope, ['payload', 'signature']);
  const p = envelope.payload;
  exactKeys(p, ['schemaVersion', 'keyId', 'version', 'platform', 'channel', 'issuedAt', 'expiresAt', 'artifact']);
  exactKeys(p.artifact, ['url', 'size', 'sha256', 'signerCertificateSha256']);
  versionParts(p.version);
  if (p.schemaVersion !== 1 || p.platform !== 'win32-x64' || p.channel !== 'stable' || typeof p.keyId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(p.keyId)) throw new Error('UPDATE_INVALID_MANIFEST');
  const issued = Date.parse(p.issuedAt), expires = Date.parse(p.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now + 300000 || expires <= now || expires <= issued || expires - issued > 366 * 86400000) throw new Error('UPDATE_MANIFEST_EXPIRED');
  const url = new URL(p.artifact.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.pathname.toLowerCase().endsWith('.exe') || !Number.isSafeInteger(p.artifact.size) || p.artifact.size < 1 || p.artifact.size > 2 * 1024 ** 3 || !/^[a-f0-9]{64}$/.test(p.artifact.sha256) || !/^[a-f0-9]{64}$/.test(p.artifact.signerCertificateSha256)) throw new Error('UPDATE_INVALID_ARTIFACT');
  const pem = Object.hasOwn(trustedKeys, p.keyId) && trustedKeys[p.keyId];
  if (typeof pem !== 'string') throw new Error('UPDATE_UNTRUSTED_KEY');
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519' || typeof envelope.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature) || !verify(null, Buffer.from(canonical(p)), key, Buffer.from(envelope.signature, 'base64url'))) throw new Error('UPDATE_SIGNATURE_INVALID');
  return p;
}
module.exports = { canonical, compareVersions, verifyManifest };
