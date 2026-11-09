/** Real React DOM, synthetic route/config transport only. No provider/account/build/deployment. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const cloud = fileURLToPath(new URL('../', import.meta.url)), requireCloud = createRequire(new URL('../package.json', import.meta.url));
const browser = new Window({ url: 'http://127.0.0.1:4310/admin/routes', settings: { disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false, enableCSSFileLoading: false, enableImageFileLoading: false } });
const globals = ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Event', 'MouseEvent', 'FormData', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', '__gatewayRefresh'];
const previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const key of globals.slice(0, 11)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? browser : browser[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true; let refreshes = 0; globalThis.__gatewayRefresh = () => { refreshes++; };
const React = requireCloud('react'), { act } = React, { createRoot } = requireCloud('react-dom/client');
const compiled = await build({ absWorkingDir: cloud, stdin: { contents: "export { GatewayPanel } from './src/components/gateway-panel'; export { GatewayPriceEditor } from './src/components/gateway-price-editor'; export { GatewayConfigPanel } from './src/components/gateway-config-panel';", resolveDir: cloud, loader: 'tsx' }, bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], plugins: [{ name: 'local-router', setup(builder) { builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'router', namespace: 'synthetic' })); builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({ contents: 'export const useRouter = () => ({refresh: () => globalThis.__gatewayRefresh()});', loader: 'js' })); } }] });
const module = { exports: {} }; new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(requireCloud, module, module.exports);
const { GatewayPanel, GatewayPriceEditor, GatewayConfigPanel } = module.exports;
const reply = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(value) });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const calls = [], roots = new Set(); let fetcher;
globalThis.fetch = async (url, options = {}) => { const call = { url: String(url), options, body: options.body ? JSON.parse(options.body) : undefined }; calls.push(call); return fetcher(call); };
function control(name, root = browser.document, index = 0) {
  const explicit = [...root.querySelectorAll('input,select,textarea')].filter(item => item.getAttribute('aria-label') === name);
  const labels = [...root.querySelectorAll('label')].filter(item => [...item.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('').trim() === name);
  const found = explicit.length ? explicit : labels.map(item => item.querySelector('input,select,textarea'));
  assert.ok(found[index], 'Missing field: ' + name); return found[index];
}
function button(name, root = browser.document) { const item = [...root.querySelectorAll('button')].find(item => item.textContent === name); assert.ok(item, 'Missing button: ' + name); return item; }
async function change(element, value) {
  await act(async () => {
    const prototype = element instanceof browser.HTMLSelectElement ? browser.HTMLSelectElement.prototype : element instanceof browser.HTMLTextAreaElement ? browser.HTMLTextAreaElement.prototype : browser.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new browser.Event(element instanceof browser.HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
async function submit(form) { await act(async () => { form.dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true })); await tick(); }); }
async function click(element) { await act(async () => { element.click(); await tick(); }); }
async function until(check, name) { for (let i = 0; i < 80; i++) { if (check()) return; await act(async () => { await tick(); }); } assert.fail(name); }
async function render(Component, props = {}) {
  const host = browser.document.createElement('div'); browser.document.body.append(host); const root = createRoot(host); roots.add(root);
  await act(async () => { root.render(React.createElement(React.StrictMode, null, React.createElement(Component, props))); await tick(); });
  return { host, async unmount() { await act(async () => { root.unmount(); }); roots.delete(root); host.remove(); } };
}
async function load(id, root) { await change(control('已有路由编号', root), id); await submit(control('已有路由编号', root).form); await until(() => control('路由编号', root).value === id && !button('载入配置', root).disabled, 'Route loaded: ' + id); }
const base = id => ({ id, name: id, service: 'chat', protocol: 'openai-responses', provider: 'deepseek', baseUrl: 'https://api.example.com/v1', upstreamModel: 'synthetic-model', credentialEnv: 'CCAGENT_PROVIDER_LEGACY_' + id.toUpperCase(), enabled: false, timeoutMs: 120000, retries: 0, updatedAt: '2026-11-08T00:00:00.000Z', options: { contextWindow: 4096, maxOutputTokens: 128, maxImages: 2, fallbackEnabled: false, fallbackRouteId: null } });
const price = version => ({ version, currency: 'CNY', sourceUrl: 'https://example.com/prices', components: { definition: { rates: [{ metric: 'input_tokens', price: '1', unitQuantity: '1000000' }, { metric: 'cached_input_tokens', price: '0', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '2', unitQuantity: '1000000' }], tariff: { kind: 'constant' } } } });
const routes = new Map(['a', 'b'].map(id => [id, { route: base(id), routeFingerprint: id.repeat(64), latestPrice: price(1), credentialStatus: { configured: true, source: 'environment' }, ready: false }]));
let rejectSave = false, holdSave = null, holdLoad = null, holdPrice = null;
fetcher = call => {
  const url = new URL(call.url, browser.location.origin);
  if (url.pathname === '/api/admin/routes' && !call.options.method) {
    const id = url.searchParams.get('id'); if (holdLoad) return holdLoad(call);
    return routes.has(id) ? reply(routes.get(id)) : reply({ message: 'Not found' }, 404);
  }
  if (url.pathname === '/api/admin/routes' && ['PUT', 'POST'].includes(call.options.method)) {
    if (holdSave) return holdSave(call);
    if (rejectSave) return reply({ message: 'Never render ' + call.body.apiKey, code: 'INVALID_INPUT' }, 400);
    const { apiKey, removeApiKey, expectedUpdatedAt, ...route } = call.body, old = routes.get(route.id);
    if (call.options.method === 'PUT') assert.equal(expectedUpdatedAt, old.route.updatedAt);
    const credentialStatus = removeApiKey ? { configured: false, source: 'none' } : apiKey ? { configured: true, source: 'managed' } : old?.credentialStatus || { configured: false, source: 'none' };
    route.enabled = removeApiKey ? false : route.enabled;
    route.updatedAt = '2026-11-08T01:00:00.000Z';
    routes.set(route.id, { route, routeFingerprint: old?.routeFingerprint || 'c'.repeat(64), latestPrice: old?.latestPrice || null, credentialStatus, ready: route.enabled });
    return reply({ saved: true, enabled: route.enabled, repricingRequired: false });
  }
  if (url.pathname === '/api/admin/prices' && call.options.method === 'POST') {
    if (holdPrice) return holdPrice(call);
    const row = routes.get(call.body.routeId); assert.ok(row); const version = (row.latestPrice?.version || 0) + 1;
    if (call.body.expectedRouteFingerprint !== row.routeFingerprint) return reply({ code: 'ROUTE_CONFIGURATION_CHANGED' }, 409);
    row.latestPrice = { version, currency: call.body.currency, sourceUrl: call.body.sourceUrl, components: { definition: call.body.definition } };
    return reply({ version }, 201);
  }
  assert.fail('Unexpected transport: ' + call.url);
};
const routeFetcher = fetcher;
browser.localStorage.setItem('existing-draft', 'preserve');
const secret = 'synthetic-key-for-dom-test-only';
try {
  const editor = await render(GatewayPanel, { mode: 'routes', rows: [{ id: 'a' }, { id: 'b' }] }); const root = editor.host;
  assert.equal(root.querySelector('input[type=password]').maxLength, 8192); assert.equal(button('追加成本版本', root).disabled, true);
  const removeKey = root.querySelector('input[type=checkbox]'), removeLabel = removeKey.closest('label'), removeHelp = browser.document.getElementById(removeKey.getAttribute('aria-describedby'));
  assert.equal(removeLabel.className, 'route-test-consent'); assert.equal(removeLabel.textContent, '明确移除已保存的 API Key'); assert.ok(removeHelp && removeHelp.tagName === 'SMALL' && !removeLabel.contains(removeHelp), 'Compact checkbox keeps its label and a separate associated help line');
  assert.equal(root.textContent.includes('供应商凭据配置名'), false); await load('a', root); assert.match(root.textContent, /服务器已有 API Key/);
  for (const [name, value] of [['供应商编号', 'qwen'], ['上游模型', 'other-model'], ['上游地址', 'https://other.example.com/v1'], ['供应商协议', 'openai-chat'], ['服务类型', 'vision'], ['路由编号', 'b']]) {
    root.querySelector('input[type=password]').value = secret; await change(control(name, root), value); assert.equal(root.querySelector('input[type=password]').value, '', 'Identity changes clear Key: ' + name);
  }
  await load('a', root); root.querySelector('input[type=password]').value = secret; await load('b', root);
  assert.equal(root.querySelector('input[type=password]').value, '', 'Loading another route drops the previous unsaved Key');
  assert.equal(control('路由编号', root).value, 'b');

  let releaseSave;
  holdSave = call => new Promise(resolve => { releaseSave = () => { holdSave = null; resolve(routeFetcher(call)); }; });
  root.querySelector('input[type=password]').value = secret; const before = calls.length;
  await submit(button('保存路由', root).form); assert.equal(root.querySelector('input[type=password]').value, '', 'Erase Key before the pending request completes');
  assert.equal(control('路由编号', root).disabled, true); assert.equal(button('新建路由', root).disabled, true);
  await change(control('路由编号', root), 'a'); await submit(button('正在保存…', root).form);
  const writes = calls.slice(before).filter(call => call.options.method === 'PUT'); assert.equal(writes.length, 1); assert.equal(writes[0].body.id, 'b'); assert.equal(writes[0].body.apiKey, secret);
  assert.equal(control('路由编号', root).value, 'b'); await act(async () => { releaseSave(); await tick(); });
  await until(() => root.textContent.includes('后台安全保存'), 'Managed status reloaded after save');
  assert.equal(root.querySelector('input[type=password]').value, ''); assert.equal(root.innerHTML.includes(secret), false);
  await submit(button('保存路由', root).form); assert.equal(Object.hasOwn(calls.filter(call => call.options.method === 'PUT').at(-1).body, 'apiKey'), false, 'Blank omits Key and preserves existing credential reference');
  assert.equal(calls.filter(call => call.options.method === 'PUT').at(-1).body.credentialEnv, 'CCAGENT_PROVIDER_LEGACY_B');
  root.querySelector('input[type=password]').value = secret; await click(root.querySelector('input[type=checkbox]'));
  assert.equal(root.querySelector('input[type=password]').value, ''); await submit(button('保存路由', root).form);
  assert.equal(calls.filter(call => call.options.method === 'PUT').at(-1).body.removeApiKey, true); assert.match(root.textContent, /Key 已移除/); assert.match(root.textContent, /尚未配置 API Key/);

  rejectSave = true; root.querySelector('input[type=password]').value = secret; await submit(button('保存路由', root).form);
  assert.equal(root.querySelector('input[type=password]').value, ''); assert.equal(root.textContent.includes(secret), false); assert.match(root.querySelector('[role=alert]').textContent, /已清空/); rejectSave = false;
  root.querySelector('input[type=password]').value = secret; await change(control('已有路由编号', root), 'missing'); await submit(control('已有路由编号', root).form);
  assert.equal(root.querySelector('input[type=password]').value, '', 'Failed load also clears Key');
  await load('a', root); await change(control('公开单价（CNY）', root, 2), '3');
  let releasePrice; holdPrice = call => new Promise(resolve => { releasePrice = () => { holdPrice = null; resolve(routeFetcher(call)); }; });
  const beforePriceWrites = calls.length; await submit(button('追加成本版本', root).form);
  assert.equal(control('上游模型', root).disabled, true); assert.equal(button('新建路由', root).disabled, true, 'Parent route is locked during price POST');
  await submit(control('路由编号', root).form); await submit(root.querySelector('[aria-label="成本版本编辑器"] form'));
  assert.equal(calls.slice(beforePriceWrites).filter(call => call.options.method === 'PUT').length, 0);
  assert.equal(calls.slice(beforePriceWrites).filter(call => call.url === '/api/admin/prices').length, 1, 'No duplicate price request');
  await act(async () => { releasePrice(); await tick(); });
  const priceWrite = calls.filter(call => call.url === '/api/admin/prices').at(-1); assert.equal(priceWrite.body.routeId, 'a'); assert.equal(priceWrite.body.definition.rates[1].price, '0'); assert.equal(priceWrite.body.definition.rates[2].price, '3');
  assert.equal(priceWrite.body.expectedRouteFingerprint, 'a'.repeat(64));
  assert.equal(Object.hasOwn(priceWrite.body, 'apiKey'), false); assert.match(root.textContent, /成本版本 v2 已追加/);
  routes.get('a').routeFingerprint = 'f'.repeat(64); await change(control('公开单价（CNY）', root, 2), '99'); await submit(button('追加成本版本', root).form);
  assert.match(root.querySelector('[role=alert]').textContent, /其他管理员修改/); assert.equal(routes.get('a').latestPrice.version, 2, 'A stale route fingerprint cannot append a cost version'); await load('a', root);
  await change(control('开放状态', root), 'true'); await submit(button('保存路由', root).form); assert.equal(routes.get('a').route.enabled, true);
  root.querySelector('input[type=password]').value = secret; const detachedKey = root.querySelector('input[type=password]'); await click(button('新建路由', root));
  assert.equal(detachedKey.value, ''); assert.equal(control('路由编号', root).value, ''); assert.equal(button('追加成本版本', root).disabled, true);
  root.querySelector('input[type=password]').value = secret; const detachedOnUnmount = root.querySelector('input[type=password]');
  let releaseLoad; holdLoad = call => new Promise(resolve => { releaseLoad = () => resolve(reply(routes.get('a'))); });
  await change(control('已有路由编号', root), 'a'); await submit(control('已有路由编号', root).form); const pendingLoad = calls.at(-1);
  await editor.unmount(); assert.equal(detachedOnUnmount.value, ''); assert.equal(pendingLoad.options.signal.aborted, true); const beforeLate = refreshes;
  await act(async () => { releaseLoad(); await tick(); }); assert.equal(refreshes, beforeLate, 'Late response after unmount cannot update or refresh'); holdLoad = null;

  const lateSave = await render(GatewayPanel, { mode: 'routes', rows: [{ id: 'a' }] }); await load('a', lateSave.host);
  let releaseLateSave; holdSave = call => new Promise(resolve => { releaseLateSave = () => { holdSave = null; resolve(routeFetcher(call)); }; });
  lateSave.host.querySelector('input[type=password]').value = secret; await submit(button('保存路由', lateSave.host).form); const pendingSave = calls.at(-1), countBeforeUnmount = calls.length;
  await lateSave.unmount(); assert.equal(pendingSave.options.signal.aborted, true); await act(async () => { releaseLateSave(); await tick(); }); assert.equal(calls.length, countBeforeUnmount, 'Late PUT cannot issue a follow-up route load after unmount');
  const compatibility = await render(GatewayPanel, { mode: 'prices', rows: [{ route_id: 'a' }] });
  await change(control('路由编号', compatibility.host), 'a'); assert.equal(button('追加成本版本', compatibility.host).disabled, true, 'Standalone prices requires a loaded fingerprint'); await load('a', compatibility.host);
  assert.equal([...compatibility.host.querySelectorAll('h2,h3')].filter(item => item.textContent === '新增成本版本').length, 1);
  assert.equal(compatibility.host.querySelector('input[type=password]'), null); assert.equal(control('公开单价（CNY）', compatibility.host, 2).value, '3');
  await change(control('价格策略', compatibility.host), 'qwen-input-tiers'); await change(control('供应商最大思考长度（Token）', compatibility.host), '32');
  await change(control('本档输入总 Token 上限（含本数）', compatibility.host), '4096');
  for (const [name, value] of [['未缓存输入单价（CNY）', '2'], ['缓存输入单价（CNY）', '0'], ['非思考输出单价（CNY）', '4'], ['思考输出单价（CNY）', '8']]) await change(control(name, compatibility.host), value);
  await submit(button('追加成本版本', compatibility.host).form); assert.equal(routes.get('a').latestPrice.components.definition.tariff.kind, 'qwen-input-tiers');
  await load('a', compatibility.host); assert.equal(control('缓存输入单价（CNY）', compatibility.host).value, '0'); assert.equal(control('思考输出单价（CNY）', compatibility.host).value, '8'); await compatibility.unmount();

  const legacyPriceEditor = await render(GatewayPriceEditor, { routeId: 'legacy-caller', expectedRouteFingerprint: 'e'.repeat(64), initial: null, onSaved() {} });
  assert.deepEqual([...legacyPriceEditor.host.querySelectorAll('select')].filter(item => item.closest('label')?.textContent.startsWith('计价项目')).map(item => item.value), ['input_tokens', 'cached_input_tokens', 'output_tokens'], 'Existing callers without service props retain token defaults');
  await legacyPriceEditor.unmount();
  const serviceVariants = [
    { id: 'cost-tavily', service: 'search', protocol: 'tavily', upstreamModel: 'synthetic-search', metrics: ['search_credits'], unit: '1' },
    { id: 'cost-bocha', service: 'search', protocol: 'bocha', upstreamModel: 'synthetic-search', metrics: ['requests'], unit: '1' },
    { id: 'cost-image', service: 'image', protocol: 'openai-images', upstreamModel: 'synthetic-image', metrics: ['output_images'], unit: '1' },
    { id: 'cost-dashscope-image', service: 'image', protocol: 'dashscope-images', upstreamModel: 'synthetic-image', metrics: ['output_images'], unit: '1' },
    { id: 'cost-qwen-image', service: 'image', protocol: 'dashscope-images', upstreamModel: 'qwen-image-3.0', metrics: ['input_images', 'output_images'], unit: '1' },
    { id: 'cost-voice', service: 'voice', protocol: 'dashscope-tts', upstreamModel: 'qwen-audio-3.1-tts-flash', metrics: ['input_tokens', 'output_tokens'], unit: '1000000' },
    { id: 'cost-decision', service: 'decision', protocol: 'jev-decisions', upstreamModel: 'synthetic-decision', metrics: ['input_tokens', 'output_tokens'], unit: '1000000' },
    { id: 'cost-chat', service: 'chat', protocol: 'openai-chat', upstreamModel: 'synthetic-chat', metrics: ['input_tokens', 'cached_input_tokens', 'output_tokens'], unit: '1000000' },
    { id: 'cost-vision', service: 'vision', protocol: 'openai-chat', upstreamModel: 'synthetic-vision', metrics: ['input_tokens', 'cached_input_tokens', 'output_tokens'], unit: '1000000' },
  ];
  for (const variant of serviceVariants) routes.set(variant.id, { route: { ...base(variant.id), service: variant.service, protocol: variant.protocol, upstreamModel: variant.upstreamModel }, routeFingerprint: 'd'.repeat(64), latestPrice: null, credentialStatus: { configured: false, source: 'none' }, ready: false });
  const serviceEditor = await render(GatewayPanel, { mode: 'routes', rows: serviceVariants.map(({ id }) => ({ id })) }), serviceRoot = serviceEditor.host;
  for (const variant of serviceVariants) {
    await load(variant.id, serviceRoot);
    assert.deepEqual(variant.metrics.map((_, index) => control('计价项目', serviceRoot, index).value), variant.metrics, 'Unconfigured service uses matching usage metrics: ' + variant.id);
    assert.equal([...serviceRoot.querySelectorAll('label')].filter(item => item.textContent.startsWith('计价项目')).length, variant.metrics.length);
    for (let index = 0; index < variant.metrics.length; index++) {
      assert.equal(control('计价单位数量', serviceRoot, index).value, variant.unit);
      assert.equal(control('公开单价（CNY）', serviceRoot, index).value, '', 'Unconfigured costs are never invented');
    }
    if (variant.service === 'image') {
      assert.equal(control('开放状态', serviceRoot).disabled, true);
      assert(![...serviceRoot.querySelectorAll('button')].some(item => item.textContent === '准备连接检测'));
      for (let index = 0; index < variant.metrics.length; index++) assert.equal(control('计价项目', serviceRoot, index).selectedOptions[0].textContent, variant.metrics[index] === 'input_images' ? '输入图片（张）' : '输出图片（张）');
      assert.match(serviceRoot.textContent, /执行、计费及连接检测待接入/);
    }
    if (variant.service === 'voice') assert.match(serviceRoot.textContent, /输入 Token 对应文本，输出 Token 对应合成音频/);
    // Distinct synthetic prices and nondefault units exercise loading supplier-cost metadata without making provider calls.
    const expectedRates = variant.metrics.map((metric, index) => ({ metric, price: variant.upstreamModel === 'qwen-image-3.0' ? index ? '0.18' : '0.02' : index ? '0' : '0.075', unitQuantity: variant.service === 'image' || variant.service === 'search' ? '1' : '10000' }));
    for (let index = 0; index < expectedRates.length; index++) {
      await change(control('公开单价（CNY）', serviceRoot, index), expectedRates[index].price);
      await change(control('计价单位数量', serviceRoot, index), expectedRates[index].unitQuantity);
    }
    await change(control('供应商公开价格来源', serviceRoot), 'https://example.invalid/synthetic-cost-metadata');
    await submit(button('追加成本版本', serviceRoot).form);
    assert.deepEqual(routes.get(variant.id).latestPrice.components.definition.rates, expectedRates);
    assert.equal(routes.get(variant.id).route.enabled, false, 'Saving a cost never opens a route');
    if (variant.service === 'image') assert.match(serviceRoot.textContent, /仅保存图像成本配置/);
    await load(variant.id, serviceRoot);
    for (let index = 0; index < expectedRates.length; index++) {
      assert.equal(control('计价项目', serviceRoot, index).value, expectedRates[index].metric);
      assert.equal(control('公开单价（CNY）', serviceRoot, index).value, expectedRates[index].price);
      assert.equal(control('计价单位数量', serviceRoot, index).value, expectedRates[index].unitQuantity, 'Saved units take priority over service defaults');
    }
    assert.equal(control('供应商公开价格来源', serviceRoot).value, 'https://example.invalid/synthetic-cost-metadata');
  }
  await serviceEditor.unmount();
  const standaloneImage = await render(GatewayPanel, { mode: 'prices', rows: [{ route_id: 'cost-image' }] }); await load('cost-image', standaloneImage.host);
  assert.equal(control('计价项目', standaloneImage.host).value, 'output_images');
  assert.equal(control('公开单价（CNY）', standaloneImage.host).value, '0.075');
  assert.equal(button('追加成本版本', standaloneImage.host).disabled, false);
  assert.match(standaloneImage.host.textContent, /当前不可开放/); await standaloneImage.unmount();

  let config = { allowedHosts: ['api.example.com'], trustedHosts: ['api.deepseek.com'], version: 2, usdCny: '7.2', fxVersion: 3, fxReadonly: false, fxSource: 'environment' }, conflict = false;
  fetcher = call => {
    assert.equal(call.url, '/api/admin/routes/config');
    if (!call.options.method) return reply(config);
    if (conflict) return reply({ code: 'CONFIGURATION_CHANGED', message: 'Never render ' + secret }, 409);
    assert.equal(call.body.version, config.version); config = { ...config, allowedHosts: call.body.allowedHosts, version: config.version + 1, ...(Object.hasOwn(call.body, 'usdCny') ? { usdCny: call.body.usdCny, fxVersion: config.fxVersion + 1, fxSource: 'database' } : {}) }; return reply(config);
  };
  const settings = await render(GatewayConfigPanel), configRoot = settings.host; await until(() => !control('美元结算汇率', configRoot).disabled, 'Config loaded');
  assert.match(configRoot.textContent, /服务器已有配置/); await change(control('额外允许的上游域名', configRoot), 'NEW.example.com\nnew.example.com'); await change(control('美元结算汇率', configRoot), '7.1');
  await submit(button('保存域名与汇率', configRoot).form); assert.deepEqual(calls.at(-1).body, { version: 2, allowedHosts: ['new.example.com'], usdCny: '7.1', fxVersion: 3 }); assert.match(configRoot.textContent, /后台保存/);
  const configWrites = () => calls.filter(call => call.url === '/api/admin/routes/config' && call.options.method === 'PUT').length;
  const count = configWrites(); await change(control('额外允许的上游域名', configRoot), 'https://bad.example.com/path'); await submit(button('保存域名与汇率', configRoot).form); assert.equal(configWrites(), count);
  await change(control('额外允许的上游域名', configRoot), Array.from({ length: 51 }, (_, index) => `api${index}.example.com`).join('\n')); await submit(button('保存域名与汇率', configRoot).form); assert.equal(configWrites(), count);
  await change(control('额外允许的上游域名', configRoot), 'api.example.com');
  for (const value of ['0.5', '07.2']) { await change(control('美元结算汇率', configRoot), value); await submit(button('保存域名与汇率', configRoot).form); assert.equal(configWrites(), count); }
  await change(control('美元结算汇率', configRoot), '7.1');
  await change(control('额外允许的上游域名', configRoot), ''); await submit(button('保存域名与汇率', configRoot).form); assert.deepEqual(config.allowedHosts, []); assert.equal(Object.hasOwn(calls.at(-1).body, 'usdCny'), false);
  conflict = true; await change(control('额外允许的上游域名', configRoot), 'new.example.com'); await submit(button('保存域名与汇率', configRoot).form);
  assert.match(configRoot.querySelector('[role=alert]').textContent, /其他页面更新/); assert.equal(configRoot.textContent.includes(secret), false); conflict = false;
  config = { ...config, fxReadonly: true }; await click(button('重新载入域名与汇率', configRoot)); assert.equal(control('美元结算汇率', configRoot).disabled, true);
  await change(control('额外允许的上游域名', configRoot), 'api.example.com'); await submit(button('保存域名与汇率', configRoot).form); assert.equal(Object.hasOwn(calls.at(-1).body, 'usdCny'), false); assert.equal(Object.hasOwn(calls.at(-1).body, 'fxVersion'), false); await settings.unmount();
  assert.equal(browser.localStorage.length, 1); assert.equal(browser.localStorage.getItem('existing-draft'), 'preserve'); assert.equal(browser.location.href.includes(secret), false);
  assert.equal(calls.every(call => !call.url.includes(secret)), true); assert.equal(calls.some(call => call.url.includes('/routes/test')), false);
  console.log('Gateway React DOM checks passed: bound password-only Key lifecycle, identity/load/new/failure/unmount cleanup, duplicate and late requests, preserve/remove, inline cost→enable, service-specific defaults, image input/output cost metadata, saved price/unit/zero reload, legacy/standalone/Qwen compatibility, host/FX versions/conflict/readonly. Synthetic transport only; no upstream/build/deployment.');
} finally {
  for (const root of roots) await act(async () => { root.unmount(); });
  await browser.happyDOM.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
}
