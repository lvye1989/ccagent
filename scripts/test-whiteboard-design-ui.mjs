/** Offline DOM contracts only: no image provider, external service or real canvas. */
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createWhiteboardDesign, designSceneImages } from '../web/whiteboard-design.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFe0AAAAASUVORK5CYII=';
const raster = { dataURL: png, mimeType: 'image/png', width: 1, height: 1, name: 'fixture.png' };
const nativeTimeout = globalThis.setTimeout;
const tick = () => new Promise(resolve => nativeTimeout(resolve, 0));
async function until(check, description) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => nativeTimeout(resolve, 5)); } assert.fail(description); }
const config = (overrides = {}) => ({ configured: true, provider: 'dashscope', model: 'qwen-image-2.0-pro', baseURL: 'https://images.example.invalid/edit', source: 'user', hasKey: true, maxReferences: 1, ...overrides });
const source = (id = 'base-1', role = 'base', baseImageId) => ({ ...raster, elementId: id, role, ...(baseImageId ? { baseImageId } : {}) });
const context = (overrides = {}) => ({ workspace: 'C:\\fixture-workspace', id: 'board-a', token: 'scope-a', name: '建筑与城市设计', revision: 2, canvasVersion: 10, images: [source()], ...overrides });

async function harness(options = {}) {
  const browser = new Window({ url: 'http://design-ui.test/', settings: { disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false, enableCSSFileLoading: false, enableImageFileLoading: false, disableIframePageLoading: true } });
  browser.document.write('<main><div id="host"></div></main>');
  const previous = new Map();
  for (const key of ['window', 'document', 'Event', 'File', 'FileReader']) { previous.set(key, globalThis[key]); globalThis[key] = key === 'window' ? browser : browser[key]; }
  globalThis.setTimeout = (callback, delay, ...args) => nativeTimeout(callback, Math.min(delay || 0, 8), ...args);
  const calls = [], imports = [], removals = [], captures = [], sketches = [], downloads = [], notices = [], runs = new Map();
  const controls = { configuration: options.configuration || config(), failStart: undefined, failPoll: undefined, lostStart: false, runningPolls: 0, holdPoll: false, releasePoll: null, holdConfig: false, releaseConfig: null, holdPrepare: false, releasePrepare: null, holdCapture: false, releaseCapture: null, nextResult: undefined };
  let current = options.context === undefined ? context() : options.context, serial = 0, ui;
  const $ = id => browser.document.getElementById(id);
  browser.HTMLAnchorElement.prototype.click = function () { downloads.push({ href: this.href, download: this.download }); };
  const api = async (route, request) => {
    const body = request?.body ? JSON.parse(request.body) : undefined; calls.push({ route, body, method: request?.method || 'GET' });
    const url = new URL(route, 'http://design-ui.test');
    if (url.pathname === '/api/whiteboards/design/config' && !body) {
      const captured = { ...controls.configuration };
      if (controls.holdConfig) await new Promise(resolve => { controls.releaseConfig = resolve; });
      return { workspace: url.searchParams.get('workspace'), config: captured };
    }
    if (route === '/api/whiteboards/design/config' && body) {
      controls.configuration = body.clear ? config({ configured: false, hasKey: false, source: 'none' }) : config({ provider: body.provider, baseURL: body.baseURL, model: body.model, maxReferences: body.provider === 'openai' ? 2 : 1 });
      return { workspace: body.workspace, config: { ...controls.configuration } };
    }
    if (route === '/api/whiteboards/design/assets') return request?.method === 'DELETE' ? { removed: true } : { assetId: crypto.randomUUID(), name: body.image.name, mimeType: body.image.mimeType, expiresAt: new Date(Date.now() + 1800000).toISOString() };
    if (route === '/api/whiteboards/design/start') {
      if (controls.failStart) { const failure = controls.failStart; controls.failStart = undefined; throw failure; }
      const runId = `fixture-run-${++serial}`;
      runs.set(runId, { runId, requestId: body.requestId, workspace: body.workspace, id: body.id, revision: body.revision, canvasVersion: body.canvasVersion, baseImageId: body.baseImageId,
        kind: body.kind, status: 'completed', images: [{ ...raster, name: '<img src=x onerror=alert(1)>生成图' }], elapsedMs: 2400, provider: 'fixture', model: 'fixture-image-edit' });
      if (controls.lostStart) { controls.lostStart = false; throw new TypeError('模拟提交响应丢失'); }
      return { runId };
    }
    if (url.pathname === '/api/whiteboards/design/run') {
      const run = runs.get(url.searchParams.get('runId')); assert.ok(run, 'Polling must use an actually accepted fixture run');
      if (controls.failPoll) { const failure = controls.failPoll; controls.failPoll = undefined; throw failure; }
      if (controls.holdPoll) return new Promise(resolve => { controls.releasePoll = result => resolve(structuredClone(result || run)); });
      if (controls.runningPolls > 0) { controls.runningPolls--; return structuredClone({ ...run, status: 'running', images: [] }); }
      return structuredClone(controls.nextResult ? { ...run, ...controls.nextResult } : run);
    }
    if (url.pathname === '/api/whiteboards/design/request') {
      const run = [...runs.values()].find(item => item.requestId === url.searchParams.get('requestId') && item.workspace === url.searchParams.get('workspace'));
      if (!run) throw Object.assign(new Error('尚未找到已提交的任务'), { status: 404, code: 'not_found' });
      return structuredClone(run);
    }
    if (route === '/api/whiteboards/design/stop') { const run = runs.get(body.runId); if (run) { run.status = 'stopped'; run.images = []; } return { ok: true }; }
    if (route === '/api/whiteboards/design/resume') { const run = runs.get(body.runId); assert.ok(run); if (controls.holdResume) await new Promise(resolve => { controls.releaseResume = resolve; }); run.status = 'completed'; run.images = [raster]; return { runId: run.runId }; }
    assert.fail(`Unexpected offline API route ${route}`);
  };
  ui = createWhiteboardDesign({ api, host: $('host'), toast: text => notices.push(text), onClose() {},
    async prepareFile(file) { if (controls.holdPrepare) await new Promise(resolve => { controls.releasePrepare = resolve; }); return { ...raster, name: file.name }; },
    async capture(baseImageId) { captures.push(baseImageId); const captured = { ...current, ...(baseImageId ? { annotated: { ...raster } } : {}) }; if (controls.holdCapture) await new Promise(resolve => { controls.releaseCapture = resolve; }); return captured; },
    async importImage(role, image, baseImageId, requestId) {
      imports.push({ role, image, baseImageId, requestId, workspace: current.workspace, id: current.id });
      const imageId = `${role}-import-${imports.length}`;
      current = { ...current, revision: current.revision + 1, canvasVersion: current.canvasVersion + 1, images: [...current.images, { ...image, elementId: imageId, role, ...(baseImageId ? { baseImageId } : {}) }] };
      ui.contextChanged(current); return { imageId, canvasVersion: current.canvasVersion, saved: true };
    },
    async removeImage(imageId) { removals.push(imageId); current = { ...current, revision: current.revision + 1, canvasVersion: current.canvasVersion + 1, images: current.images.filter(image => image.elementId !== imageId) }; ui.contextChanged(current); },
    async sketch(baseImageId) { sketches.push(baseImageId); },
  });
  if (current) ui.contextChanged(current); ui.open(); await tick();
  const file = (role, name = 'fixture.png') => { const input = $(role === 'base' ? 'design-base-file' : 'design-reference-file'); Object.defineProperty(input, 'files', { configurable: true, value: [new browser.File(['fixture'], name, { type: 'image/png' })] }); input.dispatchEvent(new browser.Event('change')); };
  const submit = text => { $('design-prompt').value = text; $('design-generate').click(); };
  return { $, ui, browser, controls, calls, imports, removals, captures, sketches, downloads, notices, runs, file, submit,
    current: () => current,
    change(next) { current = next; ui.contextChanged(next); },
    async close() {
      controls.holdPoll = false; controls.holdConfig = false; controls.holdPrepare = false; controls.holdCapture = false;
      controls.releasePoll?.(); controls.releaseConfig?.(); controls.releasePrepare?.(); controls.releaseCapture?.();
      controls.releaseResume?.();
      await ui.beforeLeave(); await tick(); await browser.happyDOM.close();
      globalThis.setTimeout = nativeTimeout;
      for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
    },
  };
}
async function run(options, callback) { const fixture = await harness(options); try { await callback(fixture); } finally { await fixture.close(); } }

