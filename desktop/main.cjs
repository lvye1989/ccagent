const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { readState, writeState, freePort, serviceRequest, startBackend, waitForBackend, stopBackend, sameOrigin, externalUrl, onboardingFinished, completeOnboarding } = require('./runtime.cjs');

app.setName('CCAGENT');
app.setAppUserModelId('pro.ccagent.desktop');
const productVersion = app.isPackaged ? app.getVersion() : readState(path.resolve(__dirname, '../package.json')).version || app.getVersion();
if (process.env.CCAGENT_DESKTOP_USER_DATA) app.setPath('userData', path.resolve(process.env.CCAGENT_DESKTOP_USER_DATA));
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
let mainWindow, guideWindow, child, origin, state, stateFile, logFile, backendRoot;
let ready = false, startupError = '', quitting = false, exitPrompt = false;
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
function showGuide() {
  if (guideWindow && !guideWindow.isDestroyed()) { reveal(guideWindow); return; }
  guideWindow = new BrowserWindow({ width: 1100, height: 790, minWidth: 980, minHeight: 730, title: 'CCAGENT · 开始使用',
    backgroundColor: '#f5f7fb', autoHideMenuBar: true, show: false, icon: path.join(__dirname, 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  configureWindow(guideWindow);
  guideWindow.on('closed', () => { guideWindow = null; });
  guideWindow.once('ready-to-show', () => guideWindow?.show());
  void guideWindow.loadURL(guideUrl).then(() => guideWindow?.show());
}
async function showMain(view = '') {
  if (!ready) throw new Error(startupError || '本地服务正在启动，请稍候。');
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (view) await mainWindow.loadURL(origin + '/?view=' + encodeURIComponent(view));
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
function checkCommand(command, args) {
  return new Promise(resolve => {
    execFile('where.exe', [command], { windowsHide: true, timeout: 2000 }, (error, stdout) => {
      if (error) return resolve(false);
      const candidate = stdout.split(/\r?\n/).find(file => file && !/\\Microsoft\\WindowsApps\\/i.test(file));
      if (!candidate) return resolve(false);
      execFile(candidate, args, { windowsHide: true, timeout: 3000 }, failed => resolve(!failed));
    });
  });
}
async function status() {
  const account = ready ? await api('/api/account/status').catch(() => null) : null;
  const models = account ? (await api('/api/customize/models')).models : [];
  const workspace = account ? (await api('/api/workspaces')).current : state.workspace;
  return { ready, authenticated: Boolean(account), email: account?.user?.email, error: startupError, version: productVersion, workspace, models,
    nodeVersion: readState(path.join(backendRoot, 'desktop-manifest.json')).nodeVersion,
    git: await checkCommand('git', ['--version']), python: await checkCommand(process.env.CCAGENT_PYTHON || 'python', ['--version']),
  };
}
function registerIpc() {
  ipcMain.handle('ccagent:login', async event => { trustedGuide(event); await showMain(); guideWindow?.close(); });
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
    return api('/api/customize/official-services', Object.fromEntries(['apiKey', 'roles', 'auxiliaryEnabled', 'makeDefault'].filter(key => body[key] !== undefined).map(key => [key, body[key]])), 45000);
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
    save(completeOnboarding(state, await api('/api/account/status')));
    await showMain(view);
    if (sameOrigin(mainWindow?.webContents.getURL(), origin)) await mainWindow.webContents.executeJavaScript("document.dispatchEvent(new CustomEvent('ccagent:models-changed'))");
    guideWindow?.close();
  });
  ipcMain.handle('ccagent:logs', async event => { trustedGuide(event); shell.showItemInFolder(logFile); });
}
function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [{ label: '开始使用向导', click: showGuide }, { label: '设置', click: () => void showMain('settings') }, { type: 'separator' }, { label: '退出', accelerator: 'Alt+F4', click: () => void requestExit() }] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '查看', submenu: [{ role: 'reload', label: '重新加载' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'togglefullscreen', label: '全屏' }] },
    { label: '帮助', submenu: [{ label: '使用指南', click: showGuide }, { label: '打开诊断日志', click: () => shell.showItemInFolder(logFile) },
      { label: '关于 CCAGENT', click: () => void dialog.showMessageBox(mainWindow || guideWindow, { type: 'info', title: '关于 CCAGENT', message: `CCAGENT ${productVersion}`, detail: 'Windows 桌面版\n任务、模型、MCP、技能与权限均使用 CCAGENT 核心。\n源码优化后重新构建安装包即可升级。\n开源许可：MIT；第三方许可随安装文件提供。' }) }] },
  ]));
}
async function launch() {
  stateFile = path.join(app.getPath('userData'), 'desktop-state.json');
  logFile = path.join(app.getPath('userData'), 'logs', 'desktop.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2 * 1024 * 1024) fs.renameSync(logFile, logFile + '.previous');
  backendRoot = app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.resolve(__dirname, '../output/desktop/backend');
  state = readState(stateFile);
  const defaultWorkspace = path.join(app.getPath('documents'), 'CCAGENT 工作区');
  let workspace = process.env.CCAGENT_DESKTOP_WORKSPACE || state.workspace || defaultWorkspace;
  if (!fs.existsSync(workspace)) workspace = defaultWorkspace;
  fs.mkdirSync(workspace, { recursive: true });
  save({ workspace });
  registerIpc(); installMenu(); showGuide();
  const port = await freePort(); origin = `http://127.0.0.1:${port}`;
  child = startBackend({ backendRoot, workspace, port, token, log: () => {} });
  child.once('error', error => { startupError = '无法启动本地服务，请重新安装或查看诊断日志。'; log(`Backend spawn failed: ${error.code || 'UNKNOWN'}`); });
  child.once('exit', code => {
    ready = false;
    if (!quitting) { startupError = '本地服务已停止，请退出并重新打开应用。'; log(`Backend exited: ${code}`); showGuide(); }
  });
  await waitForBackend(child, origin, token);
  ready = true; log(`Started version ${productVersion}`);
  const account = await api('/api/account/status').catch(() => null);
  if (!account || onboardingFinished(state, account)) { await showMain(); guideWindow?.close(); }
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
async function shutdown() { if (stopped) return; await stopBackend(child); stopped = true; app.quit(); }
if (locked) app.whenReady().then(launch).catch(error => {
  startupError = error.message; if (logFile) log('Desktop startup failed.');
  dialog.showErrorBox('CCAGENT 启动失败', error.message); showGuide();
});
