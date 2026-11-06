const bridge = window.ccagentSetup;
const $ = id => document.getElementById(id);
let step = 0, ready = false, busy = false, savedId = '', modelCount = 0, tested = false;
const showError = error => { $('error').textContent = error?.message || String(error); };
function paint() {
  document.querySelectorAll('.pane').forEach(pane => pane.hidden = Number(pane.dataset.step) !== step);
  document.querySelectorAll('.steps li').forEach((item, index) => { item.classList.toggle('active', index === step); item.classList.toggle('done', index < step); });
  $('step-label').textContent = `使用准备 · 0${step + 1} / 04`;
  $('back').hidden = step === 0;
  $('skip').hidden = step !== 2;
  $('next').textContent = !ready ? '正在准备…' : step === 3 ? '进入工作区' : '下一步';
  $('next').disabled = !ready || busy || (step === 2 && !savedId && modelCount === 0);
  $('ready-note').textContent = tested ? '模型连接测试已通过。现在可以开始第一项任务。' : (modelCount || savedId) ? '模型配置已保存；如尚未测试，可在设置中测试连接后开始对话。' : '工作文件夹已准备好。开始对话前，请到“设置 → 模型接入”添加模型。';
}
async function run(action) {
  if (busy) return;
  busy = true; $('error').textContent = ''; paint();
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try { await action(); } catch (error) { showError(error); }
  finally {
    busy = false; document.querySelectorAll('button').forEach(button => { button.disabled = false; });
    $('test-model').disabled = !savedId; paint();
  }
}
async function refreshStatus() {
  try {
    const status = await bridge.status();
    ready = status.ready;
    $('version').textContent = 'v' + status.version;
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
$('next').addEventListener('click', () => { $('error').textContent = ''; if (step < 3) { step++; paint(); } else void run(() => bridge.finish('')); });
$('back').addEventListener('click', () => { $('error').textContent = ''; step--; paint(); });
$('skip').addEventListener('click', () => { step = 3; $('error').textContent = ''; paint(); });
$('logs').addEventListener('click', () => void bridge.logs().catch(showError));
$('choose-folder').addEventListener('click', () => void run(async () => { const folder = await bridge.chooseFolder(); if (folder) $('workspace').textContent = folder; }));
$('model-form').addEventListener('submit', event => {
  event.preventDefault();
  void run(async () => {
    const body = { id: $('model-id').value.trim(), protocol: $('model-protocol').value, baseURL: $('model-url').value.trim(), model: $('model-name').value.trim(), apiKey: $('model-key').value };
    await bridge.saveModel(body); savedId = body.id; tested = false; $('model-key').value = '';
    $('model-result').textContent = '已保存，可测试连接。';
  });
});
async function testModel(id) { $('model-result').textContent = '正在测试连接…'; try { await bridge.testModel(id); tested = true; $('model-result').textContent = '✓ 连接测试通过'; } catch (error) { tested = false; $('model-result').textContent = '连接测试未通过'; throw error; } }
$('test-model').addEventListener('click', () => void run(() => testModel(savedId)));
$('test-existing').addEventListener('click', () => void run(() => testModel($('existing-model').value)));
void refreshStatus();