const inventory = designSceneImages({ elements: [
  { id: 'base', type: 'image', fileId: 'file', customData: { ccagentDesign: { version: 1, role: 'base', name: '<script>literal</script>', width: 1, height: 1 } } },
  { id: 'deleted', type: 'image', fileId: 'file', isDeleted: true, customData: { ccagentDesign: { version: 1, role: 'base' } } },
  { id: 'foreign', type: 'image', fileId: 'foreign', customData: { ccagentDesign: { version: 1, role: 'base' } } },
], files: { file: { ...raster }, foreign: { dataURL: 'https://untrusted.example.invalid/image.png' } } });
assert.equal(inventory.length, 1); assert.equal(inventory[0].name, '<script>literal</script>');

await run({ context: null, configuration: config({ configured: false, hasKey: false }) }, async f => {
  assert.equal(f.$('design-generate').disabled, true); assert.equal(f.$('design-import-base').disabled, true); assert.equal(f.calls.length, 0);
  assert.match(f.$('design-status').textContent, /新建白板/);
  f.change(context({ images: [] })); await until(() => f.$('design-model-badge').textContent.includes('请先配置'), 'An opened board loads its model configuration');
  assert.equal(f.$('design-generate').disabled, true); assert.equal(f.$('design-import-base').disabled, false); assert.equal(f.$('design-import-reference').disabled, true);
  f.file('base', '<img src=x onerror=alert(1)>原图.png'); await until(() => f.imports.length === 1, 'Original image imports through the parent editor callback'); await tick();
  assert.equal(f.imports[0].role, 'base'); assert.equal(f.imports[0].baseImageId, undefined); assert.equal(f.$('design-generate').disabled, true, 'Importing a source does not bypass missing model config');
  assert.equal(f.browser.document.querySelectorAll('.design-source img').length, 1); assert.ok(f.browser.document.querySelector('.design-source figcaption').textContent.includes('<img src=x onerror=alert(1)>'));
  assert.equal(f.browser.document.querySelector('.design-source script'), null); assert.equal(f.calls.some(call => call.route.endsWith('/start')), false, 'Imports never generate automatically');
});

