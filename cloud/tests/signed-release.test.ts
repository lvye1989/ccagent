import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonical } from '../../desktop/update-manifest.cjs';
import { validateSignedRelease } from '../src/core/signed-release';

test('signed release publication requires a pinned signature and identical visible version/download target', () => {
  const pair = generateKeyPairSync('ed25519'), before = process.env.CCAGENT_RELEASE_PUBLIC_KEYS;
  process.env.CCAGENT_RELEASE_PUBLIC_KEYS = JSON.stringify({ fixture: pair.publicKey.export({ type: 'spki', format: 'pem' }) });
  const payload = { schemaVersion: 1 as const, keyId: 'fixture', version: '0.1.4', platform: 'win32-x64' as const, channel: 'stable' as const,
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    artifact: { url: 'https://download.example.invalid/app.exe', size: 42, sha256: 'a'.repeat(64), signerCertificateSha256: 'b'.repeat(64) } };
  const update = { payload, signature: sign(null, Buffer.from(canonical(payload)), pair.privateKey).toString('base64url') };
  try {
    validateSignedRelease(update, payload.version, payload.artifact.url);
    assert.throws(() => validateSignedRelease(update, '0.1.5', payload.artifact.url), { code: 'INVALID_SIGNED_UPDATE' });
    assert.throws(() => validateSignedRelease(update, payload.version, 'https://download.example.invalid/other.exe'), { code: 'INVALID_SIGNED_UPDATE' });
    process.env.CCAGENT_RELEASE_PUBLIC_KEYS = '{}'; assert.throws(() => validateSignedRelease(update, payload.version, payload.artifact.url), { code: 'INVALID_SIGNED_UPDATE' });
  } finally { if (before === undefined) delete process.env.CCAGENT_RELEASE_PUBLIC_KEYS; else process.env.CCAGENT_RELEASE_PUBLIC_KEYS = before; }
});
