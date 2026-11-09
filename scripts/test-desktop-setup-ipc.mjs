/** VM-only desktop setup IPC boundary checks. No Electron, backend, installer or host mutation is started. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'desktop');
const [mainSource, preloadSource] = await Promise.all(['main.cjs', 'preload.cjs'].map(name => fs.readFile(path.join(desktop, name), 'utf8')));
const clone = value => structuredClone(value);
const channels = ['ccagent:prerequisites', 'ccagent:install-prerequisite', 'ccagent:cancel-prerequisite-install', 'ccagent:prerequisite-page', 'ccagent:review-prerequisites'];
const guideVersion = 1;

function harness({ requiredReady = true, running = false, reviewed = false } = {}) {
  const handlers = new Map(), windows = [], writes = [], effects = [], managerCalls = [];
  const saved = { workspace: 'C:\\fixture\\workspace', ...(reviewed ? { environmentGuideVersion: guideVersion } : {}) };
  const environment = {
    guideVersion, requiredReady, canContinue: requiredReady && !running,
    components: [{ id: 'powershell', required: true, status: requiredReady ? 'ready' : 'missing' }, { id: 'python', required: false, status: 'missing' }],
    job: { running, results: [] },
  };
  const supportedIds = new Set(['windows', 'architecture', 'powershell', 'bundled-node', 'bundled-npm', 'git-bash', 'python', 'libreoffice', 'winget']);
  const checkedId = id => { if (typeof id !== 'string' || !supportedIds.has(id)) throw new Error('Unsupported prerequisite identifier'); return id; };
  const manager = {
    detect: async () => { managerCalls.push(['detect']); return clone(environment); },
    getState: () => { managerCalls.push(['getState']); return clone(environment); },
    startInstall: async (...args) => { managerCalls.push(['startInstall', ...args]); checkedId(args[0]); assert.equal(args.length, 1); return clone(environment); },
    cancelInstall: async (...args) => { managerCalls.push(['cancelInstall', ...args]); assert.equal(args.length, 0); return clone(environment); },
    openOfficial: async (...args) => { managerCalls.push(['openOfficial', ...args]); checkedId(args[0]); assert.equal(args.length, 1); return { opened: true }; },
    dispose: async () => { managerCalls.push(['dispose']); },
  };
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; windows.push(this);
      const contents = new EventEmitter(); contents.mainFrame = { url: '' }; contents.getURL = () => contents.mainFrame.url;
      contents.setWindowOpenHandler = callback => { this.openHandler = callback; };
      contents.executeJavaScript = async script => { effects.push(['executeJavaScript', script]); };
      contents.session = Object.assign(new EventEmitter(), { webRequest: { onBeforeSendHeaders() {} }, setPermissionCheckHandler() {}, setPermissionRequestHandler() {} });
      this.webContents = contents;
    }
    async loadURL(url) { this.webContents.mainFrame.url = url; effects.push(['loadURL', url]); }
    show() {} focus() {} restore() {} isMinimized() { return false; } isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; this.emit('closed'); }
    getSize() { return [1440, 940]; }
    static getAllWindows() { return windows.filter(window => !window.destroyed); }
  }
  const app = Object.assign(new EventEmitter(), { isPackaged: true, setName() {}, setAppUserModelId() {}, getVersion: () => '0.0.0-fixture',
    requestSingleInstanceLock: () => true, getPath: name => path.join('C:\\fixture', name), setPath() {},
    whenReady: () => new Promise(() => {}), quit: () => { effects.push(['quit']); } });
  const runtime = {
    readState: () => clone(saved), writeState: (_file, state) => { writes.push(clone(state)); },
    freePort: async () => { throw new Error('Unexpected backend startup'); },
    startBackend: () => { throw new Error('Unexpected backend startup'); }, waitForBackend: async () => { throw new Error('Unexpected backend startup'); }, stopBackend: async () => {},
    serviceRequest: async (_origin, _token, route) => {
      effects.push(['serviceRequest', route]);
      if (route === '/api/account/status') return { origin: 'https://account.example.invalid', user: { id: 'fixture-account', email: 'fixture@example.invalid' } };
      if (route === '/api/customize/models') return { models: [] };
      if (route === '/api/workspaces') return { current: saved.workspace };
      if (route === '/api/desktop/status') return { busy: false };
      throw new Error('Unexpected fixture API request');
    },
    sameOrigin: (url, origin) => { try { return new URL(url).origin === origin; } catch { return false; } },
    externalUrl: value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } },
    onboardingFinished: () => false,
    completeOnboarding: (state, account) => { assert.equal(account.user.id, 'fixture-account'); return { ...state, onboardingAccounts: ['fixture-account-marker'] }; },
  };
  const electron = { app, BrowserWindow: Window, Menu: { setApplicationMenu() {}, buildFromTemplate: value => value },
    dialog: { showErrorBox: (...args) => effects.push(['showErrorBox', ...args]), showMessageBox: async () => ({ response: 0 }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openExternal: async url => effects.push(['openExternal', url]), showItemInFolder: file => effects.push(['showItemInFolder', file]) },
    ipcMain: { handle: (channel, callback) => { assert(!handlers.has(channel), 'IPC registered twice'); handlers.set(channel, callback); } } };
  const prerequisiteModule = { createPrerequisiteManager: () => manager, ENVIRONMENT_GUIDE_VERSION: guideVersion, PREREQUISITE_GUIDE_VERSION: guideVersion, GUIDE_VERSION: guideVersion };
  const mockFs = { appendFileSync: (...args) => effects.push(['mockLog', ...args]), mkdirSync() {}, existsSync: () => true, statSync: () => ({ size: 0 }), renameSync() {} };
  const modules = new Map([['electron', electron], ['node:fs', mockFs], ['node:path', path], ['node:url', { pathToFileURL }],
    ['node:crypto', { randomBytes: count => Buffer.alloc(count, 7) }],
    ['node:child_process', { execFile: () => { throw new Error('Unexpected OS process execution'); } }],
    ['./runtime.cjs', Object.fromEntries(Object.keys(runtime).map(name => [name, (...args) => runtime[name](...args)]))],
    ['./prerequisites.cjs', prerequisiteModule], ['./prerequisite-manager.cjs', prerequisiteModule], ['./prerequisiteManager.cjs', prerequisiteModule]]);
  const context = vm.createContext({ require: id => { assert(modules.has(id), `Unmocked require: ${id}`); return modules.get(id); },
    __dirname: desktop, Buffer, URL, console: { log() {}, error() {}, warn() {} },
    process: { env: {}, platform: 'win32', arch: 'x64', versions: { node: '24.22.2', electron: '45.2.3' }, resourcesPath: 'C:\\fixture\\resources', execPath: 'C:\\fixture\\CCAGENT.exe' },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, __fixtureState: clone(saved) });
  vm.runInContext(mainSource, context, { filename: path.join(desktop, 'main.cjs') });
  vm.runInContext("state = __fixtureState; stateFile = 'C:/fixture/desktop-state.json'; logFile = 'C:/fixture/desktop.log'; backendRoot = 'C:/fixture/backend'; origin = 'http://127.0.0.1:4317'; ready = true; prerequisites = createPrerequisiteManager({ backendRoot }); registerIpc(); showGuide();", context);
  const guide = vm.runInContext('guideWindow', context);
  const event = () => ({ sender: guide.webContents, senderFrame: guide.webContents.mainFrame });
  const invoke = (channel, body, source = event()) => { assert(handlers.has(channel), `Missing IPC channel: ${channel}`); return Promise.resolve().then(() => handlers.get(channel)(source, body)); };
  return { invoke, handlers, guide, event, environment, windows, writes, effects, managerCalls, context, runtime, manager, app };
}

function preloadHarness() {
  const calls = []; let bridge;
  const context = vm.createContext({ require: id => { assert.equal(id, 'electron'); return {
    contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'ccagentSetup'); assert.equal(bridge, undefined); bridge = value; } },
    ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(); } },
  }; } });
  vm.runInContext(preloadSource, context, { filename: path.join(desktop, 'preload.cjs') });
  return { bridge, calls };
}

test('desktop prerequisite IPC is guide-only, allowlisted and completion-gated without running host processes', async t => {
  await t.test('VM requires only explicit mocks and registers the five environment handlers', () => {
    const fixture = harness();
    for (const channel of channels) assert(fixture.handlers.has(channel), channel);
    assert.equal(fixture.effects.length, 1, 'only the mock guide file is loaded during initialization');
    assert.equal(fixture.effects[0][0], 'loadURL'); assert.match(fixture.effects[0][1], /^file:/);
  });
  await t.test('every environment handler rejects other senders, subframes and other file/remote URLs before manager access', async () => {
    const fixture = harness(), original = fixture.guide.webContents.mainFrame.url;
    for (const channel of channels) {
      const argument = channel === 'ccagent:prerequisites' ? { refresh: true } : 'python';
      for (const source of [{ sender: {}, senderFrame: fixture.guide.webContents.mainFrame },
        { sender: fixture.guide.webContents, senderFrame: { url: original } }, { sender: fixture.guide.webContents, senderFrame: undefined }]) {
        const before = fixture.managerCalls.length; await assert.rejects(fixture.invoke(channel, argument, source)); assert.equal(fixture.managerCalls.length, before);
      }
      for (const url of ['https://evil.example.invalid/', 'file:///C:/fixture/other.html', original + '?changed=true']) {
        fixture.guide.webContents.mainFrame.url = url;
        const before = fixture.managerCalls.length; await assert.rejects(fixture.invoke(channel, argument)); assert.equal(fixture.managerCalls.length, before);
      }
      fixture.guide.webContents.mainFrame.url = original;
    }
  });
  await t.test('renderer cannot turn package identifiers into arbitrary executables, shells or download URLs', async () => {
    const fixture = harness();
    const hostile = ['C:\\Windows\\System32\\cmd.exe', 'powershell.exe -Command whoami', 'https://evil.example.invalid/installer.exe',
      'file:///C:/fixture/installer.exe', '--install', { id: 'python', exe: 'cmd.exe', args: ['/c', 'whoami'] }, { id: 'python', url: 'https://evil.example.invalid/' }];
    for (const channel of ['ccagent:install-prerequisite', 'ccagent:prerequisite-page']) for (const value of hostile) await assert.rejects(fixture.invoke(channel, value));
    assert.equal(fixture.managerCalls.length, 0, 'hostile values never reach the trusted installer or official-page manager');
    assert(!fixture.effects.some(([name]) => name === 'openExternal' || name === 'serviceRequest'));
  });
  await t.test('refresh accepts only its boolean option and otherwise never reaches the environment detector', async () => {
    const fixture = harness();
    await fixture.invoke('ccagent:prerequisites', { refresh: false }); assert.deepEqual(fixture.managerCalls, [['getState']]);
    await fixture.invoke('ccagent:prerequisites', { refresh: true }); assert.deepEqual(fixture.managerCalls.at(-1), ['detect']);
    await fixture.invoke('ccagent:prerequisites'); assert.equal(fixture.managerCalls.filter(([name]) => name === 'detect').length, 2);
    const before = fixture.managerCalls.length;
    for (const invalid of [null, [], true, 'python', { refresh: 'true' }, { refresh: true, exe: 'cmd.exe' }, { url: 'https://evil.example.invalid/' }]) {
      await assert.rejects(fixture.invoke('ccagent:prerequisites', invalid), /参数无效/);
    }
    assert.equal(fixture.managerCalls.length, before);
  });
  await t.test('installation and official help forward only fixed component identifiers, while cancellation forwards no caller arguments', async () => {
    const fixture = harness();
    for (const id of ['git-bash', 'python']) await fixture.invoke('ccagent:install-prerequisite', id);
    assert.deepEqual(fixture.managerCalls, [['startInstall', 'git-bash'], ['startInstall', 'python']]);
    for (const id of ['windows', 'bundled-node', 'libreoffice', 'winget', 'uv', 'photoshop']) await assert.rejects(fixture.invoke('ccagent:install-prerequisite', id), /不支持安装/);
    assert.equal(fixture.managerCalls.length, 2, 'unsupported components cannot reach the mocked installer');
    for (const id of ['windows', 'architecture', 'powershell', 'bundled-node', 'bundled-npm', 'git-bash', 'python', 'libreoffice', 'winget']) await fixture.invoke('ccagent:prerequisite-page', id);
    await fixture.invoke('ccagent:cancel-prerequisite-install', { exe: 'cmd.exe', url: 'https://evil.example.invalid/' });
    assert.deepEqual(fixture.managerCalls.at(-1), ['cancelInstall']);
    assert(!fixture.effects.some(([name]) => name === 'openExternal'));
  });
  await t.test('required missing components block review, login and completion without recording approval', async () => {
    const fixture = harness({ requiredReady: false });
    for (const [channel, argument] of [['ccagent:review-prerequisites'], ['ccagent:login'], ['ccagent:finish', '']]) await assert.rejects(fixture.invoke(channel, argument), /必需/);
    assert.equal(fixture.managerCalls.filter(([name]) => name === 'detect').length, 3, 'all three gates perform real manager readiness checks');
    assert.equal(fixture.writes.length, 0); assert.equal(fixture.windows.length, 1);
    assert(!fixture.effects.some(([name]) => name === 'serviceRequest'));
  });
  await t.test('a running installation blocks review and cannot be bypassed by an older saved review', async () => {
    const fixture = harness({ running: true, reviewed: true });
    for (const [channel, argument] of [['ccagent:review-prerequisites'], ['ccagent:login'], ['ccagent:finish', 'settings']]) await assert.rejects(fixture.invoke(channel, argument), /安装仍在进行/);
    assert.equal(fixture.managerCalls.filter(([name]) => name === 'detect').length, 3);
    assert.equal(fixture.writes.length, 0); assert.equal(fixture.windows.length, 1);
  });
  await t.test('readiness alone cannot skip review, and an older review cannot override a newly missing required component', async () => {
    const fresh = harness();
    for (const [channel, argument] of [['ccagent:login'], ['ccagent:finish', '']]) await assert.rejects(fresh.invoke(channel, argument), /先完成环境检测向导/);
    assert.equal(fresh.writes.length, 0); assert.equal(fresh.windows.length, 1);
    const stale = harness({ reviewed: true }); stale.environment.requiredReady = false;
    for (const [channel, argument] of [['ccagent:login'], ['ccagent:finish', '']]) await assert.rejects(stale.invoke(channel, argument), /必需/);
    assert.equal(stale.writes.length, 0); assert.equal(stale.windows.length, 1);
  });
  await t.test('optional missing tools permit review, record the guide version and allow subsequent login', async () => {
    const fixture = harness();
    await fixture.invoke('ccagent:review-prerequisites');
    assert.equal(fixture.writes.at(-1)?.environmentGuideVersion, guideVersion);
    assert(!fixture.managerCalls.some(([name]) => name === 'startInstall'));
    await fixture.invoke('ccagent:login');
    assert.equal(fixture.windows.length, 2); assert(fixture.guide.destroyed);
  });
  await t.test('successful completion retains the environment review and existing account onboarding behavior', async () => {
    const fixture = harness(); await fixture.invoke('ccagent:review-prerequisites'); await fixture.invoke('ccagent:finish', 'settings');
    assert.equal(fixture.writes.at(-1)?.environmentGuideVersion, guideVersion);
    assert.deepEqual(fixture.writes.at(-1)?.onboardingAccounts, ['fixture-account-marker']);
    assert.equal(fixture.windows.length, 2); assert(fixture.guide.destroyed);
  });
  await t.test('login and completion reload an existing main window after backend origin changes, without creating another main window', async () => {
    for (const [channel, argument, target] of [['ccagent:login', undefined, '/'], ['ccagent:finish', '', '/'], ['ccagent:finish', 'settings', '/?view=settings']]) {
      const fixture = harness({ reviewed: true }); await vm.runInContext('showMain()', fixture.context);
      const main = fixture.windows[1]; assert.equal(main.webContents.getURL(), 'http://127.0.0.1:4317/');
      vm.runInContext("origin = 'http://127.0.0.1:4318'", fixture.context);
      await fixture.invoke(channel, argument);
      assert.equal(fixture.windows.length, 2, 'retry reuses the existing main window');
      assert.equal(main.webContents.getURL(), 'http://127.0.0.1:4318' + target, `${channel} must leave the dead backend origin`);
    }
    const fixture = harness({ reviewed: true }); await vm.runInContext('showMain()', fixture.context);
    const main = fixture.windows[1]; main.webContents.mainFrame.url = 'http://127.0.0.1:4317/?session=existing';
    const before = fixture.effects.filter(([name]) => name === 'loadURL').length;
    await fixture.invoke('ccagent:login'); assert.equal(main.webContents.getURL(), 'http://127.0.0.1:4317/?session=existing');
    assert.equal(fixture.effects.filter(([name]) => name === 'loadURL').length, before, 'same-origin login preserves the existing conversation');
  });
  await t.test('quitting during detection, port allocation or backend readiness cannot spawn an orphan or restore ready=true', async () => {
    for (const phase of ['detect', 'freePort', 'waitForBackend']) {
      const fixture = harness({ reviewed: true }), entered = Promise.withResolvers(), release = Promise.withResolvers();
      let starts = 0, stops = 0;
      if (phase === 'detect') fixture.manager.detect = async () => { entered.resolve(); return release.promise; };
      fixture.runtime.freePort = async () => { if (phase === 'freePort') { entered.resolve(); return release.promise; } return 4318; };
      fixture.runtime.startBackend = () => { starts++; return Object.assign(new EventEmitter(), { exitCode: null }); };
      fixture.runtime.waitForBackend = async () => { if (phase === 'waitForBackend') { entered.resolve(); await release.promise; } };
      fixture.runtime.stopBackend = async child => { if (child) { stops++; child.exitCode = 0; child.emit('exit', 0); } };
      vm.runInContext('ready = false', fixture.context);
      const starting = vm.runInContext('ensureBackend()', fixture.context); await entered.promise;
      const stopping = vm.runInContext('quitting = true; shutdown()', fixture.context);
      release.resolve(phase === 'detect' ? clone(fixture.environment) : phase === 'freePort' ? 4318 : undefined);
      await Promise.all([starting, stopping]);
      assert.equal(starts, phase === 'waitForBackend' ? 1 : 0, `${phase}: shutdown must not create a later backend`);
      if (phase === 'waitForBackend') assert.equal(stops, 1, 'shutdown stops the already-created backend');
      assert.equal(vm.runInContext('ready', fixture.context), false, `${phase}: a finishing startup cannot restore ready after shutdown`);
      assert.equal(fixture.managerCalls.filter(([name]) => name === 'dispose').length, 1);
      assert.equal(fixture.effects.filter(([name]) => name === 'quit').length, 1);
    }
  });
  await t.test('reopening the environment page selects the existing trusted guide using only a fixed application event', () => {
    const fixture = harness(); vm.runInContext('showGuide(true)', fixture.context);
    assert.equal(fixture.windows.length, 1);
    assert.deepEqual(fixture.effects.filter(([name]) => name === 'executeJavaScript'), [['executeJavaScript', "document.dispatchEvent(new Event('ccagent:show-environment'))"]]);
  });
  await t.test('preload exposes only named wrappers for the four environment operations plus review', async () => {
    const { bridge, calls } = preloadHarness(); assert(Object.isFrozen(bridge));
    const legacy = ['status', 'login', 'chooseFolder', 'saveModel', 'testModel', 'officialServices', 'saveOfficialServices', 'accountPage', 'finish', 'logs'];
    const additions = ['prerequisites', 'installPrerequisite', 'cancelPrerequisiteInstall', 'openPrerequisitePage', 'reviewPrerequisites'];
    assert.deepEqual(Object.keys(bridge).sort(), [...legacy, ...additions].sort());
    for (const name of Object.keys(bridge)) assert.equal(typeof bridge[name], 'function');
    await bridge.prerequisites({ refresh: true }); await bridge.installPrerequisite('python'); await bridge.cancelPrerequisiteInstall(); await bridge.openPrerequisitePage('python'); await bridge.reviewPrerequisites();
    assert.deepEqual(calls.map(([channel]) => channel), channels);
    assert.deepEqual(clone(calls[0][1]), { refresh: true });
    assert.deepEqual(calls.slice(1).map(args => clone(args)), [
      ['ccagent:install-prerequisite', 'python'], ['ccagent:cancel-prerequisite-install'], ['ccagent:prerequisite-page', 'python'], ['ccagent:review-prerequisites'],
    ]);
    assert.equal(bridge.invoke, undefined); assert.equal(bridge.exec, undefined); assert.equal(bridge.shell, undefined); assert.equal(bridge.openExternal, undefined);
  });
});