await run({}, async f => {
  await until(() => !f.$('design-generate').disabled, 'Configured source is ready');
  f.file('reference'); await until(() => f.imports.length === 1, 'Reference import'); await tick();
  assert.equal(f.imports[0].role, 'reference'); assert.equal(f.imports[0].baseImageId, 'base-1'); assert.equal(f.$('design-import-reference').disabled, true); assert.match(f.$('design-import-reference').textContent, /1\/1/);
  f.$('design-provider').value = 'openai'; f.$('design-provider').dispatchEvent(new Event('change')); f.$('design-api-key').value = 'fixture-personal-key';
  f.$('design-model').value = '<img-src=x>'; f.$('design-save-config').click();
  await until(() => f.calls.some(call => call.body?.apiKey === 'fixture-personal-key'), 'Config save uses the explicit user key'); await tick();
  assert.equal(f.$('design-api-key').value, '', 'Credential input clears after successful save'); assert.ok(f.$('design-model-badge').textContent.includes('<img-src=x>')); assert.equal(f.$('design-model-badge').querySelector('img'), null);
  assert.equal(f.$('design-import-reference').disabled, false); f.file('reference'); await until(() => f.imports.length === 2, 'OpenAI supports a second reference'); await tick();
  assert.equal(f.$('design-import-reference').disabled, true); assert.match(f.$('design-import-reference').textContent, /2\/2/);
  [...f.browser.document.querySelectorAll('.design-source button')].find(button => button.textContent === '移除').click(); await until(() => f.removals.length === 1, 'Reference removal reaches the editor'); await tick();
  assert.equal(f.$('design-import-reference').disabled, false);
  f.$('design-sketch').click(); await until(() => f.sketches.length === 1, 'Sketch selects the current source'); assert.equal(f.sketches[0], 'base-1'); await tick();
  f.submit(''); assert.match(f.$('design-status').textContent, /请填写/); assert.equal(f.captures.length, 0); await tick();
  const original = structuredClone(f.current().images.find(image => image.elementId === 'base-1'));
  f.$('design-kind').value = 'urban-analysis'; const expected = { ...f.current() }; f.submit('请绘制公共空间、绿地及慢行动线分析图');
  await until(() => f.$('design-results').querySelectorAll('figure').length === 1, 'Completed generation appears as a manual preview').catch(error => { throw new Error(`${error.message}; status=${f.$('design-status').textContent}; routes=${f.calls.map(call => call.route).join(',')}`); });
  const start = f.calls.find(call => call.route.endsWith('/start'));
  assert.deepEqual(Object.keys(start.body).sort(), ['workspace', 'id', 'revision', 'canvasVersion', 'kind', 'prompt', 'baseImageId', 'annotated', 'requestId'].sort());
  assert.equal(start.body.workspace, expected.workspace); assert.equal(start.body.revision, expected.revision); assert.equal(start.body.canvasVersion, expected.canvasVersion); assert.equal(start.body.baseImageId, 'base-1'); assert.equal(start.body.kind, 'urban-analysis'); assert.equal(start.body.annotated.dataURL, png);
  assert.equal(f.imports.filter(item => item.role === 'result').length, 0, 'Preview never applies or overwrites an original automatically');
  const apply = [...f.$('design-results').querySelectorAll('button')].find(button => button.textContent === '放入画布'); apply.click();
  await until(() => f.imports.some(item => item.role === 'result'), 'Explicit apply appends the generated image'); await tick();
  assert.deepEqual(f.current().images.find(image => image.elementId === 'base-1'), original, 'Original source remains unchanged after apply');
  const result = f.imports.find(item => item.role === 'result'); assert.equal(result.baseImageId, 'base-1'); assert.ok(result.requestId.startsWith('result-fixture-run-'));
  const applied = [...f.$('design-results').querySelectorAll('button')].find(button => button.textContent === '已放入画布'); assert.equal(applied.disabled, true);
  [...f.$('design-results').querySelectorAll('button')].find(button => button.textContent === '下载图片').click(); assert.equal(f.downloads.length, 1); assert.equal(f.downloads[0].href, png);
  [...f.browser.document.querySelectorAll('.design-config-actions button')].find(button => button.textContent === '清除本机设置').click();
  await until(() => f.calls.some(call => call.body?.clear === true), 'Clearing image config uses the explicit config action'); await tick();
  assert.equal(f.$('design-generate').disabled, true); assert.equal(f.current().images.find(image => image.elementId === 'base-1').dataURL, png);
});

