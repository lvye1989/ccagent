const bridge = window.ccagentSetup;
const $ = id => document.getElementById(id);
let step = 0, ready = false, busy = false, savedId = '', personalSavedId = '', modelCount = 0, tested = false;
let connection = 'official', official, officialLoading;
const officialFields = new Map();
const roleDefinitions = [['main', '主模型', 'chat'], ['image', '视觉读图', 'vision'], ['decision', 'Jev 决策', 'decision'], ['search', '联网搜索', 'search'], ['voice', '语音合成', 'voice']];
const showError = error => { $('error').textContent = (error?.message || String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); };
function paint() {
  document.querySelectorAll('.pane').forEach(pane => pane.hidden = Number(pane.dataset.step) !== step);
  document.querySelectorAll('.steps li').forEach((item, index) => { item.classList.toggle('active', index === step); item.classList.toggle('done', index < step); });
  $('step-label').textContent = `使用准备 · 0${step + 1} / 04`;
  $('back').hidden = step === 0;
  $('skip').hidden = step !== 2;
  $('next').textContent = !ready ? '正在准备…' : step === 3 ? '进入工作区' : '下一步';
  $('next').disabled = !ready || busy || (step === 2 && !savedId && modelCount === 0);
  $('ready-note').textContent = tested ? '模型连接测试已通过。现在可以开始第一项任务。' : (modelCount || savedId) ? '模型配置已保存；可在设置中查看费用并测试连接后开始对话。' : '工作文件夹已准备好。开始对话前，请到设置选择官方服务或添加个人模型。';
  $('official-panel').hidden = connection !== 'official'; $('personal-panel').hidden = connection !== 'personal';
  for (const mode of ['official', 'personal']) { const selected = connection === mode; $('connection-' + mode).classList.toggle('active', selected); $('connection-' + mode).setAttribute('aria-pressed', String(selected)); }
  $('save-official').disabled = busy || !official?.configured || !officialFields.get('main')?.value;
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
  try {
    const status = await bridge.status();
    ready = status.ready;
    if (ready && !status.authenticated) { await bridge.login(); return; }
    $('version').textContent = 'v' + status.version;
    $('setup-account').textContent = status.email ? `当前账户：${status.email}` : '';
    $('workspace').textContent = status.workspace || '';
    $('node-check').textContent = '✓';
    $('node-note').textContent = `Node.js ${status.nodeVersion || ''} / npm 已内置，无需单独安装`;
    $('backend-check').textContent = ready ? '✓' : '…';
    $('backend-note').textContent = ready ? '已就绪' : '启动中';
    $('git-check').textContent = status.git ? '✓' : '○'; $('git-note').textContent = status.git ? 'Git 已检测到' : '按需安装';
    $('python-check').textContent = status.python ? '✓' : '○'; $('python-note').textContent = status.python ? 'Python 已检测到' : '按需配置';
    $('service-status').textContent = ready ? '本地服务已就绪' : '正在启动本地服务…'; $('service-status').classList.toggle('ready', ready);
    if (status.error) { $('service-status').textContent = '服务需要重启'; showError(status.error); }
    modelCount = status.models.length;
    $('existing-models').hidden = !modelCount;
    const previous = $('existing-model').value;
    $('existing-model').replaceChildren(...status.models.map(model => { const option = document.createElement('option'); option.value = model.id; option.textContent = `${model.id} · ${model.model}`; return option; }));
    if (previous) $('existing-model').value = previous;
    paint();
    if (!ready && !status.error) setTimeout(refreshStatus, 1500);
  } catch (error) { showError(error); setTimeout(refreshStatus, 3000); }
}
$('next').addEventListener('click', () => { $('error').textContent = ''; if (step < 3) { step++; paint(); if (step === 2 && connection === 'official') void loadOfficial().catch(showError); } else void run(() => bridge.finish('')); });
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
function money(value) { try { const amount = BigInt(value); return `${amount / 1000000n}.${(amount % 1000000n).toString().padStart(6, '0').slice(0, 4)}`; } catch { return '—'; } }
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
void refreshStatus();
