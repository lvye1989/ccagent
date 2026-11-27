const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { verifyManifest, compareVersions } = require('./update-manifest.cjs');
const run = promisify(execFile);
const powerShell = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function verifierEnvironment() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (['PSMODULEPATH', 'PSExecutionPolicyPreference'.toUpperCase()].includes(name.toUpperCase())) delete env[name];
  env.PSModulePath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  return env;
}
const installerHelper = () => path.join(__dirname.replace(/\.asar(?=[\\/])/, '.asar.unpacked'), 'verified-installer.ps1');

async function verifyFileDigest(file, artifact) {
  const hash = createHash('sha256');
  const handle = await fs.open(file, 'r');
  try {
    if ((await handle.stat()).size !== artifact.size) throw new Error('UPDATE_SIZE_MISMATCH');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally { await handle.close(); }
  if (hash.digest('hex') !== artifact.sha256) throw new Error('UPDATE_HASH_MISMATCH');
}
async function verifyInstaller(file, artifact, execute = false, parentPid = 0) {
  await verifyFileDigest(file, artifact);
  if (process.platform !== 'win32') throw new Error('UPDATE_WINDOWS_REQUIRED');
  await run(powerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installerHelper(),
    '-Installer', file, '-Sha256', artifact.sha256, '-CertificateSha256', artifact.signerCertificateSha256,
    ...(execute ? ['-Launch', '-ParentPid', String(parentPid)] : [])], { windowsHide: true, timeout: 30000, maxBuffer: 65536, env: verifierEnvironment() });
}
async function prepareUpdate(envelope, { directory, trustedKeys, currentVersion, fetcher = fetch, verify = verifyInstaller }) {
  const payload = verifyManifest(envelope, trustedKeys);
  const direction = compareVersions(payload.version, currentVersion);
  if (!direction) throw new Error('UPDATE_ALREADY_INSTALLED');
  await fs.mkdir(directory, { recursive: true });
  const folder = await fs.mkdtemp(path.join(directory, 'verified-'));
  const file = path.join(folder, 'CCAGENT-Setup.exe');
  try {
    const response = await fetcher(payload.artifact.url, { redirect: 'error', signal: AbortSignal.timeout(600000), credentials: 'omit', cache: 'no-store' });
    if (!response.ok || !response.body) throw new Error('UPDATE_DOWNLOAD_FAILED');
    const handle = await fs.open(file, 'wx');
    let received = 0;
    try {
      for await (const chunk of response.body) {
        received += chunk.byteLength;
        if (received > payload.artifact.size) throw new Error('UPDATE_SIZE_MISMATCH');
        let offset = 0;
        while (offset < chunk.byteLength) { const written = await handle.write(chunk, offset, chunk.byteLength - offset); if (!written.bytesWritten) throw new Error('UPDATE_WRITE_FAILED'); offset += written.bytesWritten; }
      }
    } catch (error) { await response.body.cancel().catch(() => {}); throw error; }
    finally { await handle.close(); }
    if (received !== payload.artifact.size) throw new Error('UPDATE_SIZE_MISMATCH');
    await verifyFileDigest(file, payload.artifact);
    await verify(file, payload.artifact);
    await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(envelope, null, 2), { flag: 'wx' });
    return { file, payload, rollback: direction < 0 };
  } catch (error) {
    // folder was created by this invocation beneath directory; never remove caller paths.
    await fs.rm(folder, { recursive: true, force: true });
    throw error;
  }
}
async function launchUpdate(prepared) {
  // Re-check both digest and Windows publisher immediately before handing off.
  await verifyInstaller(prepared.file, prepared.payload.artifact, true, process.pid);
}
module.exports = { prepareUpdate, verifyFileDigest, verifyInstaller, launchUpdate, verifierEnvironment };
