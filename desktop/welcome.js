const bridge = window.ccagentSetup;
const $ = id => document.getElementById(id);
let step = 0, ready = false, busy = false, savedId = '', personalSavedId = '', modelCount = 0, tested = false;
let connection = 'official', official, officialLoading;
let authenticated = false, initialStatus = true, closed = false, statusTimer, statusError = '';
let environment = null, environmentLoading = false, environmentAction = false, environmentRequest = null, environmentTimer, environmentError = '', selectedComponent = '';
let environmentRevision = 0;
const requiredComponents = ['windows', 'architecture', 'powershell', 'bundled-node', 'bundled-npm'];
const optionalComponents = ['git-bash', 'python', 'libreoffice'];
const officialFields = new Map();
const roleDefinitions = [['main', '主模型', 'chat'], ['image', '视觉读图', 'vision'], ['decision', 'Jev 决策', 'decision'], ['search', '联网搜索', 'search'], ['voice', '语音合成', 'voice']];
const showError = error => { statusError = ''; $('error').textContent = (error?.message || String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); };
function paint() {
  document.querySelectorAll('.pane').forEach(pane => pane.hidden = Number(pane.dataset.step) !== step);
  document.querySelectorAll('.steps li').forEach((item, index) => { item.classList.toggle('active', index === step); item.classList.toggle('done', index < step); });
  $('step-label').textContent = `使用准备 · 0${step + 1} / 04`;
  $('back').hidden = step === 0;
  $('skip').hidden = step !== 2;
  $('next').textContent = !ready ? '正在准备…' : step === 0 && !authenticated ? '继续登录' : step === 3 ? '进入工作区' : '下一步';
  $('next').disabled = !ready || busy || (step === 0 && (!environmentReady() || environment?.canContinue !== true || environmentLoading || environmentAction || environment?.job?.running)) || (step === 2 && !savedId && modelCount === 0);
  $('ready-note').textContent = tested ? '模型连接测试已通过。现在可以开始第一项任务。' : (modelCount || savedId) ? '模型配置已保存；可在设置中查看费用并测试连接后开始对话。' : '工作文件夹已准备好。开始对话前，请到设置选择官方服务或添加个人模型。';
  $('official-panel').hidden = connection !== 'official'; $('personal-panel').hidden = connection !== 'personal';
  for (const mode of ['official', 'personal']) { const selected = connection === mode; $('connection-' + mode).classList.toggle('active', selected); $('connection-' + mode).setAttribute('aria-pressed', String(selected)); }
  $('save-official').disabled = busy || !official?.configured || !officialFields.get('main')?.value;
  environmentControls();
}
function environmentReady() { return environment?.requiredReady === true && requiredComponents.every(id => environment.components.some(component => component.id === id && component.status === 'ready')); }
function environmentControls() {
  const installing = environment?.job?.running === true, working = environmentLoading || environmentAction || busy;
  const selected = environment?.components.find(item => item.id === selectedComponent);
  $('environment-refresh').disabled = working || installing;
  $('environment-install').disabled = working || installing || !selected || selected.status === 'ready' || !selected.canInstall || !environment?.installer?.available;
  $('environment-install').textContent = installing ? '正在安装…' : selected ? `安装 ${selected.name}` : '安装所选组件';
  $('environment-cancel').hidden = !installing;
  $('environment-cancel').disabled = working;
  $('environment-installer-page').hidden = environment?.installer?.available !== false || environment?.installer?.canOpenOfficial !== true || environment?.installer?.officialId !== 'winget';
  $('environment-installer-page').disabled = environmentAction || busy;
  $('environment-skip').disabled = !ready || !environmentReady() || environment?.canContinue !== true || working || installing;
  document.querySelectorAll('[data-environment-select]').forEach(input => { input.disabled = working || installing; });
  document.querySelectorAll('[data-environment-official]').forEach(button => { button.disabled = environmentAction || busy; });
  $('environment-error').hidden = !environmentError;
  $('environment-error').textContent = environmentError;
}
function environmentElement(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; }
async function openEnvironmentPage(id) {
  if (environmentAction || busy) return;
  environmentAction = true; environmentError = ''; environmentControls();
  try { await bridge.openPrerequisitePage(id); }
  catch { environmentError = '暂时无法打开官方页面，请稍后重试。'; }
  finally { if (!closed) { environmentAction = false; paint(); } }
}
function environmentCard(component, optional) {
  const running = environment?.job?.running && environment.job.currentId === component.id;
  const card = environmentElement('article', `environment-card${optional ? ' optional' : ''}${running ? ' installing' : ''}`);
  card.dataset.component = component.id;
  const icon = environmentElement('span', `environment-mark ${component.status}`, running ? '…' : component.status === 'ready' ? '✓' : optional ? '○' : '!'); icon.setAttribute('aria-hidden', 'true');
  const copy = environmentElement('div', 'environment-copy'), title = environmentElement('strong', '', component.name);
  const status = running ? '正在安装' : component.status === 'ready' ? '已就绪' : component.status === 'unsupported' ? '不支持一键配置' : component.status === 'manual' ? '需手动完成' : component.status === 'failed' ? '检查未通过' : optional ? '未安装 · 可选' : '需要修复';
  const state = environmentElement('span', 'environment-state', status);
  copy.append(title, state, environmentElement('p', '', component.description || ''), environmentElement('small', '', [component.version ? `版本 ${component.version}` : '', component.message || ''].filter(Boolean).join(' · ')));
  const actions = environmentElement('div', 'environment-card-actions');
  if (optional && component.status !== 'ready' && component.canInstall && environment?.installer?.available) {
    const label = environmentElement('label', 'environment-choice'), input = document.createElement('input');
    input.type = 'radio'; input.name = 'environment-component'; input.value = component.id; input.checked = selectedComponent === component.id; input.dataset.environmentSelect = component.id;
    input.addEventListener('change', () => { selectedComponent = component.id; environmentError = ''; $('environment-selection').textContent = `已选择：${component.name}`; paint(); });
    label.append(input, document.createTextNode('选择安装')); actions.append(label);
  }
  if (component.canOpenOfficial) {
    const button = environmentElement('button', 'text-button', optional ? '官方下载 ↗' : '查看修复说明 ↗'); button.type = 'button'; button.dataset.environmentOfficial = component.id;
    button.setAttribute('aria-label', `打开 ${component.name} ${optional ? '官方下载页' : '修复说明'}`);
    button.addEventListener('click', () => { void openEnvironmentPage(component.id); }); actions.append(button);
  }
  card.append(icon, copy, actions); return card;
}
function renderEnvironment() {
  const components = environment?.components || [], node = components.find(item => item.id === 'bundled-node'), npm = components.find(item => item.id === 'bundled-npm');
  const runtimeReady = node?.status === 'ready' && npm?.status === 'ready';
  $('node-check').textContent = runtimeReady ? '✓' : environment ? '!' : '…';
  $('node-state').textContent = runtimeReady ? '内置 · 已就绪' : environment ? '需要修复客户端' : '检查中';
  $('node-note').textContent = runtimeReady ? `Node.js ${node.version || ''} · npm / npx ${npm.version || ''} 已随应用提供` : environment ? '内置运行时未通过检查，请修复或重新安装 CCAGENT；安装全局 Node.js 不能修复此问题。' : '随应用提供，不需要安装全局 Node.js';
  $('environment-required').replaceChildren(...components.filter(item => requiredComponents.includes(item.id)).map(item => environmentCard(item, false)));
  $('environment-components').replaceChildren(...components.filter(item => optionalComponents.includes(item.id)).map(item => environmentCard(item, true)));
  if (selectedComponent && !components.some(item => item.id === selectedComponent && item.status !== 'ready' && item.canInstall)) selectedComponent = '';
  $('environment-selection').textContent = selectedComponent ? `已选择：${components.find(item => item.id === selectedComponent)?.name || ''}` : '选择你需要的可选组件';
  $('environment-summary').textContent = !environment ? '环境检测尚未完成，可点击重新检测。' : environmentReady() ? '基础环境已通过。可选组件按需安装，也可直接继续。' : '基础环境需要修复，请查看下方检查结果。';
  $('environment-summary').classList.toggle('needs-repair', Boolean(environment && !environmentReady()));
  $('environment-installer-note').textContent = environment?.installer?.available ? '选择组件并点击安装后才开始下载与安装。Windows 可能显示系统安装或权限提示。' : 'Windows 软件包管理器暂不可用，可从各组件官方页面下载安装，再点击“重新检测”。';
  const job = environment?.job;
  $('environment-job-status').textContent = job?.running ? `${job.message || '安装任务正在进行。'} 可取消安装后继续；已打开的工作区仍可使用。` : job?.message || (job?.results?.length ? '安装任务已结束。请核对组件状态，失败时可重新选择并重试。' : '未启动安装任务。');
  if (job?.results?.length) {
    const results = job.results.filter(item => optionalComponents.includes(item.id));
    if (results.length) $('environment-job-status').textContent += ' ' + results.map(item => `${components.find(component => component.id === item.id)?.name || item.id}：${item.message || item.status}`).join('；');
  }
  paint();
}
function acceptEnvironment(report) {
  if (!report || report.schemaVersion !== 1 || !Array.isArray(report.components) || !report.components.every(item => item && typeof item.id === 'string' && typeof item.name === 'string')) throw new Error('Invalid environment report');
  environment = report; environmentError = '';
  if (!environmentReady() && step > 0) step = 0;
  renderEnvironment();
  if (environmentReady() && !ready && !closed) { clearTimeout(statusTimer); statusTimer = setTimeout(refreshStatus, 250); }
  clearTimeout(environmentTimer); environmentTimer = undefined;
  if (report.job?.running && !closed) environmentTimer = setTimeout(() => { environmentTimer = undefined; void refreshEnvironment(false); }, 1200);
}
async function refreshEnvironment(refresh = true) {
  if (closed || environmentRequest) return environmentRequest;
  if (environmentAction) { if (environment?.job?.running) { clearTimeout(environmentTimer); environmentTimer = setTimeout(() => { environmentTimer = undefined; void refreshEnvironment(false); }, 1200); } return; }
  const revision = environmentRevision; environmentLoading = true; environmentError = ''; environmentControls();
  const request = (async () => {
    await Promise.resolve();
    try { if (typeof bridge.prerequisites !== 'function') throw new Error('Unavailable'); const report = await bridge.prerequisites({ refresh }); if (!closed && revision === environmentRevision) acceptEnvironment(report); }
    catch { if (!closed && revision === environmentRevision) { environmentError = '环境检测暂时无法完成，请点击“重新检测”；也可查看诊断日志。'; if (!environment) $('environment-summary').textContent = '环境检测尚未完成。'; } }
    finally {
      environmentRequest = null;
      if (!closed && revision === environmentRevision) { environmentLoading = false; paint(); if (environment?.job?.running && !environmentTimer) environmentTimer = setTimeout(() => { environmentTimer = undefined; void refreshEnvironment(false); }, 1500); }
    }
  })();
  environmentRequest = request; return request;
}
async function installEnvironment() {
  const component = environment?.components.find(item => item.id === selectedComponent);
  if (environmentAction || environmentLoading || busy || environment?.job?.running || !component || !optionalComponents.includes(component.id) || component.status === 'ready' || !component.canInstall || !environment.installer?.available) return;
  environmentAction = true; environmentError = ''; paint();
  try { const report = await bridge.installPrerequisite(component.id); if (!closed) acceptEnvironment(report); }
  catch { if (!closed) environmentError = '安装请求未完成。请重新检测确认状态，再重试或使用官方下载。'; }
  finally { if (!closed) { environmentAction = false; paint(); if (environment?.job?.running) { clearTimeout(environmentTimer); environmentTimer = setTimeout(() => { environmentTimer = undefined; void refreshEnvironment(false); }, 1200); } } }
}
async function cancelEnvironmentInstall() {
  if (environmentAction || busy || !environment?.job?.running) return;
  environmentAction = true; paint();
  try { const report = await bridge.cancelPrerequisiteInstall(); if (!closed) acceptEnvironment(report); }
  catch { if (!closed) environmentError = '取消结果尚未确认，请重新检测安装状态。'; }
  finally { if (!closed) { environmentAction = false; paint(); } }
}
async function advanceFromEnvironment() {
  if (!ready || !environmentReady() || environment?.canContinue !== true || environmentLoading || environmentAction || environment?.job?.running || busy) return;
  await run(async () => { await bridge.reviewPrerequisites(); if (!authenticated) await bridge.login(); else { step = 1; paint(); } });
}
async function run(action) {
  if (busy) return;
  busy = true; $('error').textContent = ''; paint();
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try { await action(); } catch (error) { showError(error); }
  finally {
    busy = false; document.querySelectorAll('button').forEach(button => { button.disabled = false; });
    $('test-model').disabled = !personalSavedId; paint();
  }
}
async function refreshStatus() {
  if (closed) return;
  try {
    const status = await bridge.status();
    if (closed) return;
    ready = status.ready === true; authenticated = status.authenticated === true;
    if (initialStatus && ready) { initialStatus = false; if (authenticated && status.environmentReviewed && (!environment || environmentReady())) step = 1; }
    $('version').textContent = 'v' + status.version;
    $('setup-account').textContent = status.email ? `当前账户：${status.email}` : '';
    $('workspace').textContent = status.workspace || '';
    $('backend-check').textContent = ready ? '✓' : '…';
    $('backend-note').textContent = ready ? '已就绪' : '启动中';
    $('service-status').textContent = ready ? '本地服务已就绪' : '正在启动本地服务…'; $('service-status').classList.toggle('ready', ready);
    if (status.error) { $('service-status').textContent = '服务需要重启'; showError(status.error); statusError = $('error').textContent; }
    else { if (statusError && $('error').textContent === statusError) $('error').textContent = ''; statusError = ''; }
    const models = Array.isArray(status.models) ? status.models : [];
    modelCount = models.length;
    $('existing-models').hidden = !modelCount;
    const previous = $('existing-model').value;
    $('existing-model').replaceChildren(...models.map(model => { const option = document.createElement('option'); option.value = model.id; option.textContent = `${model.id} · ${model.model}`; return option; }));
    if (previous) $('existing-model').value = previous;
    paint();
    if (!ready && (!status.error || environmentReady())) statusTimer = setTimeout(refreshStatus, 1500);
  } catch (error) { if (!closed) { showError(error); statusError = $('error').textContent; statusTimer = setTimeout(refreshStatus, 3000); } }
}
$('next').addEventListener('click', () => { $('error').textContent = ''; if (step === 0) { void advanceFromEnvironment(); return; } if (step < 3) { step++; paint(); if (step === 2 && connection === 'official') void loadOfficial().catch(showError); } else void run(() => bridge.finish('')); });
$('back').addEventListener('click', () => { $('error').textContent = ''; step--; paint(); });
$('skip').addEventListener('click', () => { step = 3; $('error').textContent = ''; paint(); });
$('logs').addEventListener('click', () => void bridge.logs().catch(showError));
$('choose-folder').addEventListener('click', () => void run(async () => { const folder = await bridge.chooseFolder(); if (folder) $('workspace').textContent = folder; }));
$('model-form').addEventListener('submit', event => {
  event.preventDefault();
  void run(async () => {
    const body = { id: $('model-id').value.trim(), protocol: $('model-protocol').value, baseURL: $('model-url').value.trim(), model: $('model-name').value.trim(), apiKey: $('model-key').value };
    await bridge.saveModel(body); savedId = body.id; personalSavedId = body.id; tested = false; $('model-key').value = '';
    $('model-result').textContent = '已保存，可测试连接。';
  });
});
async function testModel(id) { $('model-result').textContent = '正在测试连接…'; try { await bridge.testModel(id); tested = true; $('model-result').textContent = '✓ 连接测试通过'; } catch (error) { tested = false; $('model-result').textContent = '连接测试未通过'; throw error; } }
$('test-model').addEventListener('click', () => void run(() => testModel(personalSavedId)));
$('test-existing').addEventListener('click', () => void run(() => testModel($('existing-model').value)));
function money(value) { try { const amount = BigInt(value), absolute = amount < 0n ? -amount : amount; return `${amount < 0n ? '-' : ''}${absolute / 1000000n}.${(absolute % 1000000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')}`; } catch { return '—'; } }
function renderOfficial(value) {
  official = value;
  const wallet = value.wallet;
  $('official-status').textContent = `${value.origin}${wallet ? ` · 余额 ¥${money(wallet.available ?? wallet.balance)} · 冻结 ¥${money(wallet.frozen)}` : ''}`;
  $('official-verified').textContent = value.configured ? `${value.keyPrefix}… 已验证` : '尚未验证平台 Key';
  $('official-key').placeholder = value.configured ? `${value.keyPrefix}… 已验证，留空保留` : '在用户中心创建；不填写供应商 Key';
  $('official-selection').hidden = !value.configured;
  $('official-role-fields').replaceChildren(); officialFields.clear();
  for (const [role, label, service] of roleDefinitions) {
    const wrap = document.createElement('label'); wrap.textContent = label;
    const select = document.createElement('select'); select.id = 'setup-official-' + role;
    const choices = value.routes.filter(route => route.service === service);
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = role === 'main' ? '请选择主模型' : '暂不使用'; select.append(empty);
    for (const route of choices) { const option = document.createElement('option'); option.value = route.id; option.textContent = route.name; select.append(option); }
    select.value = value.roles[role] || '';
    select.addEventListener('change', () => { renderPrices(); paint(); });
    wrap.append(select); $('official-role-fields').append(wrap); officialFields.set(role, select);
  }
  $('official-auxiliary').checked = Boolean(value.auxiliaryEnabled);
  $('official-fallback').checked = Boolean(value.fallbackEnabled);
  renderPrices(); paint();
}
function renderPrices() {
  const root = $('official-price-list'); root.replaceChildren();
  const metrics = { input_tokens: '输入 Token', cached_input_tokens: '缓存输入 Token', output_tokens: '输出 Token', audio_input_tokens: '音频输入 Token', audio_output_tokens: '音频输出 Token', input_characters: '输入字符', requests: '次请求', search_credits: '搜索 credit' };
  const selected = new Set([...officialFields.values()].map(select => select.value));
  const backups = new Set((official?.routes || []).filter(route => selected.has(route.id) && route.limits?.fallbackEnabled).map(route => route.limits.fallbackRouteId));
  for (const route of official?.routes || []) {
    if (!selected.has(route.id) && !backups.has(route.id)) continue;
    const row = document.createElement('article'), name = document.createElement('strong'); name.textContent = `${route.name} · 价格 v${route.pricing.version}`; row.append(name);
    if (backups.has(route.id)) { const tag = document.createElement('p'); tag.textContent = '管理员备用路由，须开启备用授权后才会切换。'; row.append(tag); }
    for (const rate of route.pricing.definition.rates) { const line = document.createElement('p'); line.textContent = `每 ${rate.unitQuantity} ${metrics[rate.metric] || rate.metric}：${route.pricing.currency} ${rate.price}${rate.offPeakPrice === undefined ? '' : `（低峰 ${rate.offPeakPrice}）`}`; row.append(line); }
    const note = document.createElement('p'); note.textContent = `实际用量 × 公开成本 × 1.3${route.pricing.currency === 'USD' ? `；结算汇率 ${route.pricing.usdCny} 元/美元` : ''}。未用完的冻结额度会释放。`; row.append(note);
    const source = document.createElement('a'); source.textContent = '供应商公开价格 ↗'; source.href = route.pricing.sourceUrl; source.target = '_blank'; source.rel = 'noopener noreferrer'; row.append(source); root.append(row);
  }
}
async function loadOfficial(force = false) {
  if (official && !force) return;
  if (officialLoading) return officialLoading;
  $('official-status').textContent = '正在读取账户服务…';
  officialLoading = bridge.officialServices().then(renderOfficial).catch(error => { $('official-status').textContent = '账户服务暂时不可用，可稍后刷新目录或选择个人模型。'; throw error; }).finally(() => { officialLoading = undefined; });
  return officialLoading;
}
for (const mode of ['official', 'personal']) $('connection-' + mode).addEventListener('click', () => { connection = mode; $('error').textContent = ''; paint(); if (mode === 'official') void loadOfficial().catch(showError); });
for (const section of ['billing', 'keys', 'usage']) $('official-' + section).addEventListener('click', () => void run(() => bridge.accountPage(section)));
$('official-key-form').addEventListener('submit', event => { event.preventDefault(); void run(async () => {
  await officialLoading?.catch(() => {});
  await bridge.saveOfficialServices({ apiKey: $('official-key').value.trim() }); $('official-key').value = '';
  await loadOfficial(true); $('official-result').textContent = '请选择服务并保存；验证过程没有调用收费模型。';
}); });
$('official-selection').addEventListener('submit', event => { event.preventDefault(); void run(async () => {
  const roles = Object.fromEntries([...officialFields].filter(([, select]) => select.value).map(([role, select]) => [role, select.value]));
  if (!roles.main) throw new Error('请先选择官方主模型。');
  const auxiliaryEnabled = $('official-auxiliary').checked;
  if (auxiliaryEnabled && ['image', 'decision', 'search', 'voice'].some(role => !roles[role])) throw new Error('请补齐四项辅助服务，或先取消辅助服务选项。');
  await bridge.saveOfficialServices({ roles, auxiliaryEnabled, makeDefault: true, fallbackEnabled: $('official-fallback').checked, catalogRevision: official.catalogRevision });
  await loadOfficial(true);
  savedId = 'ccagent:' + roles.main; tested = false; $('official-result').textContent = '已保存，主模型已设为默认。';
  await refreshStatus();
}); });
$('environment-refresh').addEventListener('click', () => { void refreshEnvironment(true); });
$('environment-install').addEventListener('click', () => { void installEnvironment(); });
$('environment-cancel').addEventListener('click', () => { void cancelEnvironmentInstall(); });
$('environment-installer-page').addEventListener('click', () => { if (environment?.installer?.canOpenOfficial && environment.installer.officialId === 'winget') void openEnvironmentPage('winget'); });
$('environment-skip').addEventListener('click', () => { void advanceFromEnvironment(); });
document.addEventListener('ccagent:show-environment', () => { initialStatus = false; step = 0; paint(); void refreshEnvironment(!environment?.job?.running); });
window.addEventListener('pagehide', () => { closed = true; environmentRevision++; clearTimeout(environmentTimer); clearTimeout(statusTimer); $('model-key').value = ''; $('official-key').value = ''; });
paint(); void refreshStatus(); void refreshEnvironment(true);
