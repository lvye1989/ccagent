import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build, Platform, Arch } from 'electron-builder';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output', 'desktop');
const stage = path.join(output, 'app'), backend = path.join(output, 'backend'), cache = path.join(output, 'cache'), assets = path.join(output, 'assets');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const nodeVersion = '24.22.2';
const nodeSha256 = 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2';
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This release script builds Windows x64 on Windows x64.');
// Never accept a development-shell TLS bypass in downloaded release assets.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
process.env.NODE_USE_SYSTEM_CA = '1';
delete process.env.CSC_LINK; // An unsigned local build never borrows unrelated signing identities.
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
await fs.mkdir(cache, { recursive: true });
async function resetStage(target) {
  const resolved = path.resolve(target);
  if (![stage, backend].map(p => path.resolve(p)).includes(resolved) || path.dirname(resolved) !== path.resolve(output)) throw new Error('Unsafe staging path');
  await fs.rm(resolved, { recursive: true, force: true });
  await fs.mkdir(resolved, { recursive: true });
}
async function copy(relative, destination = backend) {
  const target = path.resolve(destination, relative);
  if (!target.startsWith(path.resolve(destination) + path.sep)) throw new Error('Invalid release file');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(path.join(root, relative), target);
}
const archiveName = `node-v${nodeVersion}-win-x64.zip`, archive = path.join(cache, archiveName);
const hashFile = async filename => createHash('sha256').update(await fs.readFile(filename)).digest('hex');
if (await hashFile(archive).catch(() => '') !== nodeSha256) {
  console.log(`Downloading verified Node.js ${nodeVersion} runtime from nodejs.org…`);
  const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${archiveName}`, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Node runtime download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== nodeSha256) throw new Error('Node runtime checksum mismatch');
  await fs.writeFile(archive, bytes);
}
const nodeFolder = path.join(cache, `node-v${nodeVersion}-win-x64`);
if (!await fs.stat(path.join(nodeFolder, 'node.exe')).catch(() => null)) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '& { param($archivePath,$destinationPath) Expand-Archive -LiteralPath $archivePath -DestinationPath $destinationPath -Force }', archive, cache], { windowsHide: true, stdio: 'inherit' });
}
await resetStage(stage); await resetStage(backend);
// Use the npm package's explicit resource list, never recursively copy the repo.
const payload = ['dist/ccagent.js', 'dist/charts.js', ...pkg.files.filter(name => name.startsWith('web/') || name.startsWith('rhino/')), 'LICENSE', '.env.example'];
for (const relative of payload) await copy(relative);
await fs.cp(nodeFolder, path.join(backend, 'runtime'), { recursive: true, filter: source => !['install_tools.bat', 'node_etw_provider.man'].includes(path.basename(source)) });
const runtimeVersion = execFileSync(path.join(backend, 'runtime', 'node.exe'), ['--version'], { windowsHide: true, encoding: 'utf8' }).trim();
if (runtimeVersion !== 'v' + nodeVersion) throw new Error('Unexpected bundled runtime');
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'desktop-assets.ps1'), '-Destination', assets], { windowsHide: true, stdio: 'inherit' });
await fs.mkdir(path.join(stage, 'desktop'), { recursive: true });
for (const filename of ['main.cjs', 'runtime.cjs', 'preload.cjs', 'welcome.html', 'welcome.css', 'welcome.js']) await copy('desktop/' + filename, stage);
await fs.copyFile(path.join(assets, 'icon.ico'), path.join(stage, 'desktop', 'icon.ico'));
await copy('LICENSE', stage);
await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: 'ccagent-desktop', version: pkg.version, private: true, description: 'CCAGENT AI 桌面工作区', author: 'CCAGENT', license: 'MIT', main: 'desktop/main.cjs' }, null, 2));
const license = 'CCAGENT Windows 桌面版\r\n\r\n本应用按 MIT 许可证提供，许可证全文见下方。\r\n\r\n使用准备：\r\n1. 安装后选择工作文件夹，在首次使用向导或设置中添加模型。\r\n2. 使用你自己的模型服务配置；网络模型调用可能由服务商计费。\r\n3. 部分脚本、MCP 与专业软件工具需要额外运行环境。\r\n4. 升级和卸载保留用户配置与工作文件；删除配置请另行手动处理。\r\n5. 工具按应用权限规则执行，开始任务前请确认工作范围。\r\n\r\n' + await fs.readFile(path.join(root, 'LICENSE'), 'utf8');
await fs.writeFile(path.join(assets, 'license.txt'), '\ufeff' + license, 'utf8');
// Include notices for all installed build/runtime dependencies. This intentionally
// over-includes notices rather than omit a bundled transitive dependency license.
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const notices = [];
for (const relative of Object.keys(lock.packages)) {
  if (!relative.startsWith('node_modules/')) continue;
  const dir = path.join(root, relative);
  const info = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8').catch(() => '{}'));
  const files = (await fs.readdir(dir).catch(() => [])).filter(name => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
  for (const name of files) {
    const text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '');
    if (text) notices.push(`\n===== ${info.name || relative} ${info.version || ''} / ${name} =====\n${text}`);
  }
}
await fs.writeFile(path.join(backend, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n'));
const manifest = { version: pkg.version, nodeVersion, nodeArchiveSha256: nodeSha256, builtAt: new Date().toISOString(), payload: [] };
for (const relative of payload) manifest.payload.push({ path: relative, sha256: await hashFile(path.join(backend, relative)) });
await fs.writeFile(path.join(backend, 'desktop-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Prepared desktop payload: ${payload.length} application files, Node.js ${nodeVersion}, credentials/configuration excluded.`);
if (process.argv.includes('--prepare-only')) process.exit(0);
const artifacts = await build({ projectDir: stage, targets: Platform.WINDOWS.createTarget(process.argv.includes('--dir') ? ['dir'] : ['nsis'], Arch.x64), config: {
  appId: 'pro.ccagent.desktop', productName: 'CCAGENT', copyright: 'CCAGENT contributors · MIT',
  directories: { output: path.join(output, 'release'), buildResources: assets },
  asar: true, npmRebuild: false, compression: 'normal', electronVersion: pkg.devDependencies.electron,
  electronFuses: { runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true },
  files: ['package.json', 'desktop/**', 'LICENSE'],
  extraResources: [{ from: backend, to: 'backend', filter: ['**/*'] }],
  electronLanguages: ['en-US', 'zh-CN'],
  win: { icon: path.join(assets, 'icon.ico'), executableName: 'CCAGENT', target: ['nsis'], requestedExecutionLevel: 'asInvoker', signAndEditExecutable: true, artifactName: 'CCAGENT-Setup-${version}-${arch}.${ext}' },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true, allowElevation: true, perMachine: false, selectPerMachineByDefault: false,
    installerLanguages: ['zh_CN', 'en_US'], language: '2052', displayLanguageSelector: false,
    createDesktopShortcut: 'always', createStartMenuShortcut: true, shortcutName: 'CCAGENT', runAfterFinish: true, deleteAppDataOnUninstall: false,
    include: path.join(root, 'desktop', 'installer.nsh'), license: path.join(assets, 'license.txt'),
    installerSidebar: path.join(assets, 'sidebar.bmp'), uninstallerSidebar: path.join(assets, 'sidebar.bmp'), installerHeader: path.join(assets, 'header.bmp'),
    uninstallDisplayName: 'CCAGENT ${version}', packElevateHelper: true,
  },
  publish: null,
} });
console.log('Desktop build completed:', artifacts);
if (process.argv.includes('--copy-desktop')) {
  const desktop = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('Desktop')"], { windowsHide: true, encoding: 'utf8' }).trim();
  const installer = artifacts.find(file => file.endsWith('.exe') && path.basename(file).startsWith('CCAGENT-Setup-'));
  if (!installer) throw new Error('Installer artifact not found');
  const target = path.join(desktop, path.basename(installer));
  await fs.copyFile(installer, target);
  const hash = await hashFile(target);
  await fs.writeFile(target + '.sha256', `${hash}  ${path.basename(target)}\n`);
  console.log(`Installer copied to desktop: ${target}\nSHA256: ${hash}`);
}
