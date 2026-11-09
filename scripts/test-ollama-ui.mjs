/** Ollama settings integration: offline DOM, no live models or downloads. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const root = path.resolve(import.meta.dirname, '..');
const window = new Window({ url: 'http://offline-ollama.test/?view=settings&setting=models', settings: { disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false, enableCSSFileLoading: false, enableImageFileLoading: false } });
window.document.write(await fs.readFile(path.join(root, 'web/index.html'), 'utf8'));
for (const name of ['window', 'document', 'location', 'history', 'Event', 'KeyboardEvent']) globalThis[name] = name === 'window' ? window : window[name];
const { createCustomizationUI } = await import(pathToFileURL(path.join(root, 'web/customization.js')).href);
const calls = [], changes = [], notices = [];
let workspace = 'C:\\fixture-ollama', discovery, models = [
  { id: 'existing-local', provider: 'ollama', localModel: true, protocol: 'openai-chat', model: 'qwen3:8b', baseURL: 'http://127.0.0.1:11434/v1', hasKey: false },
  { id: 'existing-api', protocol: 'anthropic', model: 'fixture-remote', baseURL: 'https://example.invalid/api', hasKey: true },
];
const api = async (route, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : undefined;
  calls.push({ route, body });
  if (route === '/api/account/access') return { user: { id: 'fixture-user' }, permissions: [], origin: 'https://accounts.invalid' };
  if (route === '/api/customize/settings') return { settings: {}, defaultModel: 'existing-api' };
  if (route === '/api/customize/models') {
    if (body) {
      const model = { ...body, localModel: body.provider === 'ollama', hasKey: Boolean(body.apiKey) };
      models = [...models.filter(item => item.id !== body.id), model];
      return { id: body.id };
    }
    return { models };
  }
  if (route === '/api/customize/ollama-models') return discovery ? discovery(body) : { baseURL: 'http://127.0.0.1:11434/v1', models: [{ name: 'qwen3:8b' }, { name: '<img src=x onerror=alert(1)>' }], truncated: false };
  if (route === '/api/customize/model-test') return { ok: true, reply: 'Fixture actual test route' };
  throw new Error(`Unexpected API call ${route}`);
};
const ui = createCustomizationUI({ api, toast: value => notices.push(value), navigate() {}, changed: async value => changes.push(value), getModel: () => 'existing-api', getSessionId: () => null, getBusy: () => false, getWorkspace: () => workspace });
const $ = id => document.getElementById(id);
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const findButton = (parent, text) => [...parent.querySelectorAll('button')].find(button => button.textContent === text);
const click = async target => { assert(target, 'Expected UI control'); target.click(); await settle(); };
const change = (input, value, event = 'change') => { input.value = value; input.dispatchEvent(new Event(event, { bubbles: true })); };
const openLocal = () => click(findButton($('settings-content'), '接入 Ollama'));
const close = () => click($('editor-close'));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

try {
  await ui.open('settings');
  const localRow = [...$('settings-content').querySelectorAll('article')].find(row => row.textContent.includes('existing-local'));
  assert(localRow.textContent.includes('Ollama 本地模型'));
  assert(localRow.textContent.includes('本地服务，无需密钥'));
  assert(!localRow.textContent.includes('未配置密钥'));
  await click(findButton(localRow, '测试连接'));
  assert.deepEqual(calls.find(call => call.route.endsWith('/model-test')).body, { id: 'existing-local' });
  assert(notices.includes('连接成功：Fixture actual test route'));

  await openLocal();
  assert.equal($('editor-title').textContent, '接入 Ollama');
  assert.equal($('edit-model-provider').value, 'ollama');
  assert.equal($('edit-model-url').value, 'http://127.0.0.1:11434');
  assert.equal($('edit-model-protocol').value, 'openai-chat');
  assert($('edit-model-protocol').disabled);
  assert($('edit-model-key').disabled && $('edit-model-key').closest('label').classList.contains('hidden'));
  assert.equal($('edit-ollama-tools').querySelector('a').href, 'https://ollama.com/download/windows');
  assert($('edit-ollama-tools').textContent.includes('不会下载模型'));
  assert($('edit-ollama-tools').textContent.includes('向量模型不能用于对话'));
  await click($('edit-ollama-detect'));
  assert.deepEqual(calls.find(call => call.route.endsWith('/ollama-models')).body, { baseURL: 'http://127.0.0.1:11434' });
  assert.equal($('edit-model-url').value, 'http://127.0.0.1:11434/v1');
  assert.equal($('edit-ollama-models').options.length, 3);
  assert.equal($('edit-ollama-models').options[2].textContent, '<img src=x onerror=alert(1)>');
  assert.equal($('editor-body').querySelectorAll('img').length, 0, 'Model names remain literal text');
  change($('edit-ollama-models'), 'qwen3:8b');
  assert.equal($('edit-model-name').value, 'qwen3:8b');
  change($('edit-model-id'), 'test-local', 'input');
  await click(findButton($('editor-actions'), '保存模型'));
  const saved = calls.filter(call => call.route.endsWith('/models') && call.body).at(-1).body;
  assert.deepEqual(saved, { id: 'test-local', provider: 'ollama', protocol: 'openai-chat', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', apiKey: '', maxTokens: '', contextWindow: '', makeDefault: true });
  assert(changes.includes('models'), 'Saving refreshes the shared model selector');
  assert($('editor-overlay').classList.contains('hidden'));

  const editedRow = [...$('settings-content').querySelectorAll('article')].find(row => row.textContent.includes('test-local'));
  await click(findButton(editedRow, '编辑'));
  assert.equal($('edit-model-provider').value, 'ollama');
  assert.equal($('edit-model-name').value, 'qwen3:8b');
  assert($('edit-model-id').disabled);
  change($('edit-model-provider'), 'custom');
  assert($('edit-ollama-tools').hidden && !$('edit-model-key').disabled);
  assert.equal($('edit-model-url').value, '');
  $('edit-model-key').value = 'fixture-secret-never-sent-to-ollama';
  change($('edit-model-provider'), 'ollama');
  assert.equal($('edit-model-key').value, '', 'Changing provider clears a hidden credential');
  await close();

  discovery = async () => ({ baseURL: 'http://127.0.0.1:11434/v1', models: [], truncated: false });
  await openLocal(); await click($('edit-ollama-detect'));
  assert($('edit-ollama-status').textContent.includes('尚未安装模型'));
  assert($('edit-ollama-status').textContent.includes('ollama pull'));
  assert($('edit-ollama-models').disabled);
  change($('edit-model-name'), 'known-manual:latest', 'input');
  assert.equal($('edit-model-name').value, 'known-manual:latest');
  await close();

  discovery = async () => { throw new Error('Fixture connection refused'); };
  await openLocal(); await click($('edit-ollama-detect'));
  assert($('edit-ollama-status').textContent.includes('Fixture connection refused'));
  assert($('edit-ollama-status').textContent.includes('正在运行'));
  assert(!$('edit-ollama-detect').disabled);
  await close();

  let pending = deferred(); discovery = () => pending.promise;
  await openLocal(); await click($('edit-ollama-detect'));
  assert($('edit-ollama-detect').disabled);
  await click(findButton($('editor-actions'), '保存模型'));
  assert($('editor-error').textContent.includes('请等待本地模型检测完成'));
  change($('edit-model-url'), 'http://127.0.0.1:22434', 'input');
  pending.resolve({ baseURL: 'http://127.0.0.1:11434/v1', models: [{ name: 'stale-address' }] }); await settle();
  assert.equal($('edit-model-url').value, 'http://127.0.0.1:22434');
  assert(!$('edit-ollama-models').textContent.includes('stale-address'));
  assert(!$('edit-ollama-detect').disabled);
  await close();

  pending = deferred(); discovery = () => pending.promise;
  await openLocal(); await click($('edit-ollama-detect'));
  change($('edit-model-provider'), 'custom');
  change($('edit-model-url'), 'https://provider.invalid/v1', 'input');
  pending.resolve({ baseURL: 'http://127.0.0.1:11434/v1', models: [{ name: 'stale-provider' }] }); await settle();
  assert.equal($('edit-model-url').value, 'https://provider.invalid/v1');
  assert.equal($('edit-model-provider').value, 'custom');
  assert(!$('edit-ollama-models').textContent.includes('stale-provider'));
  await close();

  pending = deferred(); discovery = () => pending.promise;
  await openLocal(); await click($('edit-ollama-detect')); await close();
  await click(findButton($('settings-content'), '＋ 接入大模型'));
  $('edit-model-name').value = 'preserved-new-dialog';
  pending.resolve({ baseURL: 'http://127.0.0.1:11434/v1', models: [{ name: 'stale-dialog' }] }); await settle();
  assert.equal($('edit-model-name').value, 'preserved-new-dialog');
  assert.equal($('edit-model-provider').value, 'custom');
  assert(!$('edit-ollama-models').textContent.includes('stale-dialog'));
  await close();

  pending = deferred(); discovery = () => pending.promise;
  await openLocal(); await click($('edit-ollama-detect'));
  workspace = 'C:\\other-workspace';
  pending.resolve({ baseURL: 'http://127.0.0.1:11434/v1', models: [{ name: 'stale-workspace' }] }); await settle();
  assert(!$('edit-ollama-models').textContent.includes('stale-workspace'));
  await click(findButton($('editor-actions'), '保存模型'));
  assert($('editor-error').textContent.includes('工作区已切换'));
  await close();

  assert(!calls.some(call => /pull|generate|chat\/completions|download/.test(call.route)), 'UI does not install, download, or generate during discovery');
  console.log('Ollama settings UI checks passed (preset, discovery, save/edit, manual fallback, shared test route, credential and async guards).');
} finally {
  await window.happyDOM.close();
}
