import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
const { freePort } = createRequire(import.meta.url)('../desktop/runtime.cjs');
const run = promisify(execFile);
if (process.platform !== 'win32') throw new Error('Installed desktop regression requires Windows');
if (!(process.env.GITHUB_ACTIONS === 'true' && process.env.CI === 'true') && !(process.env.CCAGENT_DEDICATED_WINDOWS_TEST_USER === '1' && /^ccagent-ci-/i.test(os.userInfo().username))) {
  throw new Error('Install/uninstall regression is restricted to a disposable CI runner or a dedicated ccagent-ci-* Windows test user; it must never touch a normal user installation');
}
const root = path.resolve(import.meta.dirname, '..'), release = path.join(root, 'output/desktop/release');
const installers = (await fs.readdir(release)).filter(name => /^CCAGENT-Setup-[0-9.]+-x64\.exe$/.test(name));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const expected = `CCAGENT-Setup-${pkg.version}-x64.exe`;
assert(installers.includes(expected), 'Build the current-version unsigned CI installer first');
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ccagent-installed-ci-'));
const install = path.join(folder, 'installed'), userData = path.join(folder, 'desktop-data'), home = path.join(folder, 'home');
const evidence = path.join(root, 'output/desktop/ci-evidence'); await fs.mkdir(evidence, { recursive: true });
let child, socket;
const processEnv = { ...process.env, CCAGENT_DESKTOP_USER_DATA: userData, CCAGENT_HOME: home, CCAGENT_PLATFORM_HOME: home, CCAGENT_ENV_FILE: path.join(folder, 'empty.env'), CCAGENT_DESKTOP_WORKSPACE: path.join(folder, 'workspace') };
for (const name of ['CCAGENT_ACCOUNT_ID', 'CCAGENT_AUTH_SESSION_FILE', 'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete processEnv[name];
await fs.writeFile(processEnv.CCAGENT_ENV_FILE, '');
const installer = path.join(release, expected);
const silentInstall = () => run(installer, ['/S', `/D=${install}`], { windowsHide: true, timeout: 180000, env: processEnv });
try {
  await silentInstall();
  const executable = path.join(install, 'CCAGENT.exe'); assert((await fs.stat(executable)).isFile());
  await fs.mkdir(userData, { recursive: true }); await fs.writeFile(path.join(userData, 'upgrade-retention.txt'), 'keep isolated configuration');
  const port = await freePort();
  child = spawn(executable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { env: processEnv, windowsHide: true, stdio: 'ignore' });
  child.once('error', error => { console.error('Packaged desktop failed to spawn:', error.code); });
  let target;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Installed application exited before its guide loaded');
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(row => row.type === 'page' && /welcome\.html$/.test(row.url)); if (target) break; } catch { /* Wait for packaged Chromium. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(target?.webSocketDebuggerUrl, 'Installed packaged guide is observable');
  socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId, timeout = setTimeout(() => reject(new Error('CDP_TIMEOUT')), 15000);
    const listener = event => { const message = JSON.parse(String(event.data)); if (message.id !== id) return; clearTimeout(timeout); socket.removeEventListener('message', listener); message.error ? reject(new Error(message.error.message)) : resolve(message.result); };
    socket.addEventListener('message', listener); socket.send(JSON.stringify({ id, method, params }));
  });
  const dom = await call('Runtime.evaluate', { expression: "new Promise(resolve => { const read=()=>resolve(JSON.stringify({title:document.title,text:document.body.innerText,bridge:typeof window.ccagentSetup,ready:document.readyState})); document.readyState==='complete'?read():window.addEventListener('load',read,{once:true}); })", returnByValue: true, awaitPromise: true });
  const state = JSON.parse(dom.result.value);
  assert.match(state.title, /CCAGENT/); assert.equal(state.bridge, 'object'); assert.match(state.text, /环境|开始使用/); assert.equal(state.ready, 'complete');
  const screenshot = await call('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(evidence, 'installed-guide.png'), Buffer.from(screenshot.data, 'base64'));
  await fs.writeFile(path.join(evidence, 'installed-guide.json'), JSON.stringify({ version: pkg.version, title: state.title, bridge: state.bridge, ready: state.ready, isolated: true }, null, 2));
  // Close this exact test-owned application through its browser protocol.
  await call('Browser.close').catch(() => {}); socket.close(); socket = undefined;
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise((_, reject) => setTimeout(() => reject(new Error('Packaged application did not shut down')), 15000))]);
  await silentInstall();
  assert.equal(await fs.readFile(path.join(userData, 'upgrade-retention.txt'), 'utf8'), 'keep isolated configuration');
  const uninstaller = (await fs.readdir(install)).find(name => /^Uninstall.*\.exe$/i.test(name)); assert(uninstaller, 'Installed uninstaller exists');
  await run(path.join(install, uninstaller), ['/S'], { windowsHide: true, timeout: 120000, env: processEnv });
  const removedBy = Date.now() + 20000;
  while (Date.now() < removedBy && await fs.stat(executable).catch(() => null)) await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await fs.stat(executable).catch(() => null), null, 'Uninstall removes the installed executable');
  assert.equal(await fs.readFile(path.join(userData, 'upgrade-retention.txt'), 'utf8'), 'keep isolated configuration');
  console.log('PASS installed Windows desktop: actual NSIS install, packaged Electron/guide/preload, screenshot, clean shutdown, reinstall retention and uninstall.');
} finally {
  socket?.close();
  if (child && child.exitCode === null) await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  console.log(`Isolated install evidence: ${folder}`);
}
