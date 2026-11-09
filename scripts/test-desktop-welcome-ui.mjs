/** Offline first-run guide DOM checks. Installation and account operations are synthetic bridge calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { Window } from 'happy-dom';

const html = await fs.readFile(new URL('../desktop/welcome.html', import.meta.url), 'utf8');
const source = await fs.readFile(new URL('../desktop/welcome.js', import.meta.url), 'utf8');
const required = ['windows', 'architecture', 'powershell', 'bundled-node', 'bundled-npm'];
const names = { windows: 'Windows', architecture: 'x64 架构', powershell: 'PowerShell', 'bundled-node': '内置 Node.js', 'bundled-npm': '内置 npm / npx', 'git-bash': 'Git Bash', python: 'Python', libreoffice: 'LibreOffice' };
function report() {
  return { schemaVersion: 1, checkedAt: '2026-11-09T00:00:00Z', requiredReady: true, canContinue: true,
    components: [...required, 'git-bash', 'python', 'libreoffice'].map(id => ({ id, name: names[id], description: `用途说明 ${id}`, optional: !required.includes(id), bundled: id.startsWith('bundled-'),
      status: required.includes(id) ? 'ready' : 'missing', version: id === 'bundled-node' ? '24.22.2' : '', message: required.includes(id) ? '检查通过' : '按需安装', canInstall: ['git-bash', 'python'].includes(id), canOpenOfficial: true })),
    installer: { available: true, canOpenOfficial: true, officialId: 'winget' }, job: { running: false, results: [], message: '' } };
}
async function fixture({ authenticated = false, reviewed = false, initialReport = report(), failDetect = false, readyInitially = true } = {}) {
  const window = new Window({ url: 'file:///fixture/welcome.html', settings: { disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false, enableCSSFileLoading: false, enableImageFileLoading: false } });
  window.document.write(html);
  let state = structuredClone(initialReport), shouldFail = failDetect, deferredInstall, timerId = 0, backendReady = readyInitially;
  const timers = new Map(), calls = [];
  const bridge = {
    status: async () => ({ ready: backendReady, authenticated, environmentReviewed: reviewed, error: backendReady ? '' : '本地服务尚未就绪。', version: '0.1.3', workspace: 'C:\\fixture', email: authenticated ? 'fixture@example.invalid' : '', models: [], nodeVersion: '24.22.2' }),
    prerequisites: async options => { calls.push(['detect', options.refresh]); if (shouldFail) throw new Error('fixture-detection-failed'); return structuredClone(state); },
    installPrerequisite: async id => {
      calls.push(['install', id]); assert(['git-bash', 'python'].includes(id));
      const begin = () => { state.canContinue = false; state.job = { running: true, currentId: id, stage: 'checking', message: '正在检查所选组件…', results: [] }; return structuredClone(state); };
      if (deferredInstall) return new Promise(resolve => { deferredInstall = () => resolve(begin()); });
      return begin();
    },
    cancelPrerequisiteInstall: async () => { calls.push(['cancel']); state.job.stage = 'cancelling'; state.job.message = '正在取消安装…'; return structuredClone(state); },
    openPrerequisitePage: async id => { calls.push(['official', id]); },
    reviewPrerequisites: async () => { calls.push(['review']); assert(state.canContinue && !state.job.running); },
    login: async () => { calls.push(['login']); }, logs: async () => { calls.push(['logs']); },
    chooseFolder: async () => { calls.push(['folder']); return 'C:\\selected'; },
    officialServices: async () => { calls.push(['services']); return { origin: 'https://account.example.invalid', configured: true, keyPrefix: 'ccagent_fixture', wallet: { available: '1', frozen: '0' }, routes: [{ id: 'chat-one', name: '官方主模型', service: 'chat', pricing: { version: 1, currency: 'CNY', definition: { rates: [] } } }], roles: { main: 'chat-one' }, auxiliaryEnabled: false, fallbackEnabled: false }; },
    saveOfficialServices: async body => { calls.push(['saveOfficial', body]); },
    saveModel: async body => { calls.push(['saveModel', body]); }, testModel: async id => { calls.push(['testModel', id]); }, finish: async view => { calls.push(['finish', view]); },
  };
  window.ccagentSetup = bridge;
  const context = vm.createContext({ window, document: window.document, FormData: window.FormData,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); }, console });
  vm.runInContext(source, context, { filename: 'welcome.js' });
  const $ = id => window.document.getElementById(id), flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  async function click(element) { assert(element); element.click(); await flush(); }
  async function poll() { const entry = [...timers.entries()].sort((a, b) => a[1].delay - b[1].delay)[0]; assert(entry, 'Expected a scheduled state poll'); timers.delete(entry[0]); entry[1].callback(); await flush(); }
  await flush();
  return { window, $, calls, timers, click, poll, flush, bridge, state: () => state, mutate: fn => fn(state), setReady: value => { backendReady = value; }, failDetection: value => { shouldFail = value; }, deferInstall: () => { deferredInstall = true; }, releaseInstall: async () => { assert.equal(typeof deferredInstall, 'function'); deferredInstall(); deferredInstall = null; await flush(); }, close: async () => { window.dispatchEvent(new window.Event('pagehide')); await window.happyDOM.close(); } };
}

let current;
try {
  current = await fixture();
  assert.equal(current.calls.filter(([action]) => action === 'install' || action === 'login').length, 0, 'Inspection is available before login and never starts installation');
  assert.match(current.$('node-state').textContent, /内置.*已就绪/); assert.match(current.$('node-note').textContent, /24.22.2/);
  assert.equal(current.$('next').disabled, false); assert.equal(current.$('next').textContent, '继续登录');
  assert.equal(current.window.document.querySelectorAll('[data-environment-select]').length, 2);
  assert(!current.window.document.querySelector('[data-environment-select="libreoffice"]'), 'LibreOffice uses the official installer rather than an unsupported automatic package');
  assert(!current.window.document.querySelector('[data-environment-select="bundled-node"]')); assert(!current.window.document.querySelector('[data-environment-select="bundled-npm"]'));
  await current.click(current.$('environment-install')); assert.equal(current.calls.filter(([action]) => action === 'install').length, 0, 'No component is selected by default');
  await current.click(current.$('next')); assert.deepEqual(current.calls.slice(-2).map(([action]) => action), ['review', 'login']); await current.close();

  const missing = report(); missing.requiredReady = false; missing.canContinue = false; missing.components.find(item => item.id === 'bundled-npm').status = 'failed';
  current = await fixture({ initialReport: missing }); assert.equal(current.$('next').disabled, true); assert.equal(current.$('environment-skip').disabled, true); assert.match(current.$('node-note').textContent, /修复或重新安装 CCAGENT/);
  assert(!current.window.document.querySelector('[data-environment-select="bundled-npm"]')); await current.close();

  current = await fixture({ initialReport: missing, readyInitially: false }); assert.equal(current.$('next').disabled, true); assert.match(current.$('error').textContent, /本地服务尚未就绪/);
  current.mutate(state => { state.requiredReady = true; state.canContinue = true; state.components.find(item => item.id === 'bundled-npm').status = 'ready'; });
  await current.click(current.$('environment-refresh')); assert(current.timers.size > 0, 'Repairing required components resumes backend readiness polling');
  current.setReady(true); await current.poll(); assert.equal(current.$('next').disabled, false); assert.equal(current.$('error').textContent, '', 'A resolved startup error is cleared after required components and the backend are repaired'); assert.equal(current.calls.filter(([action]) => action === 'login').length, 0); await current.close();

  current = await fixture({ initialReport: missing, readyInitially: false });
  const unrelatedError = current.$('error').textContent;
  current.bridge.logs = async () => { throw new Error(unrelatedError); };
  await current.click(current.$('logs')); assert.equal(current.$('error').textContent, unrelatedError);
  current.mutate(state => { state.requiredReady = true; state.canContinue = true; state.components.find(item => item.id === 'bundled-npm').status = 'ready'; });
  await current.click(current.$('environment-refresh')); current.setReady(true); await current.poll();
  assert.equal(current.$('error').textContent, unrelatedError, 'Status recovery preserves a later error from another operation even if its text matches the old startup error'); await current.close();

  const manual = report(); manual.installer.available = false; manual.components.forEach(item => { item.canInstall = false; });
  current = await fixture({ initialReport: manual }); assert.equal(current.$('next').disabled, false); assert.equal(current.$('environment-install').disabled, true);
  await current.click(current.window.document.querySelector('[data-environment-official="python"]')); assert.deepEqual(current.calls.at(-1), ['official', 'python']);
  assert.equal(current.$('environment-installer-page').hidden, false); await current.click(current.$('environment-installer-page')); assert.deepEqual(current.calls.at(-1), ['official', 'winget']); await current.close();

  current = await fixture({ failDetect: true }); assert.match(current.$('environment-error').textContent, /重新检测/); assert.equal(current.$('next').disabled, true);
  current.failDetection(false); await current.click(current.$('environment-refresh')); assert.equal(current.$('environment-error').hidden, true); assert.equal(current.$('next').disabled, false); await current.close();

  current = await fixture({ authenticated: true });
  await current.click(current.window.document.querySelector('[data-environment-select="git-bash"]')); assert.match(current.$('environment-selection').textContent, /Git Bash/);
  current.deferInstall(); await current.click(current.$('environment-install')); assert.equal(current.$('environment-install').disabled, true);
  current.$('environment-install').dispatchEvent(new current.window.Event('click')); await current.flush(); assert.equal(current.calls.filter(([action]) => action === 'install').length, 1);
  await current.releaseInstall(); assert.equal(current.$('environment-cancel').hidden, false); assert.equal(current.$('logs').disabled, false, 'Optional installation does not disable the entire guide');
  assert.equal(current.$('next').disabled, true); assert.match(current.$('environment-job-status').textContent, /正在检查/);
  assert.match(current.$('environment-summary').textContent, /基础环境已通过/); assert.equal(current.$('environment-summary').classList.contains('needs-repair'), false, 'An optional install blocks continuation without misreporting the required runtime');
  current.mutate(state => { state.job.stage = 'installing'; state.job.message = '正在启动官方安装向导…'; }); await current.poll(); assert.match(current.$('environment-job-status').textContent, /官方安装向导/);
  assert(current.calls.some(([action, refresh]) => action === 'detect' && refresh === false), 'Installation progress polls state without rerunning full probes');
  current.failDetection(true); await current.poll(); assert.match(current.$('environment-error').textContent, /重新检测/); assert(current.timers.size > 0, 'A failed progress poll schedules another read rather than leaving the guide stuck'); current.failDetection(false);
  current.mutate(state => { state.canContinue = true; state.job.running = false; state.job.results = [{ id: 'git-bash', status: 'failed', message: '安装未完成，请重试。' }]; state.components.find(item => item.id === 'git-bash').status = 'failed'; });
  await current.poll(); assert.match(current.$('environment-job-status').textContent, /安装未完成/); assert.equal(current.$('next').disabled, false, 'Failed optional installs do not block entering the app');
  await current.click(current.window.document.querySelector('[data-environment-select="git-bash"]')); await current.click(current.$('environment-install')); assert.equal(current.calls.filter(([action]) => action === 'install').length, 2, 'A failed component may be explicitly retried');
  await current.click(current.$('environment-cancel')); assert.match(current.$('environment-job-status').textContent, /正在取消/);
  current.mutate(state => { state.canContinue = true; state.job.running = false; state.job.cancelled = true; state.job.message = '安装已取消。'; state.job.results = [{ id: 'git-bash', status: 'cancelled', message: '安装已取消。' }]; });
  await current.poll(); assert.equal(current.$('environment-cancel').hidden, true); assert.equal(current.$('environment-skip').disabled, false);
  await current.click(current.$('environment-skip')); assert.equal(current.$('step-label').textContent, '使用准备 · 02 / 04');
  await current.click(current.$('choose-folder')); assert.equal(current.$('workspace').textContent, 'C:\\selected');
  await current.click(current.$('next')); assert.equal(current.$('personal-panel').hidden, true); assert.equal(current.$('official-panel').hidden, false); assert.match(current.$('official-status').textContent, /余额 ¥0\.000001/);
  await current.click(current.$('connection-personal')); current.$('model-id').value = 'fixture-model'; current.$('model-url').value = 'https://fixture.example.invalid/v1'; current.$('model-name').value = 'fixture-model'; current.$('model-key').value = 'synthetic-local-fixture-only';
  current.$('model-form').dispatchEvent(new current.window.Event('submit', { bubbles: true, cancelable: true })); await current.flush();
  assert.equal(current.$('model-key').value, ''); assert(current.calls.some(([action]) => action === 'saveModel')); assert.equal(current.$('test-model').disabled, false);
  await current.click(current.$('test-model')); assert(current.calls.some(([action]) => action === 'testModel'));
  await current.click(current.$('next')); await current.click(current.$('next')); assert.deepEqual(current.calls.at(-1), ['finish', '']);
  current.window.document.dispatchEvent(new current.window.Event('ccagent:show-environment')); await current.flush(); assert.equal(current.$('step-label').textContent, '使用准备 · 01 / 04');
  await current.close(); assert.equal(current.timers.size, 0);

  current = await fixture({ authenticated: true, reviewed: true }); assert.equal(current.$('step-label').textContent, '使用准备 · 02 / 04');
  current.window.document.dispatchEvent(new current.window.Event('ccagent:show-environment')); await current.flush(); assert.equal(current.$('step-label').textContent, '使用准备 · 01 / 04'); await current.close();
  console.log('Desktop welcome DOM passed: pre-login inspection, bundled runtime repair, optional skip/manual official pages, detection retry, selected-only single installation, real job-state polling, failure/retry/cancel, navigation/login review, preserved workspace/model flows, menu reopening and cleanup. Synthetic bridge only; no software installed or global environment changed.');
} finally { if (current) await current.close(); }