await run({}, async f => {
  await until(() => !f.$('design-generate').disabled, 'Model ready'); f.controls.runningPolls = 4; f.submit('观察真实运行时间');
  await until(() => f.$('design-status').textContent.includes('已处理 2 秒'), 'Running poll shows provider-task elapsed time');
  assert.equal(f.$('design-import-base').disabled, true); assert.equal(f.$('design-prompt').disabled, true); assert.equal(f.$('design-stop').hidden, false);
  await until(() => f.$('design-results').querySelector('figure'), 'Running task eventually produces a preview'); assert.equal(f.imports.length, 0);
});

await run({}, async f => {
  await until(() => !f.$('design-generate').disabled, 'Model ready'); f.submit('生成建筑体量分析');
  await until(() => f.$('design-results').querySelector('figure'), 'Preview ready'); f.change({ ...f.current(), canvasVersion: f.current().canvasVersion + 1 });
  const apply = [...f.$('design-results').querySelectorAll('button')].find(button => button.textContent === '放入画布'); assert.equal(apply.disabled, true);
  assert.match(f.$('design-results').textContent, /仍可下载/); [...f.$('design-results').querySelectorAll('button')].find(button => button.textContent === '下载图片').click();
  assert.equal(f.downloads.length, 1); assert.equal(f.imports.length, 0, 'Later manual editing disables stale apply while preserving download');
});

