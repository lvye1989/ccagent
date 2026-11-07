import './load-env';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, lstat, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { databaseSchema, databaseUrl } from '../src/core/env';
import { dumpSchema, listArchive, validateArchive, remotePgEnvironment } from './lib/postgres-tools';

// Local pre-migration backup only. Offsite production recovery requires a
// separately managed portable encryption key and independent retention.
function protect(input: Buffer, decrypt = false): Promise<Buffer> {
  const script = `Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $value=[Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($value))`;
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30000, maxBuffer: 24 * 1024 * 1024 }, (error, stdout) => {
      if (error || !/^[A-Za-z0-9+/]+={0,2}$/.test(stdout.trim())) reject(new Error('LOCAL_BACKUP_PROTECTION_FAILED'));
      else resolve(Buffer.from(stdout.trim(), 'base64'));
    });
    child.stdin?.on('error', () => {}); child.stdin?.end(input.toString('base64'));
  });
}

let archive: Buffer | undefined, restored: Buffer | undefined, scratch = '';
try {
  if (process.platform !== 'win32') throw new Error('WINDOWS_BACKUP_REQUIRED');
  const schema = databaseSchema(); if (schema !== 'ccagent') throw new Error('APPLICATION_SCHEMA_REQUIRED');
  const args = process.argv.slice(2), verifyOnly = args[0] === '--verify' && args.length === 2;
  if (args.length && !verifyOnly) throw new Error('LOCAL_BACKUP_ARGUMENTS_INVALID');
  const root = process.env.LOCALAPPDATA;
  if (!root || !path.isAbsolute(root)) throw new Error('LOCAL_BACKUP_DIRECTORY_REQUIRED');
  const directory = path.join(root, 'CCAGENT', 'database-backups');
  // Refuse linked path components instead of writing a backup to another target.
  for (const candidate of [root, path.dirname(directory), directory]) {
    const info = await lstat(candidate).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('LOCAL_BACKUP_DIRECTORY_UNSAFE');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const canonical = await realpath(directory), parent = await realpath(root);
  if (path.relative(parent, canonical).startsWith('..') || path.isAbsolute(path.relative(parent, canonical))) throw new Error('LOCAL_BACKUP_DIRECTORY_UNSAFE');
  const file = verifyOnly ? path.resolve(args[1]!) : path.join(canonical, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID() + '.dpapi.json');
  if (verifyOnly) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 24 * 1024 * 1024 || path.dirname(await realpath(file)) !== canonical) throw new Error('LOCAL_BACKUP_FILE_UNSAFE');
  } else {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ccagent-backup-public-ca-')));
    // This scratch directory contains a public CA bundle only, never archive rows.
    const connection = await remotePgEnvironment(databaseUrl(true), path.join(scratch, 'trusted-roots.pem'));
    archive = await dumpSchema(schema, connection);
    assert.equal(archive.subarray(0, 5).toString('ascii'), 'PGDMP');
    const sha256 = createHash('sha256').update(archive).digest('hex'), payload = await protect(archive);
    await writeFile(file, JSON.stringify({ version: 1, protection: 'windows-dpapi-current-user', schema, createdAt: new Date().toISOString(), archiveSha256: sha256, archiveBytes: archive.length, payload: payload.toString('base64') }), { flag: 'wx', mode: 0o600 });
  }
  const saved = JSON.parse(await readFile(file, 'utf8'));
  if (saved.version !== 1 || saved.protection !== 'windows-dpapi-current-user' || saved.schema !== schema || typeof saved.payload !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(saved.payload) || !/^[a-f0-9]{64}$/.test(saved.archiveSha256)) throw new Error('LOCAL_BACKUP_FORMAT_INVALID');
  restored = await protect(Buffer.from(saved.payload, 'base64'), true);
  const sha256 = createHash('sha256').update(restored).digest('hex');
  assert.equal(sha256, saved.archiveSha256); assert.equal(restored.length, saved.archiveBytes);
  assert.match(await listArchive(restored), /TABLE ccagent wallets/);
  await validateArchive(restored);
  console.log(JSON.stringify({ ok: true, schema, file, archiveBytes: restored.length, sha256, encrypted: true, verifyOnly,
    verifiedByDecryptionAndArchiveInventory: true, allArchiveBlocksRead: true,
    fullDataRestore: false, portableToAnotherWindowsProfile: false, sourceMutated: false }));
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  console.error(JSON.stringify({ ok: false, code: /^[A-Z0-9_]{1,80}$/.test(message) ? message : 'LOCAL_BACKUP_FAILED' })); process.exitCode = 1;
} finally {
  archive?.fill(0); restored?.fill(0);
  if (scratch) {
    const parent = await realpath(os.tmpdir());
    if (path.dirname(scratch) !== parent || !path.basename(scratch).startsWith('ccagent-backup-public-ca-')) throw new Error('REFUSE_UNSCOPED_CA_CLEANUP');
    await rm(scratch, { recursive: true, force: true });
  }
}
