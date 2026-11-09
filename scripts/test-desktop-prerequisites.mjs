/** Pure injected Windows fixtures: no real probes, installs, downloads or environment writes. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createPrerequisiteManager } = require('../desktop/prerequisites.cjs');
const win = path.win32, root = 'C:\\CCAGENT fixture\\backend', runtime = win.join(root, 'runtime');
const normalize = value => win.normalize(value).toLowerCase();
const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\FixtureUser\\AppData\\Local',
  USERPROFILE: 'C:\\FixtureUser', PATH: 'C:\\Windows\\System32;C:\\Tools;C:\\FixtureUser\\AppData\\Local\\Microsoft\\WindowsApps',
  NODE_OPTIONS: '--require unsafe-fixture', NODE_PATH: 'unsafe-fixture', ELECTRON_RUN_AS_NODE: '1', NODE_TLS_REJECT_UNAUTHORIZED: '0',
  PRIVATE_API_KEY: 'PRIVATE_FIXTURE_DO_NOT_FORWARD', BASH_ENV: 'unsafe-fixture' };
const power = win.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const node = win.join(runtime, 'node.exe'), winget = win.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'winget.exe');
const python = win.join(env.LOCALAPPDATA, 'Programs', 'Python', 'Python314', 'python.exe');
const bash = win.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe');
function fixture(changes = {}) {
  const state = { files: new Set([node, power, winget].map(normalize)), calls: [], opened: [], npm: true, npx: true,
    pythonVersion: '3.14.1', nodeVersion: '24.22.2', manifestVersion: '24.22.2', sourceTrusted: true, installs: [], ...changes };
  const fileSystem = {
    async stat(file) { if (!state.files.has(normalize(file))) throw new Error('ENOENT'); return { isFile: () => true }; },
    async readFile(file) { assert.equal(normalize(file), normalize(win.join(root, 'desktop-manifest.json'))); return JSON.stringify({ nodeVersion: state.manifestVersion }); },
    async readdir(file) { assert.equal(normalize(file), normalize(win.join(env.LOCALAPPDATA, 'Programs', 'Python'))); return state.files.has(normalize(python)) ? ['Python314'] : []; },
  };
  async function run(file, args, settings) {
    assert.equal(settings.shell, false); assert.equal(settings.windowsHide, true); assert.ok(win.isAbsolute(file));
    for (const name of ['PRIVATE_API_KEY', 'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'BASH_ENV']) assert.equal(settings.env[name], undefined);
    assert.equal(settings.env.NODE_TLS_REJECT_UNAUTHORIZED, '1'); assert.ok(settings.env.PATH.startsWith(runtime + ';'));
    state.calls.push({ file, args: [...args] });
    if (state.overrideRun) { const custom = await state.overrideRun(file, args, settings); if (custom) return custom; }
    if (normalize(file) === normalize(power)) return { ok: true, stdout: '5.1.22621.1', stderr: '' };
    if (normalize(file) === normalize(node)) {
      if (args[0] === '-p') return { ok: true, stdout: JSON.stringify({ version: state.nodeVersion, arch: 'x64', platform: 'win32' }), stderr: '' };
      if (args[0].endsWith('npm-cli.js')) return { ok: state.npm, stdout: state.npm ? '11.9.0' : '', stderr: '' };
      if (args[0].endsWith('npx-cli.js')) return { ok: state.npx, stdout: state.npx ? '11.9.0' : '', stderr: '' };
      assert.fail('Unexpected bundled Node command');
    }
    if (normalize(file) === normalize(winget)) {
      if (args[0] === '--version') return { ok: true, stdout: 'v1.12.350', stderr: '' };
      if (args[0] === 'source') return { ok: true, stdout: JSON.stringify({ Name: 'winget', Arg: state.sourceTrusted ? 'https://cdn.winget.microsoft.com/cache' : 'https://untrusted.invalid/cache',
        Identifier: 'Microsoft.Winget.Source_8wekyb3d8bbwe', Type: 'Microsoft.PreIndexed.Package' }), stderr: '' };
      assert.equal(args[0], 'install'); state.installs.push([...args]);
      if (state.install) return state.install(file, args, settings);
      if (args[2] === 'Python.Python.3.14') state.files.add(normalize(python));
      else if (args[2] === 'Git.Git') state.files.add(normalize(bash));
      else assert.fail('Unknown package');
      return { ok: true, stdout: 'untrusted installer output PRIVATE_FIXTURE_DO_NOT_FORWARD', stderr: '' };
    }
    if (normalize(file) === normalize(python) || /(?:^|\\)python\.exe$/i.test(file)) return { ok: true, stdout: 'Python ' + state.pythonVersion, stderr: '' };
    if (normalize(file) === normalize(bash)) return { ok: true, stdout: 'GNU bash, version 5.2.37(1)-release (x86_64-pc-msys)', stderr: '' };
    assert.fail('Unexpected fixture executable: ' + file);
  }
  const manager = createPrerequisiteManager({ backendRoot: root, platform: 'win32', arch: 'x64', release: '10.0.22631', env: { ...env, ...changes.env },
    fileSystem, run, openExternal: async url => state.opened.push(url), probeTimeoutMs: 100, installTimeoutMs: 200, stopGraceMs: 60, ...changes.options });
  return { manager, state };
}
const item = (report, id) => report.components.find(value => value.id === id);
async function until(check) { for (let count = 0; count < 200; count++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 1)); } assert.fail('Fixture condition was not reached'); }

test('bundled Node/npm/npx are mandatory, while missing optional software does not block entry', async () => {
  const { manager, state } = fixture();
  try {
    const report = await manager.detect(); assert.equal(report.requiredReady, true); assert.equal(report.canContinue, true);
    for (const id of ['windows', 'architecture', 'powershell', 'bundled-node', 'bundled-npm']) assert.equal(item(report, id).status, 'ready');
    for (const id of ['git-bash', 'python', 'libreoffice']) { assert.equal(item(report, id).optional, true); assert.equal(item(report, id).status, 'missing'); }
    assert.equal(item(report, 'bundled-node').canInstall, false); assert.equal(item(report, 'bundled-npm').canInstall, false);
    assert.equal(state.installs.length, 0); assert.equal(state.opened.length, 0); assert.ok(!JSON.stringify(report).includes('PRIVATE_FIXTURE'));
    assert.equal(state.calls.filter(call => /node\.exe$/i.test(call.file)).every(call => normalize(call.file) === normalize(node)), true);
  } finally { await manager.dispose(); }
});
test('global Node, Git.exe and WSL/Store aliases never masquerade as bundled runtime or GNU Bash/Python', async () => {
  const { manager, state } = fixture();
  state.files.delete(normalize(node));
  for (const file of ['C:\\Tools\\node.exe', 'C:\\Tools\\git.exe', 'C:\\Windows\\System32\\bash.exe', win.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'python.exe')]) state.files.add(normalize(file));
  try {
    const report = await manager.detect(); assert.equal(report.requiredReady, false); assert.equal(item(report, 'bundled-node').status, 'failed');
    assert.equal(item(report, 'git-bash').status, 'missing'); assert.equal(item(report, 'python').status, 'missing');
    assert.ok(!state.calls.some(call => /(?:\\git\.exe|\\System32\\bash\.exe|\\WindowsApps\\python\.exe|\\Tools\\node\.exe)$/i.test(call.file)));
  } finally { await manager.dispose(); }
});
test('damaged npm/npx or a manifest/runtime version mismatch requires client repair', async () => {
  for (const changes of [{ npm: false }, { npx: false }, { manifestVersion: '24.99.0' }, { nodeVersion: '20.0.0' }]) {
    const { manager } = fixture(changes);
    try { const report = await manager.detect(); assert.equal(report.requiredReady, false); assert.match(item(report, 'bundled-npm').message, /修复|重新安装/); }
    finally { await manager.dispose(); }
  }
});
test('Windows startup minimum differs from optional WinGet minimum; ARM64 is not claimed as native support', async () => {
  const old = fixture({ options: { release: '10.0.14393' } });
  try { const report = await old.manager.detect(); assert.equal(report.requiredReady, true); assert.equal(report.installer.available, false); assert.equal(old.state.installs.length, 0); }
  finally { await old.manager.dispose(); }
  for (const options of [{ release: '6.3.9600' }, { arch: 'arm64' }, { platform: 'linux' }]) {
    const { manager, state } = fixture({ options });
    try { const report = await manager.detect(); assert.equal(report.requiredReady, false); assert.ok(report.components.every(value => !value.canInstall)); if (options.platform) assert.equal(state.calls.length, 0); }
    finally { await manager.dispose(); }
  }
});
test('Python requires 3.10+ and explicit invalid overrides are not hidden by another installed copy', async () => {
  for (const pythonVersion of ['3.9.21', '2.7.18']) {
    const { manager, state } = fixture({ pythonVersion }); state.files.add(normalize(python));
    try { const report = await manager.detect(); assert.equal(item(report, 'python').status, 'missing'); assert.equal(report.canContinue, true); }
    finally { await manager.dispose(); }
  }
  const { manager, state } = fixture({ env: { CCAGENT_PYTHON: 'C:\\Absent\\python.exe', CCAGENT_BASH: 'C:\\Absent\\bash.exe' } });
  state.files.add(normalize(python)); state.files.add(normalize(bash));
  try { const report = await manager.detect(); for (const id of ['python', 'git-bash']) { assert.equal(item(report, id).status, 'missing'); assert.equal(item(report, id).canInstall, false); } }
  finally { await manager.dispose(); }
});
test('only an explicitly selected allowlisted component can install, and actual re-probe confirms success', async () => {
  const { manager, state } = fixture();
  try {
    await manager.detect(); const started = manager.startInstall('python'); assert.equal(started.job.running, true); assert.equal(started.canContinue, false);
    assert.throws(() => manager.startInstall('git-bash'), { code: 'INSTALL_ALREADY_RUNNING' });
    const result = await manager.waitForIdle(); assert.equal(result.job.running, false); assert.equal(item(result, 'python').status, 'ready'); assert.equal(result.canContinue, true);
    assert.deepEqual(state.installs, [['install', '--id', 'Python.Python.3.14', '--exact', '--source', 'winget', '--scope', 'user', '--interactive', '--disable-interactivity', '--skip-dependencies', '--no-upgrade']]);
    assert.ok(state.installs.every(args => !args.some(arg => /accept-|silent|override|custom|force|allow-reboot|machine/i.test(arg))));
    const previous = state.installs.length; manager.startInstall('python'); await manager.waitForIdle(); assert.equal(state.installs.length, previous, 'Already installed components are not reinstalled');
    assert.throws(() => manager.startInstall('bundled-node'), { code: 'MANUAL_INSTALL_ONLY' });
    for (const value of ['__proto__', 'python && arbitrary-command', { id: 'python' }, 'https://untrusted.invalid']) assert.throws(() => manager.startInstall(value), { code: 'INVALID_PREREQUISITE' });
    assert.ok(!JSON.stringify(manager.getState()).includes('PRIVATE_FIXTURE')); assert.equal(state.opened.length, 0);
  } finally { await manager.dispose(); }
});
test('tampered software source, missing WinGet or installer failure never triggers fallback elevation/commands', async () => {
  for (const mode of ['source', 'missing', 'failed']) {
    const { manager, state } = fixture({ sourceTrusted: mode !== 'source', install: mode === 'failed' ? async () => ({ ok: false, stdout: '', stderr: 'PRIVATE_FIXTURE_DO_NOT_FORWARD' }) : undefined });
    if (mode === 'missing') state.files.delete(normalize(winget));
    try {
      await manager.detect(); manager.startInstall('git-bash'); const report = await manager.waitForIdle();
      assert.equal(report.job.running, false); assert.notEqual(item(report, 'git-bash').status, 'ready');
      assert.equal(state.installs.length, mode === 'failed' ? 1 : 0); assert.equal(state.opened.length, 0); assert.ok(!JSON.stringify(report).includes('PRIVATE_FIXTURE'));
      assert.ok(state.calls.every(call => !/cmd\.exe|pwsh\.exe|msiexec\.exe/i.test(call.file)));
    } finally { await manager.dispose(); }
  }
});
test('cancellation keeps the install lock until the owned runner confirms termination', async () => {
  let entered = false, terminated = false;
  const { manager } = fixture({ install: async (_file, _args, settings) => { entered = true; return new Promise(resolve => settings.signal.addEventListener('abort', () => {
    setTimeout(() => { terminated = true; resolve({ ok: false, stdout: '', stderr: '' }); }, 20);
  }, { once: true })); } });
  try {
    await manager.detect(); manager.startInstall('python'); await until(() => entered); manager.cancelInstall();
    assert.equal(manager.getState().job.running, true); assert.equal(terminated, false);
    assert.throws(() => manager.startInstall('git-bash'), { code: 'INSTALL_ALREADY_RUNNING' });
    const report = await manager.waitForIdle(); assert.equal(terminated, true); assert.equal(report.job.running, false); assert.equal(report.job.cancelled, true);
    assert.equal(report.job.results[0].status, 'cancelled'); assert.equal(item(report, 'python').status, 'missing');
  } finally { await manager.dispose(); }
});
test('an uncooperative injected runner stays bounded and retains the lock until eventual cleanup', async () => {
  let entered = false, release;
  const { manager } = fixture({ options: { installTimeoutMs: 15, stopGraceMs: 10 }, install: async () => { entered = true; return new Promise(resolve => { release = resolve; }); } });
  await manager.detect(); manager.startInstall('python'); await until(() => entered);
  const report = await manager.waitForIdle(); assert.equal(report.job.cleanupPending, true); assert.equal(report.job.running, true); assert.equal(report.canContinue, false);
  assert.throws(() => manager.startInstall('git-bash'), { code: 'INSTALL_ALREADY_RUNNING' });
  const disposed = await manager.dispose(); assert.equal(disposed.job.running, true, 'Dispose must not falsely report an unconfirmed process as terminated');
  release({ ok: false, stdout: '', stderr: '' }); await until(() => !manager.getState().job.running);
});
test('official pages are fixed HTTPS destinations, including WinGet help; renderer URLs are rejected', async () => {
  const { manager, state } = fixture();
  try {
    for (const id of ['git-bash', 'python', 'libreoffice', 'winget']) assert.deepEqual(await manager.openOfficial(id), { opened: true });
    assert.deepEqual(state.opened, ['https://git-scm.com/install/windows', 'https://www.python.org/downloads/windows/', 'https://www.libreoffice.org/download/download-libreoffice/', 'https://learn.microsoft.com/windows/package-manager/winget/']);
    for (const id of ['https://untrusted.invalid', '__proto__', { url: 'https://untrusted.invalid' }, 'bundled-node']) await assert.rejects(() => manager.openOfficial(id), { code: 'INVALID_PREREQUISITE' });
  } finally { await manager.dispose(); }
});
test('read-only probe timeout and explicit cancellation remain bounded without starting an installer', async () => {
  const timeout = fixture({ options: { probeTimeoutMs: 10, stopGraceMs: 10 }, overrideRun: async (file, args, settings) => {
    if (normalize(file) === normalize(node) && args[0] === '-p') return new Promise(resolve => settings.signal.addEventListener('abort', () => resolve({ ok: false, stdout: '', stderr: '' }), { once: true }));
  } });
  try { const report = await timeout.manager.detect(); assert.equal(report.requiredReady, false); assert.equal(timeout.state.installs.length, 0); }
  finally { await timeout.manager.dispose(); }
  let entered = false;
  const cancelled = fixture({ overrideRun: async (file, _args, settings) => {
    if (normalize(file) === normalize(power)) { entered = true; return new Promise(resolve => settings.signal.addEventListener('abort', () => resolve({ ok: false, stdout: '', stderr: '' }), { once: true })); }
  } });
  const controller = new AbortController(), detection = cancelled.manager.detect({ signal: controller.signal });
  await until(() => entered); controller.abort();
  await assert.rejects(() => detection, { code: 'PREREQUISITE_CANCELLED' }); assert.equal(cancelled.state.installs.length, 0);
  await cancelled.manager.dispose();
});