await run({}, async f => {
  await until(() => !f.$('design-generate').disabled, 'Model ready'); f.controls.lostStart = true; f.submit('响应丢失的建筑绘图请求');
  await until(() => !f.$('design-recover').hidden && !f.$('design-recover').disabled, 'Transport uncertainty offers read-only recovery');
  assert.equal(f.$('design-generate').hidden, true); assert.equal(f.calls.filter(call => call.route.endsWith('/start')).length, 1); f.$('design-recover').click();
  await until(() => f.$('design-results').querySelector('figure'), 'Accepted task is recovered by request ID');
  assert.equal(f.calls.filter(call => call.route.endsWith('/start')).length, 1, 'Recovery cannot make a second paid start request'); assert.ok(f.calls.some(call => call.route.startsWith('/api/whiteboards/design/request?') && call.method === 'GET'));
  assert.equal(f.imports.length, 0);
});

await run({}, async f => {
  await until(() => !f.$('design-generate').disabled, 'Model ready'); f.controls.failStart = Object.assign(new Error('模拟配置错误'), { status: 400 }); f.submit('保留失败后的绘图要求');
  await until(() => f.$('design-status').textContent.includes('模拟配置错误'), 'Known failed request is shown');
  assert.equal(f.$('design-prompt').value, '保留失败后的绘图要求'); assert.equal(f.$('design-generate').hidden, false); assert.equal(f.$('design-generate').disabled, false);
  f.controls.failPoll = new TypeError('模拟状态网络抖动'); f.$('design-generate').click(); await until(() => f.$('design-results').querySelector('figure'), 'Read-only polling retries a transient network failure');
  assert.equal(f.calls.filter(call => call.route.endsWith('/start')).length, 2, 'Only explicit retry starts the next generation');
});

await run({}, async f => {
  await until(() => !f.$('design-generate').disabled, 'Model ready'); f.controls.holdPoll = true; f.submit('取消期间晚到的结果');
  await until(() => f.controls.releasePoll, 'Poll can be held across cancellation'); const accepted = [...f.runs.values()][0];
  f.$('design-stop').click(); await until(() => f.calls.some(call => call.route.endsWith('/stop')), 'Explicit stop sends the owned run ID');
  f.controls.holdPoll = false; f.controls.releasePoll({ ...accepted, status: 'completed', images: [raster] });
  await until(() => f.$('design-stop').hidden, 'Cancelled run settles'); assert.equal(f.$('design-results').querySelector('figure'), null); assert.equal(f.imports.length, 0);
});

await run({}, async f => {
  await until(() => !f.$('design-generate').disabled, 'Model ready'); f.controls.holdPoll = true; f.submit('切换工作区前的请求'); await until(() => f.controls.releasePoll, 'Old-board poll held');
  const accepted = structuredClone([...f.runs.values()][0]); f.$('design-api-key').value = 'must-clear-on-scope-change';
  f.change(context({ workspace: 'C:\\another-fixture', id: 'board-b', token: 'scope-b', canvasVersion: 0, images: [] }));
  await until(() => f.calls.some(call => call.route.endsWith('/stop')), 'Switching scope stops the old owned task'); f.controls.holdPoll = false; f.controls.releasePoll(accepted); await tick();
  assert.equal(f.$('design-results').querySelector('figure'), null); assert.equal(f.$('design-api-key').value, ''); assert.equal(f.$('design-prompt').value, ''); assert.equal(f.imports.length, 0);
});

