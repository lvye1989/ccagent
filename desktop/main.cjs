const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { readState, writeState, freePort, serviceRequest, startBackend, waitForBackend, stopBackend, sameOrigin, externalUrl, onboardingFinished, completeOnboarding } = require('./runtime.cjs');
const { createPrerequisiteManager } = require('./prerequisites.cjs');

app.setName('CCAGENT');
app.setAppUserModelId('pro.ccagent.desktop');
const productVersion = app.isPackaged ? app.getVersion() : readState(path.resolve(__dirname, '../package.json')).version || app.getVersion();
if (process.env.CCAGENT_DESKTOP_USER_DATA) app.setPath('userData', path.resolve(process.env.CCAGENT_DESKTOP_USER_DATA));
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
let mainWindow, guideWindow, child, origin, state, stateFile, logFile, backendRoot;
let ready = false, startupError = '', quitting = false, exitPrompt = false;
let prerequisites, backendStarting;
let updating = false;
const environmentGuideVersion = 1;
const token = randomBytes(32).toString('hex');
const guideUrl = pathToFileURL(path.join(__dirname, 'welcome.html')).href;
const api = (route, body, timeout) => serviceRequest(origin, token, route, body, timeout);

function log(text) {
  // Persist lifecycle/error summaries only. Model output and credentials are
  // deliberately not copied to the desktop diagnostic log.
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${text}\n`);
}
function save(patch) { state = { ...state, ...patch }; writeState(stateFile, state); }
function trustedGuide(event) {
  if (!guideWindow || event.sender !== guideWindow.webContents || event.senderFrame !== guideWindow.webContents.mainFrame || event.senderFrame.url !== guideUrl) throw new Error('Invalid desktop request');
}
function reveal(window) { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); }
function configureWindow(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (externalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!sameOrigin(url, origin) && url !== guideUrl) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => {
    dialog.showErrorBox('CCAGENT 页面已停止', '请通过“查看 → 重新加载”恢复页面。正在执行的任务由本地服务管理。');
  });
}
function showGuide(environment = false) {
  const selectEnvironment = () => {
    if (environment === true && guideWindow && !guideWindow.isDestroyed()) void guideWindow.webContents.executeJavaScript("document.dispatchEvent(new Event('ccagent:show-environment'))").catch(() => {});
  };
  if (guideWindow && !guideWindow.isDestroyed()) { reveal(guideWindow); selectEnvironment(); return; }
  guideWindow = new BrowserWindow({ width: 1100, height: 790, minWidth: 980, minHeight: 730, title: 'CCAGENT · 开始使用',
    backgroundColor: '#f5f7fb', autoHideMenuBar: true, show: false, icon: path.join(__dirname, 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  configureWindow(guideWindow);
  guideWindow.on('closed', () => { guideWindow = null; });
  guideWindow.once('ready-to-show', () => guideWindow?.show());
  void guideWindow.loadURL(guideUrl).then(() => { guideWindow?.show(); selectEnvironment(); });
}
async function showMain(view = '') {
  if (!ready) throw new Error(startupError || '本地服务正在启动，请稍候。');
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (view || !sameOrigin(mainWindow.webContents.getURL(), origin)) await mainWindow.loadURL(origin + (view ? '/?view=' + encodeURIComponent(view) : '/'));
    reveal(mainWindow); return;
  }
  mainWindow = new BrowserWindow({ width: state.width || 1440, height: state.height || 940, minWidth: 1000, minHeight: 700,
    title: 'CCAGENT', backgroundColor: '#faf9f6', icon: path.join(__dirname, 'icon.ico'), show: false,
    webPreferences: { partition: 'persist:ccagent-desktop', contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  configureWindow(mainWindow);
  mainWindow.webContents.on('did-finish-load', () => {
    if (!sameOrigin(mainWindow?.webContents.getURL(), origin)) return;
    let route; try { route = new URL(mainWindow.webContents.getURL()).pathname; } catch { return; }
    if (route === '/') void api('/api/account/status').then(account => { if (!onboardingFinished(state, account)) showGuide(); }).catch(() => {});
  });
  const session = mainWindow.webContents.session;
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    // A remote embedded frame must never receive the local service token.
    if (sameOrigin(details.url, origin)) headers['x-ccagent-desktop-token'] = token;
    else delete headers['x-ccagent-desktop-token'];
    callback({ requestHeaders: headers });
  });
  session.setPermissionCheckHandler((contents, permission, requestingOrigin) => permission === 'media' && sameOrigin(requestingOrigin, origin) && contents === mainWindow?.webContents);
  session.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (permission !== 'media' || contents !== mainWindow?.webContents || !sameOrigin(details.requestingUrl, origin) || details.mediaTypes?.includes('video')) return callback(false);
    const result = await dialog.showMessageBox(mainWindow, { type: 'question', title: '使用麦克风', message: '允许 CCAGENT 使用麦克风进行语音输入？', buttons: ['允许本次使用', '取消'], defaultId: 1, cancelId: 1 });
    callback(result.response === 0);
  });
  session.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ title: '保存 CCAGENT 文件', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
  });
  mainWindow.on('page-title-updated', event => event.preventDefault());
  mainWindow.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    if (exitPrompt) return;
    exitPrompt = true;
    void requestExit().finally(() => { exitPrompt = false; });
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  await mainWindow.loadURL(origin + (view ? '/?view=' + encodeURIComponent(view) : '/'));
  mainWindow?.show();
}
async function requestExit() {
  let busy = false;
  if (ready) try { busy = (await api('/api/desktop/status')).busy; } catch { /* Service may already have stopped. */ }
  const owner = mainWindow || guideWindow;
  const result = await dialog.showMessageBox(owner, { type: busy ? 'warning' : 'question', title: '退出 CCAGENT',
    message: busy ? '当前有任务正在执行，退出会中断任务。' : '确定退出 CCAGENT？',
    detail: '退出后定时任务将暂停，重新打开应用后继续检查。已保存的配置、会话和工作文件会保留。',
    buttons: busy ? ['继续使用', '退出并中断任务'] : ['继续使用', '退出应用'], defaultId: 0, cancelId: 0,
  });
  if (result.response === 1) {
    if (mainWindow) { const [width, height] = mainWindow.getSize(); save({ width, height }); }
    quitting = true; app.quit();
  }
}
async function status() {
  const account = ready ? await api('/api/account/status').catch(() => null) : null;
  const models = account ? (await api('/api/customize/models')).models : [];
  const workspace = account ? (await api('/api/workspaces')).current : state.workspace;
  return { ready, authenticated: Boolean(account), email: account?.user?.email, error: startupError, version: productVersion, workspace, models,
    environmentReviewed: state.environmentGuideVersion === environmentGuideVersion,
    nodeVersion: readState(path.join(backendRoot, 'desktop-manifest.json')).nodeVersion,
  };
}
async function checkEnvironment(reviewed = false) {
  const report = await prerequisites.detect();
  if (report.job?.running) throw new Error('环境安装仍在进行，请等待完成或先取消安装。');
  if (!report.requiredReady) throw new Error('请先修复环境检测中标记为必需的组件，然后重新检测。');
  if (reviewed && state.environmentGuideVersion !== environmentGuideVersion) throw new Error('请先完成环境检测向导。');
  return report;
}
function registerIpc() {
  ipcMain.handle('ccagent:prerequisites', async (event, options) => {
    trustedGuide(event);
    if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'refresh') || (options.refresh !== undefined && typeof options.refresh !== 'boolean'))) throw new Error('环境检测参数无效。');
    const report = options?.refresh === false ? prerequisites.getState() : await prerequisites.detect();
    if (options?.refresh !== false && report.requiredReady && !ready && !quitting) void ensureBackend();
    return report;
  });
  ipcMain.handle('ccagent:install-prerequisite', async (event, id) => {
    trustedGuide(event);
    if (typeof id !== 'string' || !['git-bash', 'python'].includes(id)) throw new Error('不支持安装此组件，请使用官方安装说明。');
    return prerequisites.startInstall(id);
  });
  ipcMain.handle('ccagent:cancel-prerequisite-install', async event => { trustedGuide(event); return prerequisites.cancelInstall(); });
  ipcMain.handle('ccagent:prerequisite-page', async (event, id) => {
    trustedGuide(event);
    if (typeof id !== 'string' || !['windows', 'architecture', 'powershell', 'bundled-node', 'bundled-npm', 'git-bash', 'python', 'libreoffice', 'winget'].includes(id)) throw new Error('无效的组件帮助页面。');
    return prerequisites.openOfficial(id);
  });
  ipcMain.handle('ccagent:review-prerequisites', async event => {
    trustedGuide(event);
    const report = await checkEnvironment();
    save({ environmentGuideVersion });
    return report;
  });
  ipcMain.handle('ccagent:login', async event => { trustedGuide(event); await checkEnvironment(true); await showMain(); guideWindow?.close(); });
  ipcMain.handle('ccagent:status', async event => { trustedGuide(event); return status(); });
  ipcMain.handle('ccagent:folder', async event => {
    trustedGuide(event);
    const result = await dialog.showOpenDialog(guideWindow, { title: '选择 CCAGENT 工作文件夹', defaultPath: state.workspace, properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return null;
    const selected = result.filePaths[0];
    const resultState = await api('/api/workspaces/select', { path: selected });
    save({ workspace: resultState.workspace }); return resultState.workspace;
  });
  ipcMain.handle('ccagent:model', async (event, body) => {
    trustedGuide(event);
    const allowed = ['id', 'protocol', 'baseURL', 'model', 'apiKey'];
    if (!body || typeof body !== 'object' || allowed.some(key => typeof body[key] !== 'string') || allowed.some(key => body[key].length > (key === 'apiKey' ? 8192 : 4096))) throw new Error('请完整填写模型配置。');
    return api('/api/customize/models', { ...Object.fromEntries(allowed.map(key => [key, body[key]])), makeDefault: true });
  });
  ipcMain.handle('ccagent:test-model', async (event, id) => {
    trustedGuide(event); if (typeof id !== 'string' || id.length > 64) throw new Error('请选择模型。');
    return api('/api/customize/model-test', { id }, 100000);
  });
  ipcMain.handle('ccagent:official-services', async event => { trustedGuide(event); return api('/api/customize/official-services', undefined, 45000); });
  ipcMain.handle('ccagent:save-official-services', async (event, body) => {
    trustedGuide(event);
    if (!body || typeof body !== 'object' || Array.isArray(body) || (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || body.apiKey.length > 8192))) throw new Error('请填写个人平台 Key 和服务选择。');
    return api('/api/customize/official-services', Object.fromEntries(['apiKey', 'roles', 'auxiliaryEnabled', 'fallbackEnabled', 'catalogRevision', 'makeDefault'].filter(key => body[key] !== undefined).map(key => [key, body[key]])), 45000);
  });
  ipcMain.handle('ccagent:account-page', async (event, section) => {
    trustedGuide(event);
    const routes = { billing: '/account/billing', keys: '/account/keys', usage: '/account/usage' };
    if (typeof section !== 'string' || !Object.hasOwn(routes, section)) throw new Error('账户页面无效。');
    const account = await api('/api/account/status');
    const url = new URL(routes[section], account.origin).href;
    if (!externalUrl(url)) throw new Error('账户服务地址无效。');
    await shell.openExternal(url);
  });
  ipcMain.handle('ccagent:finish', async (event, view) => {
    trustedGuide(event); if (!['', 'settings'].includes(view)) throw new Error('Invalid view');
    await checkEnvironment(true);
    save(completeOnboarding(state, await api('/api/account/status')));
    await showMain(view);
    if (sameOrigin(mainWindow?.webContents.getURL(), origin)) await mainWindow.webContents.executeJavaScript("document.dispatchEvent(new CustomEvent('ccagent:models-changed'))");
    guideWindow?.close();
  });
  ipcMain.handle('ccagent:logs', async event => { trustedGuide(event); shell.showItemInFolder(logFile); });
}
async function installUpdate(fromFile = false) {
  if (updating) return;
  updating = true;
  try {
    let envelope;
    if (fromFile) {
      const selected = await dialog.showOpenDialog(mainWindow || guideWindow, { title: '选择已签名的升级或回退清单', properties: ['openFile'], filters: [{ name: '签名更新清单', extensions: ['json'] }] });
      if (selected.canceled) return;
      const content = fs.readFileSync(selected.filePaths[0], 'utf8');
      if (Buffer.byteLength(content) > 65536) throw new Error('更新清单过大。');
      envelope = JSON.parse(content);
    } else {
      const release = (await api('/api/account/releases', undefined, 15000)).release;
      if (!release?.signedUpdate) throw new Error('此版本通知没有可信签名更新清单。请等待管理员发布已签名版本；普通下载链接仍可在版本更新页面查看。');
      envelope = release.signedUpdate;
    }
    const trustedKeys = require('./release-keys.json');
    const { verifyManifest, compareVersions } = require('./update-manifest.cjs');
    const target = verifyManifest(envelope, trustedKeys), difference = compareVersions(target.version, productVersion);
    if (!difference) throw new Error('当前已安装此版本。');
    const busy = ready && (await api('/api/desktop/status')).busy;
    if (busy) throw new Error('请先停止正在执行的任务，再安装更新或回退。');
    const approved = await dialog.showMessageBox(mainWindow || guideWindow, { type: difference < 0 ? 'warning' : 'question', title: difference < 0 ? '确认回退版本' : '确认安装更新',
      message: `${difference < 0 ? '回退' : '升级'} CCAGENT ${productVersion} → ${target.version}？`,
      detail: '应用将下载并核验签名清单、文件摘要和 Windows 发布者，然后退出并安装。配置和工作文件保留。回退前请备份重要会话；数据格式不兼容时请恢复备份。',
      buttons: ['取消', difference < 0 ? '下载并回退' : '下载并安装'], defaultId: 0, cancelId: 0 });
    if (approved.response !== 1) return;
    const { prepareUpdate, launchUpdate } = require('./updates.cjs');
    const prepared = await prepareUpdate(envelope, { directory: path.join(app.getPath('userData'), 'updates'), trustedKeys, currentVersion: productVersion });
    // Tasks can start while the installer is downloading. Check again before exit.
    if (ready && (await api('/api/desktop/status')).busy) throw new Error('下载期间开始了新任务。请先停止任务，再重试安装。');
    await launchUpdate(prepared);
    save({ pendingUpdateVersion: prepared.payload.version });
    quitting = true; app.quit();
  } catch (error) {
    log('Verified update did not start.');
    await dialog.showMessageBox(mainWindow || guideWindow, { type: 'error', title: '更新未安装', message: '无法完成可信更新或回退。当前版本可继续使用。', detail: String(error.message || '更新核验失败。').slice(0, 300) });
  } finally { updating = false; }
}
function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [{ label: '开始使用向导', click: () => showGuide() }, { label: '环境检测与安装', click: () => showGuide(true) }, { label: '设置', click: () => { if (ready && state.environmentGuideVersion === environmentGuideVersion) void showMain('settings'); else showGuide(true); } }, { type: 'separator' }, { label: '退出', accelerator: 'Alt+F4', click: () => void requestExit() }] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '查看', submenu: [{ role: 'reload', label: '重新加载' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'togglefullscreen', label: '全屏' }] },
    { label: '帮助', submenu: [{ label: '使用指南', click: () => showGuide() }, { label: '环境检测与安装', click: () => showGuide(true) }, { label: '检查并安装可信更新', click: () => void installUpdate() }, { label: '从签名清单升级或回退', click: () => void installUpdate(true) }, { label: '打开已验证更新目录', click: () => { const directory = path.join(app.getPath('userData'), 'updates'); fs.mkdirSync(directory, { recursive: true }); void shell.openPath(directory); } }, { label: '打开诊断日志', click: () => shell.showItemInFolder(logFile) },
      { label: '关于 CCAGENT', click: () => void dialog.showMessageBox(mainWindow || guideWindow, { type: 'info', title: '关于 CCAGENT', message: `CCAGENT ${productVersion}`, detail: 'Windows 桌面版\n任务、模型、MCP、技能与权限均使用 CCAGENT 核心。\n源码优化后重新构建安装包即可升级。\n开源许可：MIT；第三方许可随安装文件提供。' }) }] },
  ]));
}
async function launch() {
  stateFile = path.join(app.getPath('userData'), 'desktop-state.json');
  logFile = path.join(app.getPath('userData'), 'logs', 'desktop.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2 * 1024 * 1024) fs.renameSync(logFile, logFile + '.previous');
  backendRoot = app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.resolve(__dirname, '../output/desktop/backend');
  prerequisites = createPrerequisiteManager({ backendRoot, openExternal: url => shell.openExternal(url) });
  state = readState(stateFile);
  if (state.pendingUpdateVersion) {
    const completed = state.pendingUpdateVersion === productVersion;
    save({ pendingUpdateVersion: null });
    if (!completed) await dialog.showMessageBox({ type: 'warning', title: '更新尚未完成', message: '上次更新或回退没有切换到目标版本。当前版本可继续使用。', detail: '可在帮助菜单重新选择有效签名清单恢复安装；重要配置和工作文件会保留。' });
    log(completed ? 'Verified update completed.' : 'Verified update did not change the installed version.');
  }
  const defaultWorkspace = path.join(app.getPath('documents'), 'CCAGENT 工作区');
  let workspace = process.env.CCAGENT_DESKTOP_WORKSPACE || state.workspace || defaultWorkspace;
  if (!fs.existsSync(workspace)) workspace = defaultWorkspace;
  fs.mkdirSync(workspace, { recursive: true });
  save({ workspace });
  registerIpc(); installMenu(); showGuide();
  if (!await ensureBackend()) return;
  const account = await api('/api/account/status').catch(() => null);
  if (state.environmentGuideVersion === environmentGuideVersion && (!account || onboardingFinished(state, account))) { await showMain(); guideWindow?.close(); }
}
async function ensureBackend() {
  if (ready) return true;
  if (backendStarting) return backendStarting;
  backendStarting = bootBackend().catch(async () => {
    if (!startupError) startupError = '无法启动本地服务，请重新安装或查看诊断日志。';
    log('Desktop backend startup failed.');
    const failedChild = child;
    await stopBackend(failedChild);
    if (child === failedChild) child = null;
    return false;
  }).finally(() => { backendStarting = null; });
  return backendStarting;
}
async function bootBackend() {
  const report = await prerequisites.detect();
  if (quitting) return false;
  if (!report.requiredReady) {
    startupError = '必需环境尚未就绪，请按向导修复后点击“重新检测”。';
    return false;
  }
  startupError = '';
  const port = await freePort(); origin = `http://127.0.0.1:${port}`;
  if (quitting) return false;
  child = startBackend({ backendRoot, workspace: state.workspace, port, token, log: () => {} });
  child.once('error', error => { startupError = '无法启动本地服务，请重新安装或查看诊断日志。'; log(`Backend spawn failed: ${error.code || 'UNKNOWN'}`); });
  child.once('exit', code => {
    ready = false;
    if (!quitting) { startupError = '本地服务已停止，请退出并重新打开应用。'; log(`Backend exited: ${code}`); showGuide(); }
  });
  await waitForBackend(child, origin, token);
  if (quitting) return false;
  ready = true; log(`Started version ${productVersion}`);
  return true;
}
app.on('second-instance', () => reveal(mainWindow || guideWindow));
app.on('window-all-closed', () => { if (!quitting) { quitting = true; app.quit(); } });
let stopped = false;
app.on('before-quit', event => {
  if (stopped) return;
  event.preventDefault(); quitting = true;
  if (ready && stateFile) void api('/api/workspaces').then(value => save({ workspace: value.current })).catch(() => {}).finally(shutdown);
  else void shutdown();
});
async function shutdown() { if (stopped) return; await prerequisites?.dispose(); await stopBackend(child); if (backendStarting) await backendStarting; stopped = true; app.quit(); }
if (locked) app.whenReady().then(launch).catch(error => {
  startupError = error.message; if (logFile) log('Desktop startup failed.');
  dialog.showErrorBox('CCAGENT 启动失败', error.message); showGuide();
});
