const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');

const win = path.win32;
const definitions = Object.freeze([
  { id: 'windows', name: 'Windows 系统', description: 'Windows 10 / Server 2016 或更高版本，建议使用 Windows 11。', optional: false, bundled: false },
  { id: 'architecture', name: '处理器架构', description: '当前安装包适用于 Windows x64。', optional: false, bundled: false },
  { id: 'powershell', name: 'Windows PowerShell', description: '账户加密保存、文件夹选择与 Windows 工具使用系统 PowerShell。', optional: false, bundled: false },
  { id: 'bundled-node', name: '内置 Node.js', description: '应用随安装包提供 Node.js，无需安装全局 Node.js。', optional: false, bundled: true },
  { id: 'bundled-npm', name: '内置 npm / npx', description: '随内置 Node.js 提供，用于按需启动 Node MCP 与插件。', optional: false, bundled: true },
  { id: 'git-bash', name: 'Git Bash（推荐）', description: 'Bash 命令、部分钩子及开发工作流按需使用；Windows 常规命令可使用 PowerShell。', optional: true, bundled: false },
  { id: 'python', name: 'Python 3.10+', description: 'Python 脚本和部分文档、MCP 工具按需使用；基础检测要求 3.10+，具体扩展可能另有版本要求。', optional: true, bundled: false },
  { id: 'libreoffice', name: 'LibreOffice', description: '部分 Office / PDF 文档转换按需使用。', optional: true, bundled: false },
]);
const officialPages = Object.freeze({
  windows: 'https://www.microsoft.com/software-download/windows11',
  architecture: 'https://www.microsoft.com/windows/windows-11-specifications',
  powershell: 'https://learn.microsoft.com/powershell/scripting/windows-powershell/install/windows-powershell-system-requirements',
  'git-bash': 'https://git-scm.com/install/windows',
  python: 'https://www.python.org/downloads/windows/',
  libreoffice: 'https://www.libreoffice.org/download/download-libreoffice/',
  winget: 'https://learn.microsoft.com/windows/package-manager/winget/',
});
// No renderer-supplied package IDs, executable paths, flags, repositories or URLs.
const installPackages = Object.freeze({ 'git-bash': 'Git.Git', python: 'Python.Python.3.14' });
const positive = (value, fallback, maximum) => Number.isInteger(value) && value > 0 && value <= maximum ? value : fallback;
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function checkedId(id) {
  if (typeof id !== 'string' || !definitions.some(item => item.id === id)) throw failure('INVALID_PREREQUISITE', '组件编号无效。');
  return id;
}
function version(text) {
  const match = String(text).trim().match(/^(?:v|Python\s+)?(\d+\.\d+(?:\.\d+)?)(?:[\w.+()-]*)?(?:\s|$)/i);
  return match ? match[1] : null;
}
function cleanEnvironment(source, runtime) {
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH',
    'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'TEMP', 'TMP', 'PUBLIC', 'ALLUSERSPROFILE',
    'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'NUMBER_OF_PROCESSORS', 'OS']);
  const result = Object.fromEntries(Object.entries(source).filter(([name, value]) => allowed.has(name.toUpperCase()) && typeof value === 'string'));
  result.PATH = runtime + ';' + (source.PATH || source.Path || '');
  result.NODE_TLS_REJECT_UNAUTHORIZED = '1'; result.NODE_USE_SYSTEM_CA = '1';
  result.npm_config_update_notifier = 'false'; result.npm_config_audit = 'false';
  return result;
}
function executable(value) { return typeof value === 'string' && win.isAbsolute(value) && !/[\r\n\0"<>|]/.test(value) && /\.(?:exe|com)$/i.test(value); }
function storeAlias(value) { return /[/\\]Microsoft[/\\]WindowsApps[/\\]/i.test(value); }
function wslLauncher(value) { return /[/\\]Windows[/\\](?:System32|Sysnative)[/\\]bash\.exe$/i.test(value) || /(?:^|[/\\])wsl\.exe$/i.test(value); }

/** No shell or elevation. Cancellation only terminates the child process tree created here. */
function nativeRunner(file, args, settings) {
  return new Promise(resolve => {
    let child, stopping = false, termination = Promise.resolve(), stdout = '', stderr = '', finished = false;
    const finish = async error => {
      if (finished) return; finished = true;
      settings.signal.removeEventListener('abort', stop);
      await termination.catch(() => {});
      resolve({ ok: !error && !stopping, stdout: String(stdout), stderr: String(stderr), exitCode: error?.code ?? 0 });
    };
    const stop = () => {
      if (!child || stopping) return; stopping = true;
      if (child.exitCode !== null && child.exitCode !== undefined) return;
      if (process.platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
        termination = new Promise(done => execFile(win.join(settings.systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, timeout: 3000, env: settings.env }, () => { try { child.kill(); } catch {} done(); }));
      } else { try { child.kill(); } catch {} }
    };
    if (settings.signal.aborted) return resolve({ ok: false, stdout: '', stderr: '', exitCode: null });
    try {
      child = spawn(file, args, { cwd: settings.cwd, env: settings.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      // Installer progress can be large. Bound captured text without killing a
      // parent process and accidentally leaving its installer descendants alive.
      child.stdout.on('data', chunk => { if (stdout.length < 65536) stdout = (stdout + chunk.toString()).slice(0, 65536); });
      child.stderr.on('data', chunk => { if (stderr.length < 65536) stderr = (stderr + chunk.toString()).slice(0, 65536); });
      child.once('error', () => { void finish(true); });
      child.once('close', code => { void finish(code === 0 ? null : { code }); });
      settings.signal.addEventListener('abort', stop, { once: true });
      if (settings.signal.aborted) stop();
    } catch { void finish(true); }
  });
}

/**
 * Main-process service. Only fixed component IDs cross IPC. `run`/`fileSystem`
 * are dependency injection seams for tests and are never renderer inputs.
 */
function createPrerequisiteManager(options = {}) {
  if (!options.backendRoot || typeof options.backendRoot !== 'string') throw failure('INVALID_BACKEND_ROOT', '缺少内置运行环境位置。');
  const platform = options.platform || process.platform;
  const machine = String(options.machine || os.machine()).toLowerCase();
  const arch = options.arch || (/arm64|aarch64/.test(machine) ? 'arm64' : process.arch);
  const release = options.release || os.release(), environment = { ...(options.env || process.env) };
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows';
  const backendRoot = win.resolve(options.backendRoot), runtime = win.join(backendRoot, 'runtime'), node = win.join(runtime, 'node.exe');
  const fileSystem = options.fileSystem || fs, runner = options.run || nativeRunner;
  const probeTimeout = positive(options.probeTimeoutMs, 3500, 15000), installTimeout = positive(options.installTimeoutMs, 10 * 60_000, 30 * 60_000);
  const stopGrace = positive(options.stopGraceMs, 4500, 10000);
  const minimumWindowsBuild = Number.isInteger(options.minimumWindowsBuild) && options.minimumWindowsBuild >= 0 ? options.minimumWindowsBuild : 0;
  const env = cleanEnvironment(environment, runtime), rootController = new AbortController();
  const timers = { setTimeout: options.setTimeout || setTimeout, clearTimeout: options.clearTimeout || clearTimeout };
  let disposed = false, detection = null, installWork = null, cleanupWork = null, installController = null, wingetPath = null;
  let report = { schemaVersion: 1, checkedAt: null, requiredReady: false, canContinue: false,
    components: definitions.map(item => ({ ...item, status: 'missing', message: '等待检测。', canInstall: false, canOpenOfficial: Object.hasOwn(officialPages, item.id) })),
    installer: { available: false, message: '等待检测 Windows 软件包安装器。', canOpenOfficial: true, officialId: 'winget' } };
  let job = { running: false, currentId: null, stage: 'idle', message: '', cancelled: false, results: [] };
  function getState() {
    const state = structuredClone({ ...report, job });
    state.canContinue = state.requiredReady && !job.running;
    for (const item of state.components) {
      if (job.running && item.id === job.currentId) { item.status = 'installing'; item.message = job.message; item.canInstall = false; }
      else if (item.status !== 'ready') {
        const previous = job.results.find(result => result.id === item.id);
        if (previous) { item.message = previous.message; if (previous.status === 'failed' || previous.status === 'manual') item.status = previous.status; }
      }
    }
    return state;
  }
  async function exists(file) {
    if (!executable(file)) return false;
    try { const stat = await fileSystem.stat(file); return stat.isFile(); } catch { return false; }
  }
  async function run(file, args, signal, timeoutMs = probeTimeout) {
    if (disposed || signal?.aborted || rootController.signal.aborted) return { ok: false, reason: 'cancelled', stdout: '', stderr: '' };
    const controller = new AbortController();
    let reason = null;
    const abort = () => { reason = 'cancelled'; controller.abort(); };
    signal?.addEventListener('abort', abort, { once: true }); rootController.signal.addEventListener('abort', abort, { once: true });
    let timer;
    try {
      const stopped = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve({ ok: false, reason, stdout: '', stderr: '' }), { once: true }));
      timer = timers.setTimeout(() => { reason = 'timeout'; controller.abort(); }, timeoutMs);
      const work = Promise.resolve().then(() => runner(file, [...args], { signal: controller.signal, env: { ...env },
        cwd: systemRoot, systemRoot, timeoutMs, windowsHide: true, shell: false })).catch(() => ({ ok: false, stdout: '', stderr: '' }));
      const outcome = await Promise.race([work, stopped]);
      if (!controller.signal.aborted) return outcome;
      const cleanup = await settleWithin(work, stopGrace);
      return { ok: false, reason, stdout: '', stderr: '', cleanupPending: !cleanup.settled, ...(cleanup.settled ? {} : { cleanup: work }) };
    } finally { timers.clearTimeout(timer); signal?.removeEventListener('abort', abort); rootController.signal.removeEventListener('abort', abort); }
  }
  async function settleWithin(work, milliseconds) {
    let timer;
    try { return await Promise.race([Promise.resolve(work).then(value => ({ settled: true, value }), () => ({ settled: true })),
      new Promise(resolve => { timer = timers.setTimeout(() => resolve({ settled: false }), milliseconds); })]); }
    finally { if (timer) timers.clearTimeout(timer); }
  }
  function paths(command, { aliases = false } = {}) {
    if (executable(command)) return aliases || !storeAlias(command) ? [win.normalize(command)] : [];
    if (/^[a-z0-9_-]+$/i.test(command)) command += '.exe';
    if (!/^[a-z0-9_-]+\.exe$/i.test(command)) return [];
    return [...new Set((environment.PATH || environment.Path || '').split(';').filter(directory => win.isAbsolute(directory) && !/[\r\n\0"<>|]/.test(directory)).slice(0, 64)
      .map(directory => win.join(directory, command)).filter(file => aliases || !storeAlias(file)))];
  }
  async function probe(candidates, args, match, signal) {
    for (const file of [...new Set(candidates)].slice(0, 24)) {
      if (disposed || signal?.aborted) return null;
      if (!await exists(file)) continue;
      const result = await run(file, args, signal);
      if (result.reason === 'cancelled') return null;
      if (result.ok) { const output = (result.stdout + '\n' + result.stderr).trim(), found = match(output); if (found) return { file, version: found }; }
    }
    return null;
  }
  async function pythonDirectories() {
    if (!environment.LOCALAPPDATA) return [];
    const folder = win.join(environment.LOCALAPPDATA, 'Programs', 'Python');
    try { return (await fileSystem.readdir(folder)).filter(name => /^Python3\d{1,2}$/i.test(name)).sort().reverse().map(name => win.join(folder, name, 'python.exe')); }
    catch { return []; }
  }
  async function performDetection(signal) {
    const found = new Map(), set = (id, status, message, extra = {}) => found.set(id, { status, message, ...extra });
    const parts = release.split('.').map(Number), windowsReady = platform === 'win32' && parts[0] >= 10 && (parts[0] > 10 || (parts[2] || 0) >= minimumWindowsBuild);
    set('windows', windowsReady ? 'ready' : 'unsupported', windowsReady ? '系统满足运行要求。' : '需要 Windows 10 / Server 2016 或更高版本。', { version: /^[0-9.]{1,30}$/.test(release) ? release : undefined });
    set('architecture', platform === 'win32' && arch === 'x64' ? 'ready' : 'unsupported', arch === 'x64' ? '使用 x64 安装包。' : '当前安装包只支持 x64；ARM64 未作为原生支持平台验证。', { version: ['x64', 'arm64', 'ia32'].includes(arch) ? arch : 'unknown' });
    if (platform === 'win32') {
      const powershell = await probe([win.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Console]::Write($PSVersionTable.PSVersion.ToString())'],
        output => { const value = version(output); return value && Number(value.split('.')[0]) >= 5 ? value : null; }, signal);
      set('powershell', powershell ? 'ready' : 'missing', powershell ? '系统 Windows PowerShell 可用。' : '系统 PowerShell 不可用，请通过 Windows 官方说明修复系统组件。', { version: powershell?.version });
      const bundled = await probe([node], ['-p', 'JSON.stringify({version:process.versions.node,arch:process.arch,platform:process.platform})'], output => {
        try { const value = JSON.parse(output); return typeof value.version === 'string' && /^\d+\.\d+\.\d+$/.test(value.version) && Number(value.version.split('.')[0]) >= 22 && value.platform === 'win32' && value.arch === 'x64' ? value.version : null; } catch { return null; }
      }, signal);
      let manifestVersion = null;
      try { const value = JSON.parse(await fileSystem.readFile(win.join(backendRoot, 'desktop-manifest.json'), 'utf8')); if (typeof value.nodeVersion === 'string') manifestVersion = value.nodeVersion; } catch {}
      const nodeReady = !!bundled && (!manifestVersion || manifestVersion === bundled.version);
      set('bundled-node', nodeReady ? 'ready' : 'failed', nodeReady ? '使用客户端内置运行环境，无需全局 Node.js。' : '内置 Node.js 缺失、版本不符或无法运行，请修复或重新安装 CCAGENT。', { version: bundled?.version });
      const npm = nodeReady ? await probe([node], [win.join(runtime, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '--version'], version, signal) : null;
      const npx = nodeReady ? await probe([node], [win.join(runtime, 'node_modules', 'npm', 'bin', 'npx-cli.js'), '--version'], version, signal) : null;
      set('bundled-npm', npm && npx ? 'ready' : 'failed', npm && npx ? '内置 npm 与 npx 可用，MCP 按需使用此运行环境。' : '内置 npm / npx 不完整，请修复或重新安装 CCAGENT；安装全局 Node.js 不能修复此客户端。', { version: npm?.version });
      const configuredBash = environment.CCAGENT_BASH?.trim();
      const configuredShell = environment.SHELL?.trim();
      const shellOverride = !configuredBash && configuredShell && !configuredShell.startsWith('/') && configuredShell.toLowerCase() !== 'bash' && !wslLauncher(configuredShell) ? configuredShell : null;
      const bashCandidates = configuredBash || shellOverride ? paths(configuredBash || shellOverride) : [
        win.join(environment.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
        ...(environment['ProgramFiles(x86)'] ? [win.join(environment['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe')] : []),
        ...(environment.LOCALAPPDATA ? [win.join(environment.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')] : []), ...paths('bash.exe'),
      ];
      const bash = await probe(bashCandidates.filter(file => !wslLauncher(file)), ['--noprofile', '--norc', '--version'], output => output.match(/^GNU bash, version (\d+\.\d+(?:\.\d+)?)/)?.[1] || null, signal);
      set('git-bash', bash ? 'ready' : 'missing', bash ? '已检测到可运行的 GNU Bash。' : configuredBash || shellOverride ? '自定义 Bash / SHELL 配置不可用，请核对该设置；PowerShell 功能仍可使用。' : '未检测到 Git Bash；可先进入应用，按需安装后启用 Bash 工作流。', { version: bash?.version, customConfiguration: !!(configuredBash || shellOverride) });
      const configuredPython = environment.CCAGENT_PYTHON?.trim();
      const pythonCandidates = configuredPython ? paths(configuredPython) : [...paths('python.exe'), ...await pythonDirectories(), ...paths('python3.exe')];
      const pythonVersion = output => { const value = /^Python 3\./.test(output) ? version(output) : null; return value && Number(value.split('.')[1]) >= 10 ? value : null; };
      let python = await probe(pythonCandidates, ['--version'], pythonVersion, signal);
      if (!python && !configuredPython) python = await probe([
        ...paths('py.exe'), ...(environment.LOCALAPPDATA ? [win.join(environment.LOCALAPPDATA, 'Programs', 'Python', 'Launcher', 'py.exe')] : []), win.join(systemRoot, 'py.exe'),
      ], ['-3', '--version'], pythonVersion, signal);
      set('python', python ? 'ready' : 'missing', python ? 'Python 3.10+ 可用，附加库按具体工具需要配置。' : configuredPython ? '自定义 Python 路径不可用或版本低于 3.10，请核对 CCAGENT_PYTHON 设置。' : '未检测到 Python 3.10+；普通对话和主界面可直接使用。', { version: python?.version, customConfiguration: !!configuredPython });
      const office = [
        ...(environment.CCAGENT_LIBREOFFICE ? paths(environment.CCAGENT_LIBREOFFICE.trim()) : []),
        win.join(environment.ProgramFiles || 'C:\\Program Files', 'LibreOffice', 'program', 'soffice.exe'),
        win.join(environment['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'LibreOffice', 'program', 'soffice.exe'), ...paths('soffice.exe'),
      ];
      let officeFound = false;
      for (const file of office) if (await exists(file)) { officeFound = true; break; }
      set('libreoffice', officeFound ? 'ready' : 'missing', officeFound ? '已找到文档转换程序；具体格式按实际安装组件支持。' : '文档转换按需安装；使用官方安装向导确认许可和安装范围。');
      const build = parts[0] > 10 || (parts[2] || 0) >= 17763;
      const winget = windowsReady && build ? await probe([
        ...(environment.LOCALAPPDATA ? [win.join(environment.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'winget.exe')] : []), ...paths('winget.exe', { aliases: true }),
      ], ['--version'], version, signal) : null;
      wingetPath = winget?.file || null;
      report.installer = { available: !!winget, version: winget?.version, message: winget ? '可按用户选择使用 Windows 软件包源安装；不会自动接受许可或提升权限。' : '未检测到可用 WinGet，可打开官方说明或各组件官网下载。', canOpenOfficial: true, officialId: 'winget' };
    } else {
      for (const item of definitions.filter(item => !found.has(item.id))) set(item.id, 'unsupported', '此检测适用于 Windows x64 客户端。');
      wingetPath = null; report.installer = { available: false, message: '此安装引导仅适用于 Windows。', canOpenOfficial: true, officialId: 'winget' };
    }
    if (signal?.aborted || disposed) throw failure('PREREQUISITE_CANCELLED', '检测已取消。');
    const components = definitions.map(item => {
      const value = found.get(item.id);
      return { ...item, ...value, canInstall: windowsReady && arch === 'x64' && !!wingetPath && Object.hasOwn(installPackages, item.id) && value.status !== 'ready' && !value.customConfiguration,
        canOpenOfficial: Object.hasOwn(officialPages, item.id) };
    });
    const requiredReady = components.every(item => item.optional || item.status === 'ready');
    report = { ...report, checkedAt: new Date().toISOString(), components, requiredReady, canContinue: requiredReady };
    return getState();
  }
  function detect({ signal } = {}) {
    if (disposed) return Promise.reject(failure('PREREQUISITE_DISPOSED', '环境检测服务已关闭。'));
    if (!detection) detection = performDetection(signal).finally(() => { detection = null; });
    return detection;
  }
  async function performInstall(id, controller) {
    let outcome = { id, status: 'failed', message: '安装未完成，请打开官方页面手动核对。' };
    try {
      await detect({ signal: controller.signal });
      const item = report.components.find(value => value.id === id);
      if (controller.signal.aborted) outcome = { id, status: 'cancelled', message: '安装已取消；已经安装的内容不会自动卸载。' };
      else if (item.status === 'ready') outcome = { id, status: 'ready', message: '组件已可用，无需重复安装。' };
      else if (!item.canInstall || !wingetPath) outcome = { id, status: 'manual', message: '请打开组件官方页面，使用官方向导确认许可与安装范围；完成后重新检测。' };
      else {
        const source = await run(wingetPath, ['source', 'export', 'winget', '--disable-interactivity'], controller.signal);
        let trustedSource = false;
        try { const value = JSON.parse(source.stdout); trustedSource = source.ok && value.Name === 'winget'
          && value.Arg === 'https://cdn.winget.microsoft.com/cache' && value.Type === 'Microsoft.PreIndexed.Package'
          && value.Identifier === 'Microsoft.Winget.Source_8wekyb3d8bbwe'; } catch {}
        if (!trustedSource) outcome = { id, status: controller.signal.aborted ? 'cancelled' : 'manual', message: '无法确认微软默认软件包源，未执行安装。请打开官方页面继续。' };
        else {
          job = { ...job, stage: 'installing', message: '正在启动官方安装向导，请在安装器中确认许可与用户级安装；也可取消。' };
          const installed = await run(wingetPath, ['install', '--id', installPackages[id], '--exact', '--source', 'winget', '--scope', 'user',
            '--interactive', '--disable-interactivity', '--skip-dependencies', '--no-upgrade'], controller.signal, installTimeout);
          if (installed.cleanupPending) {
            job = { ...job, stage: 'cancelling', cancelled: controller.signal.aborted, cleanupPending: true, message: '安装进程尚未确认退出，正在等待清理；暂不能开始另一项安装。' };
            cleanupWork = Promise.resolve(installed.cleanup).then(() => finishInstall(id, controller, {
              id, status: controller.signal.aborted ? 'cancelled' : 'failed', message: controller.signal.aborted ? '安装进程已退出，已取消本次安装。' : '安装等待超时，进程已退出，请重新核对安装状态。',
            })).finally(() => { cleanupWork = null; });
            return getState();
          }
          outcome = installed.reason === 'cancelled' ? { id, status: 'cancelled', message: '安装已取消；已经安装的内容不会自动卸载。' }
            : installed.reason === 'timeout' ? { id, status: 'failed', message: '安装等待超时，已停止本次安装进程；请核对安装状态或使用官方页面。' }
            : { id, status: installed.ok ? 'manual' : 'failed', message: installed.ok ? '安装器已结束，正在重新检测。' : '安装未完成。可能需要许可确认或该组件不支持用户级安装，请通过官方向导继续。' };
        }
      }
    } catch { outcome = { id, status: controller.signal.aborted ? 'cancelled' : 'failed', message: controller.signal.aborted ? '安装已取消。' : '环境检测或安装未完成，请重新检测或打开官方页面。' }; }
    return finishInstall(id, controller, outcome);
  }
  async function finishInstall(id, controller, outcome) {
    if (!disposed) {
      job = { ...job, stage: 'verifying', message: '正在重新检测实际安装状态…' };
      try { if (detection) await detection.catch(() => {}); await detect(); } catch {}
      if (report.components.find(item => item.id === id)?.status === 'ready') outcome = { id, status: 'ready', message: '重新检测通过。请退出并从桌面快捷方式重新打开 CCAGENT，使新环境在工具中生效；具体文档或 MCP 功能仍需按需配置。' };
    }
    job = { ...job, running: false, stage: 'finished', cleanupPending: false, message: outcome.message, cancelled: controller.signal.aborted,
      results: [...job.results.filter(item => item.id !== id), outcome] };
    installController = null;
    return getState();
  }
  function startInstall(id) {
    checkedId(id);
    if (!Object.hasOwn(installPackages, id)) throw failure('MANUAL_INSTALL_ONLY', '此组件请使用官方说明或修复客户端，不支持自动安装。');
    if (disposed) throw failure('PREREQUISITE_DISPOSED', '环境检测服务已关闭。');
    if (job.running) throw failure('INSTALL_ALREADY_RUNNING', '已有组件正在安装，请等待完成或先取消。');
    const controller = new AbortController(); installController = controller;
    job = { running: true, currentId: id, stage: 'checking', message: '正在检查所选组件与安装器…', cancelled: false, results: job.results.filter(item => item.id !== id) };
    installWork = performInstall(id, controller).finally(() => { installWork = null; });
    return getState();
  }
  function cancelInstall() { if (installController) { job = { ...job, stage: 'cancelling', message: '正在取消本次安装并核对状态…' }; installController.abort(); } return getState(); }
  async function openOfficial(id) {
    if (typeof id !== 'string' || !Object.hasOwn(officialPages, id)) throw failure('INVALID_PREREQUISITE', '官方安装说明编号无效。');
    if (typeof options.openExternal !== 'function') throw failure('OFFICIAL_PAGE_UNAVAILABLE', '无法打开官方页面，请通过系统浏览器访问官方说明。');
    await options.openExternal(officialPages[id]);
    return { opened: true };
  }
  async function dispose() { disposed = true; rootController.abort(); installController?.abort(); await settleWithin(Promise.allSettled([detection, installWork, cleanupWork].filter(Boolean)), stopGrace + 100); return getState(); }
  return Object.freeze({ detect, getState, startInstall, cancelInstall, openOfficial, dispose, waitForIdle: async () => { if (installWork) await installWork; if (cleanupWork) await settleWithin(cleanupWork, stopGrace); return getState(); } });
}

module.exports = { createPrerequisiteManager };