await run({}, async f => {
  await until(() => !f.$('design-generate').disabled, 'Model ready'); f.controls.holdPrepare = true; f.file('base', 'old-board-decode.png'); await until(() => f.controls.releasePrepare, 'Image decoding held before parent import');
  f.change(context({ workspace: 'C:\\different-workspace', id: 'board-b', token: 'scope-b', images: [] })); f.controls.holdPrepare = false; f.controls.releasePrepare(); await tick(); await tick();
  assert.equal(f.imports.length, 0, 'A file selected on an old board must never import into the newly selected board after decode');
});

await run({}, async f => {
  await until(() => !f.$('design-generate').disabled, 'Model ready'); f.controls.holdCapture = true; f.submit('旧画布保存尚未完成'); await until(() => f.controls.releaseCapture, 'Capture held before any image generation request');
  f.change(context({ workspace: 'C:\\different-capture-workspace', id: 'board-b', token: 'scope-b', images: [] }));
  f.controls.holdCapture = false; f.controls.releaseCapture(); await tick(); await tick();
  assert.equal(f.calls.some(call => call.route.endsWith('/start')), false, 'Leaving during snapshot capture cannot dispatch an old-board generation afterward');
});

await run({ context: null }, async f => {
  f.controls.holdConfig = true; f.change(context()); await until(() => f.controls.releaseConfig, 'First board configuration request held');
  f.change(context({ workspace: 'C:\\another-config-workspace', id: 'board-b', token: 'scope-b' }));
  f.controls.holdConfig = false; f.controls.releaseConfig();
  await until(() => f.calls.filter(call => call.route.startsWith('/api/whiteboards/design/config?')).length === 2, 'New scope reloads config after an older in-flight response is discarded');
  await until(() => !f.$('design-generate').disabled, 'Current-scope configuration eventually enables generation');
});

await run({}, async f => {
  await until(() => !f.$('design-generate').disabled, 'Model ready'); f.controls.nextResult = { revision: 999, canvasVersion: 999 }; f.submit('错误版本结果不能应用');
  await until(() => f.$('design-status').textContent.includes('不一致'), 'A wrong revision/version response is rejected');
  assert.equal(f.$('design-results').querySelector('figure'), null); assert.equal(f.imports.length, 0);
  await until(() => !f.$('design-generate').disabled && f.$('design-stop').hidden, 'A permanent result mismatch unlocks the panel for recovery');
  const polls = f.calls.filter(call => call.route.startsWith('/api/whiteboards/design/run?')).length;
  await new Promise(resolve => nativeTimeout(resolve, 30));
  assert.equal(f.calls.filter(call => call.route.startsWith('/api/whiteboards/design/run?')).length, polls, 'An unrelated result cannot create an endless transport retry loop');
});

