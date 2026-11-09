/** Real React DOM with synthetic admin-route transport. No credentials, database or provider requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const cloud = fileURLToPath(new URL('../', import.meta.url)), requireCloud = createRequire(new URL('../package.json', import.meta.url));
const browser = new Window({ url: 'http://127.0.0.1:4310/admin/routes', settings: { disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false, enableCSSFileLoading: false, enableImageFileLoading: false } });
const globals = ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Event', 'MouseEvent', 'FormData', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', '__routeRefresh'];
const previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of globals.slice(0, 11)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? browser : browser[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true; let refreshes = 0; globalThis.__routeRefresh = () => { refreshes++; };
const React = requireCloud('react'), { act } = React, { createRoot } = requireCloud('react-dom/client');
const compiled = await build({ absWorkingDir: cloud, stdin: { contents: "export { AdminRoutesPanel } from './src/components/admin-routes-panel';", resolveDir: cloud, loader: 'tsx' }, bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
  plugins: [{ name: 'offline-ui', setup(builder) {
    builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'router', namespace: 'synthetic' }));
    builder.onResolve({ filter: /\.module\.css$/ }, () => ({ path: 'styles', namespace: 'synthetic' }));
    builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, args => ({ contents: args.path === 'router' ? 'export const useRouter = () => ({refresh: () => globalThis.__routeRefresh()});' : 'export default {management:"management",tableWrap:"tableWrap",table:"table",actions:"actions",buttons:"buttons",inspector:"inspector",details:"details"};', loader: 'js' }));
  } }] });
const module = { exports: {} }; new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(requireCloud, module, module.exports);
const { AdminRoutesPanel } = module.exports;
const reply = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(value) });
const tick = () => new Promise(resolve => setTimeout(resolve, 0)), calls = [], roots = new Set();
const secret = 'synthetic-credential-must-never-render';
let holdLoad = null, holdDelete = null, malformed = false;
const base = id => ({ id, name: `测试服务 ${id}`, service: 'chat', protocol: 'openai-chat', provider: 'fixture', baseUrl: 'https://api.example.invalid/v1', upstreamModel: 'fixture-model', credentialEnv: 'CCAGENT_PROVIDER_HIDDEN_REFERENCE', enabled: false,
  timeoutMs: 120000, retries: 0, updatedAt: '2026-11-09T00:00:00.000Z', options: { contextWindow: 4096, maxOutputTokens: 128, maxImages: 2, fallbackEnabled: false, fallbackRouteId: null } });
const routes = new Map(['a', 'b'].map(id => [id, { route: base(id), routeFingerprint: id.repeat(64), latestPrice: null, credentialStatus: { configured: true, source: 'managed' }, ready: false, apiKey: secret, encrypted: secret }]));
let version = 0;
const transport = call => {
  const url = new URL(call.url, browser.location.origin);
  assert.equal(url.pathname, '/api/admin/routes', 'Only local admin-route transport is allowed');
  if (!call.options.method) {
    if (holdLoad) return holdLoad(call);
    if (malformed) return { ok: true, status: 200, json: async () => { throw new SyntaxError(secret); } };
    const value = routes.get(url.searchParams.get('id'));
    return value ? reply(value) : reply({ code: 'ROUTE_DELETED', message: secret }, 410);
  }
  if (call.options.method === 'DELETE') {
    if (holdDelete) return holdDelete(call);
    const value = routes.get(call.body.id);
    if (!value) return reply({ code: 'ROUTE_DELETED', message: secret }, 410);
    if (call.body.expectedUpdatedAt !== value.route.updatedAt) return reply({ code: 'ROUTE_CONFIGURATION_CHANGED', message: secret }, 409);
    assert.equal(call.body.expectedRouteFingerprint, value.routeFingerprint); routes.delete(call.body.id);
    return reply({ deleted: true, mode: 'archived' });
  }
  assert(['POST', 'PUT'].includes(call.options.method));
  const { apiKey, removeApiKey, expectedUpdatedAt, ...route } = call.body, old = routes.get(route.id);
  if (call.options.method === 'POST' && old) return reply({ code: 'ROUTE_ALREADY_EXISTS', message: secret }, 409);
  if (call.options.method === 'PUT' && expectedUpdatedAt !== old?.route.updatedAt) return reply({ code: 'ROUTE_CONFIGURATION_CHANGED', message: secret }, 409);
  route.updatedAt = new Date(Date.UTC(2026, 10, 9, 1, 0, ++version)).toISOString();
  routes.set(route.id, { route, routeFingerprint: old?.routeFingerprint || 'c'.repeat(64), latestPrice: old?.latestPrice || null, credentialStatus: { configured: removeApiKey ? false : Boolean(apiKey) || old?.credentialStatus.configured || false, source: 'managed' }, ready: false });
  return reply({ saved: true, enabled: route.enabled });
};
globalThis.fetch = async (url, options = {}) => { const call = { url: String(url), options, body: options.body ? JSON.parse(options.body) : undefined }; calls.push(call); return transport(call); };
function button(name, root) { const value = [...root.querySelectorAll('button')].find(item => item.textContent === name); assert(value, 'Missing button ' + name); return value; }
function action(name, root) { const value = root.querySelector(`[aria-label="${name}"]`); assert(value, 'Missing action ' + name); return value; }
function control(name, root) {
  const label = [...root.querySelectorAll('label')].find(item => [...item.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('').trim() === name);
  const input = label?.querySelector('input,select,textarea'); assert(input, 'Missing input ' + name); return input;
}
async function change(element, value) { await act(async () => { const prototype = element instanceof browser.HTMLSelectElement ? browser.HTMLSelectElement.prototype : browser.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new browser.Event(element instanceof browser.HTMLSelectElement ? 'change' : 'input', { bubbles: true })); }); }
async function click(element) { await act(async () => { element.click(); await tick(); }); }
async function submit(form) { await act(async () => { form.dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true })); await tick(); }); }
async function until(check, name) { for (let i = 0; i < 80; i++) { if (check()) return; await act(async () => { await tick(); }); } assert.fail(name); }
function row(id) { const value = routes.get(id); return { id, name: value.route.name, service: value.route.service, protocol: value.route.protocol, provider: value.route.provider, base_url: value.route.baseUrl, upstream_model: value.route.upstreamModel, enabled: value.route.enabled, credential_configured: value.credentialStatus.configured, updated_at: value.route.updatedAt, credential_env: secret, encrypted: secret }; }
async function render(permissions = ['admin.read', 'routes.write']) {
  const host = browser.document.createElement('div'); browser.document.body.append(host); const root = createRoot(host); roots.add(root);
  await act(async () => { root.render(React.createElement(React.StrictMode, null, React.createElement(AdminRoutesPanel, { rows: ['a', 'b'].filter(id => routes.has(id)).map(row), permissions }))); await tick(); });
  return { host, async unmount() { await act(async () => { root.unmount(); }); roots.delete(root); host.remove(); } };
}
try {
  const css = await fs.readFile(new URL('../src/components/admin-routes-panel.module.css', import.meta.url), 'utf8');
  assert.match(css, /position:sticky;left:0/); assert.match(css, /@media\(max-width:760px\)/);
  const admin = await render(), root = admin.host;
  assert.equal(root.querySelector('th').textContent, '操作'); assert.equal(root.querySelector('tbody tr td').className, 'actions');
  assert.equal(root.querySelectorAll('tbody tr').length, 2); assert.equal(root.querySelector('[role=region]').tabIndex, 0);
  assert(!root.textContent.includes(secret)); assert(!root.textContent.includes('CCAGENT_PROVIDER_HIDDEN_REFERENCE'));
  const detailsButton = action('查看 测试服务 a 详情', root); await click(detailsButton);
  await until(() => root.querySelector('dl'), 'Details loaded'); assert.match(root.textContent, /已配置/); assert.match(root.textContent, /尚未配置/);
  assert(!root.innerHTML.includes(secret)); await click(button('关闭', root)); assert.equal(browser.document.activeElement, detailsButton);
  let releaseEditLoad;
  holdLoad = () => new Promise(resolve => { releaseEditLoad = () => resolve(reply(routes.get('a'))); });
  await click(action('编辑 测试服务 a', root)); const pendingEditLoad = calls.at(-1);
  assert.equal(button('关闭', root).disabled, false, 'A read-only edit load may be closed without waiting for the network');
  await click(button('关闭', root)); assert.equal(pendingEditLoad.options.signal.aborted, true);
  await act(async () => { releaseEditLoad(); await tick(); }); holdLoad = null;
  assert(!root.querySelector('input[type=password]'), 'A closed editor cannot reappear from a late load');
  await click(action('编辑 测试服务 a', root));
  await until(() => root.querySelector('input[type=password]') && control('路由编号', root).value === 'a' && !button('保存路由', root).disabled, 'Edit loaded');
  assert.equal(control('路由编号', root).disabled, true); assert.equal(root.querySelector('input[type=password]').value, '');
  assert.equal(button('关闭', root).disabled, false, 'Loading an existing route does not leave the inspector locked');
  await change(control('显示名称', root), '更新后的服务'); await submit(button('保存路由', root).form);
  assert.equal(calls.filter(call => call.options.method === 'PUT').at(-1).body.expectedUpdatedAt, '2026-11-09T00:00:00.000Z');
  assert.equal(Object.hasOwn(calls.filter(call => call.options.method === 'PUT').at(-1).body, 'apiKey'), false);
  assert.equal(routes.get('a').route.name, '更新后的服务'); assert(!root.innerHTML.includes(secret));
  routes.get('a').route.updatedAt = '2026-11-09T02:00:00.000Z'; root.querySelector('input[type=password]').value = secret;
  await submit(button('保存路由', root).form); assert.match(root.querySelector('[role=alert]').textContent, /其他管理员/); assert.equal(root.querySelector('input[type=password]').value, ''); assert(!root.textContent.includes(secret));
  await click(button('关闭', root)); await click(button('新增服务网关', root));
  assert.equal(control('路由编号', root).value, ''); assert.equal(control('路由编号', root).disabled, false);
  for (const [service, protocol] of [['vision', 'openai-chat'], ['decision', 'jev-decisions'], ['search', 'tavily'], ['voice', 'dashscope-tts']]) {
    await change(control('服务类型', root), service); assert.equal(control('供应商协议', root).value, protocol);
  }
  await change(control('服务类型', root), 'image'); assert.equal(control('供应商协议', root).value, 'openai-images');
  assert([...control('供应商协议', root).options].some(item => item.value === 'dashscope-images'));
  assert.equal(control('开放状态', root).disabled, true); assert.match(root.textContent, /当前仅可保存暂停的配置/);
  assert.equal(button('追加成本版本', root).disabled, true, 'Image costs require a saved paused route');
  assert(![...root.querySelectorAll('button')].some(item => item.textContent === '准备连接检测'), 'Image cost metadata does not enable connection testing');
  for (const [field, value] of [['路由编号', 'image-test'], ['显示名称', '图像生成测试配置'], ['供应商编号', 'fixture'], ['上游模型', 'fixture-image'], ['上游地址', 'https://api.example.invalid/v1']]) await change(control(field, root), value);
  await submit(button('保存路由', root).form);
  const created = calls.filter(call => call.options.method === 'POST').at(-1); assert.equal(created.body.service, 'image'); assert.equal(created.body.enabled, false); assert.equal(created.body.protocol, 'openai-images'); assert(!Object.hasOwn(created.body, 'expectedUpdatedAt'));
  assert.equal(routes.get('image-test').latestPrice, null, 'Missing prices are never replaced with a fake zero price');
  assert.equal(button('追加成本版本', root).disabled, false, 'A saved paused image route can store cost metadata');
  assert.equal(control('计价项目', root).value, 'output_images');
  assert.equal(control('计价单位数量', root).value, '1');
  assert.equal(control('开放状态', root).disabled, true);
  assert(![...root.querySelectorAll('button')].some(item => item.textContent === '准备连接检测'));
  await click(button('关闭', root));
  malformed = true; await click(action('查看 测试服务 b 详情', root)); await until(() => root.querySelector('[role=alert]'), 'Malformed detail failed'); assert(!root.textContent.includes(secret)); malformed = false; await click(button('关闭', root));
  await click(action('删除 测试服务 b', root)); await until(() => root.querySelector('dl'), 'Delete details loaded');
  const confirm = button('确认删除路由', root); assert.equal(confirm.disabled, true);
  await click(root.querySelector('input[type=checkbox]')); routes.get('b').route.updatedAt = '2026-11-09T03:00:00.000Z';
  await submit(confirm.form); assert.match(root.querySelector('[role=alert]').textContent, /其他管理员/); assert(routes.has('b')); assert(!root.textContent.includes(secret));
  await click(button('关闭', root)); await click(action('删除 测试服务 b', root)); await until(() => root.querySelector('dl'), 'Fresh delete loaded');
  await click(root.querySelector('input[type=checkbox]'));
  let releaseDelete; holdDelete = call => new Promise(resolve => { releaseDelete = () => { holdDelete = null; resolve(transport(call)); }; });
  const beforeDelete = calls.filter(call => call.options.method === 'DELETE').length;
  await submit(button('确认删除路由', root).form); assert.equal(button('关闭', root).disabled, true);
  await submit(button('正在删除…', root).form); assert.equal(calls.filter(call => call.options.method === 'DELETE').length, beforeDelete + 1, 'Duplicate delete submissions are blocked');
  await act(async () => { releaseDelete(); await tick(); }); assert(!routes.has('b')); assert.equal(root.querySelectorAll('tbody tr').length, 1); assert.match(root.textContent, /历史调用、价格和审计记录已保留/);
  await admin.unmount();
  const readonly = await render(['admin.read']); assert(![...readonly.host.querySelectorAll('button')].some(item => ['新增服务网关', '编辑', '删除'].includes(item.textContent)));
  assert(action('查看 更新后的服务 详情', readonly.host)); await readonly.unmount();
  const denied = await render(['routes.read']); assert.equal(denied.host.textContent, ''); await denied.unmount();
  const late = await render(); let releaseLoad;
  holdLoad = call => new Promise(resolve => { releaseLoad = () => resolve(reply(routes.get('a'))); });
  await click(action('查看 更新后的服务 详情', late.host)); const pending = calls.at(-1); await late.unmount();
  assert.equal(pending.options.signal.aborted, true); const beforeLate = refreshes; await act(async () => { releaseLoad(); await tick(); }); assert.equal(refreshes, beforeLate); holdLoad = null;
  assert(calls.every(call => !call.url.includes(secret))); assert(calls.every(call => !call.url.includes('/routes/test'))); assert.equal(browser.localStorage.length, 0);
  console.log('Admin routes React DOM passed: fixed first actions, redacted details, close/focus, permission-gated CRUD, POST/PUT versions, credential retention/error clearing, service protocols, image configuration-only, conflict/duplicate deletion, stale response cleanup. Synthetic transport only.');
} finally {
  for (const root of roots) await act(async () => { root.unmount(); }); await browser.happyDOM.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
}
