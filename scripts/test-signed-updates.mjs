import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { releasePolicy, signedManifest } from './release-policy.mjs';
const require = createRequire(import.meta.url);
const { canonical, compareVersions, verifyManifest } = require('../desktop/update-manifest.cjs');
const { prepareUpdate, verifyFileDigest, verifyInstaller, verifierEnvironment } = require('../desktop/updates.cjs');
const pair = generateKeyPairSync('ed25519'), pem = pair.publicKey.export({ type: 'spki', format: 'pem' });
const keys = { fixture: pem }, bytes = Buffer.from('isolated fixture, never an executable');
const policy = { development: false, keys, keyId: 'fixture', privateKey: pair.privateKey, base: 'https://download.example.invalid/', certificate: 'a'.repeat(64) };
const envelope = () => signedManifest(policy, { version: '0.1.4', artifactName: 'app.exe', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const resign = payload => ({ payload, signature: sign(null, Buffer.from(canonical(payload)), pair.privateKey).toString('base64url') });

test('formal releases fail closed before downloads when signing identity or pinned keys are unavailable', async () => {
  await assert.rejects(releasePolicy([], {}), /Formal release requires/);
  assert.equal((await releasePolicy(['--unsigned-development'], {})).development, true);
  await assert.rejects(releasePolicy(['--unsigned-development', '--copy-desktop'], {}), /cannot use/);
  assert.throws(() => signedManifest({ development: true }, {}), /cannot issue/);
});
test('update verification binds nested artifact, expiry, key, version and platform', () => {
  assert.equal(verifyManifest(envelope(), keys).version, '0.1.4');
  assert.throws(() => verifyManifest(envelope(), {}), /UNTRUSTED/);
  const changed = envelope(); changed.payload.artifact.url = 'https://download.example.invalid/other.exe'; assert.throws(() => verifyManifest(changed, keys), /SIGNATURE/);
  for (const patch of [{ platform: 'linux-x64' }, { version: '01.1.4' }, { expiresAt: '2000-01-01T00:00:00Z' }]) assert.throws(() => verifyManifest(resign({ ...envelope().payload, ...patch }), keys));
  for (const url of ['http://download.example.invalid/app.exe', 'file:///C:/app.exe', 'https://user:pass@example.invalid/app.exe']) {
    const p = envelope().payload; p.artifact.url = url; assert.throws(() => verifyManifest(resign(p), keys), /ARTIFACT/);
  }
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1); assert.equal(compareVersions('0.1.2', '0.1.4'), -1);
});
test('staging enforces bounded exact bytes and digest before publisher verification; rollback is explicit', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccagent-updates-fixture-'));
  let publisherChecks = 0;
  const settings = { directory, trustedKeys: keys, currentVersion: '0.1.3', verify: async () => { publisherChecks++; }, fetcher: async (_url, init) => { assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); return new Response(bytes); } };
  try {
    const prepared = await prepareUpdate(envelope(), settings); assert.equal(prepared.rollback, false); assert.equal(publisherChecks, 1);
    assert.equal((await fs.readFile(prepared.file)).toString(), bytes.toString());
    await fs.writeFile(prepared.file, Buffer.alloc(bytes.length, 1)); await assert.rejects(verifyFileDigest(prepared.file, prepared.payload.artifact), /HASH_MISMATCH/);
    await assert.rejects(prepareUpdate(envelope(), { ...settings, fetcher: async () => new Response(Buffer.alloc(bytes.length, 1)) }), /HASH_MISMATCH/);
    await assert.rejects(prepareUpdate(envelope(), { ...settings, fetcher: async () => new Response(Buffer.alloc(bytes.length + 1)) }), /SIZE_MISMATCH/);
    assert.equal(publisherChecks, 1, 'Corrupted downloads never reach publisher check');
    const rollback = await prepareUpdate(envelope(), { ...settings, currentVersion: '0.1.5' }); assert.equal(rollback.rollback, true);
    await assert.rejects(prepareUpdate(envelope(), { ...settings, currentVersion: '0.1.4' }), /ALREADY_INSTALLED/);
    await assert.rejects(prepareUpdate(envelope(), { ...settings, verify: async () => { throw new Error('UPDATE_PUBLISHER_INVALID'); } }), /PUBLISHER/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('Windows verifier checks a real OS signature and rejects a different publisher without executing the file', { skip: process.platform !== 'win32' }, async () => {
  const windows = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$file=Join-Path $PSHOME 'powershell.exe'; $s=Get-AuthenticodeSignature -LiteralPath $file; if($s.Status -ne 'Valid'){throw 'System PowerShell signature is not valid'}; @{file=$file;certificate=$s.SignerCertificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()} | ConvertTo-Json -Compress"], { windowsHide: true, encoding: 'utf8', env: verifierEnvironment() }));
  const actual = await fs.readFile(windows.file), artifact = { size: actual.length, sha256: createHash('sha256').update(actual).digest('hex'), signerCertificateSha256: windows.certificate };
  await verifyInstaller(windows.file, artifact);
  await assert.rejects(verifyInstaller(windows.file, { ...artifact, signerCertificateSha256: '0'.repeat(64) }));
});