const kieRoutes = ['flare', 'sunburst'].flatMap(variant => ['text-to-image', 'image-to-image'].map(mode => ({ id: `${variant}-${mode}`, name: `${variant} ${mode}`, upstreamModel: `gpt-image-2-5-${variant}-${mode}` })));
const kieConfig = config({ provider: 'official', source: 'official', model: 'flare-text-to-image', routes: kieRoutes, maxReferences: 14 });
await run({ configuration: kieConfig, context: context({ images: [] }) }, async f => {
  await until(() => !f.$('design-generate').disabled, 'Official text-to-image works without a base');
  assert.equal(f.$('design-variant').options.length, 4); assert.equal(f.$('design-aspect-ratio').options.length, 13); assert.equal(f.$('design-prompt').maxLength, 20000);
  f.$('design-resolution').value = '4K'; f.$('design-resolution').dispatchEvent(new Event('change'));
  assert.equal(f.$('design-background').value, 'auto'); assert.equal([...f.$('design-background').options].find(option => option.value === 'transparent').disabled, true);
  f.$('design-aspect-ratio').value = '27:16'; f.$('design-aspect-ratio').dispatchEvent(new Event('change')); assert.equal(f.$('design-resolution').value, '1K');
  f.$('design-background').value = 'transparent'; f.submit('Draw an isolated building.');
  await until(() => f.$('design-results').querySelector('figure'), 'No-base image result appears');
  const start = f.calls.find(call => call.route.endsWith('/start')); assert.equal(start.body.baseImageId, ''); assert.equal(start.body.annotated, undefined); assert.equal(start.body.generationMode, 'text-to-image'); assert.equal(start.body.background, 'transparent');
  const apply = [...f.$('design-results').querySelectorAll('button')].find(button => button.textContent === '放入画布'); assert.equal(apply.disabled, false); apply.click();
  await until(() => f.imports.length === 1, 'No-base generated image can be put on canvas'); assert.equal(f.imports[0].baseImageId, '');
});
await run({ configuration: { ...kieConfig, model: 'flare-image-to-image' }, context: context({ images: [] }) }, async f => {
  await until(() => f.$('design-variant').value === 'flare-image-to-image', 'Image variant ready'); assert.equal(f.$('design-generate').disabled, true); assert.equal(f.$('design-import-reference').disabled, false);
  f.file('reference', 'full-resolution.png'); await until(() => f.calls.some(call => call.route.endsWith('/assets')), 'Reference uses temporary upload'); await until(() => !f.$('design-generate').disabled, 'Reference-only image-to-image works');
  assert.equal(f.imports.length, 0, 'A full reference is not embedded in the 10MB canvas'); f.submit('Draw a variation.'); await until(() => f.$('design-results').querySelector('figure'), 'Reference result ready');
  const start = f.calls.find(call => call.route.endsWith('/start')); assert.equal(start.body.generationMode, 'image-to-image'); assert.equal(start.body.assetIds.length, 1); assert.equal(start.body.baseImageId, ''); assert.equal(start.body.annotated, undefined);
});
await run({ configuration: kieConfig, context: context({ images: [] }) }, async f => {
  await until(() => !f.$('design-generate').disabled, 'Official model ready'); f.controls.holdPoll = true; f.submit('Interrupted image request');
  await until(() => f.controls.releasePoll, 'Image result poll held'); const original = structuredClone([...f.runs.values()][0]);
  f.$('design-stop').click(); await until(() => f.calls.some(call => call.route.endsWith('/stop')), 'Stop remains local');
  f.controls.holdPoll = false; f.controls.releasePoll({ ...original, status: 'stopped', images: [], canResume: true });
  await until(() => !f.$('design-resume').hidden && !f.$('design-resume').disabled, 'Original image task can be queried after stop'); f.$('design-resume').click();
  await until(() => f.$('design-results').querySelector('figure'), 'Original image result recovered');
  assert.equal(f.calls.filter(call => call.route.endsWith('/start')).length, 1); assert.equal(f.calls.filter(call => call.route.endsWith('/resume')).length, 1);
});
await run({ configuration: kieConfig, context: context({ images: [] }) }, async f => {
  await until(() => !f.$('design-generate').disabled, 'Official model ready'); f.controls.holdPoll = true; f.submit('Resume scope race');
  await until(() => f.controls.releasePoll, 'Poll held'); const original = structuredClone([...f.runs.values()][0]); f.$('design-stop').click();
  await until(() => f.calls.some(call => call.route.endsWith('/stop')), 'Original local wait stopped');
  f.controls.holdPoll = false; f.controls.releasePoll({ ...original, status: 'stopped', images: [], canResume: true });
  await until(() => !f.$('design-resume').hidden && !f.$('design-resume').disabled, 'Resume available'); f.controls.holdResume = true; f.$('design-resume').click();
  await until(() => f.controls.releaseResume, 'Resume response held'); f.change(context({ id: 'another-board', token: 'another-token', images: [] }));
  f.controls.releaseResume();
  await until(() => f.calls.filter(call => call.route.endsWith('/stop')).length === 2, 'Leaving during resume stops the accepted old-board local wait'); assert.equal(f.$('design-results').querySelector('figure'), null);
});

console.log('Whiteboard design UI passed: no-board/model gates, scoped import/remove/sketch, literal labels, provider reference caps, key clearing, explicit snapshot payload, manual preview/apply/download without original overwrite, stale editing guard, readonly lost-response recovery, explicit retry, poll retry, stop/late results, workspace/decoding/config races, and revision/version result checks. Only offline DOM and API doubles were used.');
