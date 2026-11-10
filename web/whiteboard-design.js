const rasterURL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const sameBoard = (a, b) => Boolean(a && b && a.workspace === b.workspace && a.id === b.id && a.token === b.token);
function el(tag, className = '', text) { const n = document.createElement(tag); n.className = className; if (text !== undefined) n.textContent = text; return n; }
function action(text, handler, className = 'design-button') { const n = el('button', className, text); n.type = 'button'; n.addEventListener('click', handler); return n; }
function imageNode(image, className = '') { const n = el('img', className); if (rasterURL.test(image.dataURL || '')) n.src = image.dataURL; n.alt = image.name || '设计图片'; return n; }
/** Keep the original download intact while fitting a preview into the 10MB board. */
async function canvasResult(image) {
  if (image.dataURL.length < 7 * 1024 * 1024) return image;
  const source = new Image(); source.src = image.dataURL; await source.decode();
  const canvas = document.createElement('canvas');
  let scale = Math.min(1, 2048 / Math.max(source.naturalWidth, source.naturalHeight));
  for (let attempt = 0; attempt < 8; attempt++) {
    canvas.width = Math.max(1, Math.round(source.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
    const context = canvas.getContext('2d'); if (!context) throw new Error('无法创建画布预览，请下载原图。');
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const dataURL = canvas.toDataURL('image/png');
    if (dataURL.length < 7 * 1024 * 1024) return { ...image, dataURL, mimeType: 'image/png', width: canvas.width, height: canvas.height, name: `${image.name || '生成图'}画布预览` };
    scale *= .7;
  }
  throw new Error('画布预览仍过大，请先下载原图后缩小导入。');
}

export function designSceneImages(scene) {
  return (scene?.elements || []).filter(e => e.type === 'image' && !e.isDeleted).flatMap(e => {
    const meta = e.customData?.ccagentDesign, file = scene.files?.[e.fileId];
    if (meta?.version !== 1 || !['base', 'reference', 'result'].includes(meta.role) || !rasterURL.test(file?.dataURL || '')) return [];
    return [{ elementId: e.id, role: meta.role, baseImageId: meta.baseImageId, name: meta.name || '未命名图片', width: meta.width, height: meta.height, mimeType: file.mimeType, dataURL: file.dataURL }];
  });
}

/** Normalize user-selected raster files before adding them to the bounded board. */
export async function prepareDesignFile(file) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 30 * 1024 * 1024 || !file.size) throw new Error('请选择 30MB 以内的 PNG、JPEG 或 WEBP 图片。');
  // The application permits data: images in its CSP. Decode the selected file
  // through that same scheme instead of a blob: URL blocked on the parent page.
  const source = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('图片读取失败，请重新选择图片。'));
    reader.onerror = reader.onabort = () => reject(new Error('图片读取失败，请重新选择图片。'));
    reader.readAsDataURL(file);
  });
  const image = new Image(); image.decoding = 'async'; image.src = source;
  try { await image.decode(); } catch { throw new Error('无法解码这张图片，请重新导出为 PNG、JPEG 或 WEBP 后再导入。'); }
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 64 * 1024 * 1024) throw new Error('图片尺寸过大，请先缩小后导入。');
  const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d'); if (!context) throw new Error('浏览器暂时无法读取图片，请重新打开白板。');
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
  let dataURL = canvas.toDataURL('image/png'), mimeType = 'image/png';
  if (dataURL.length > 1200000) { dataURL = canvas.toDataURL('image/jpeg', .86); mimeType = 'image/jpeg'; }
  if (dataURL.length > 2600000) { dataURL = canvas.toDataURL('image/jpeg', .7); mimeType = 'image/jpeg'; }
  if (!rasterURL.test(dataURL) || dataURL.length > 4 * 1024 * 1024) throw new Error('压缩后的图片仍过大，请选择较小的图片。');
  return { dataURL, mimeType, width: canvas.width, height: canvas.height, name: String(file.name || '设计图片').replace(/[\u0000-\u001f]/g, '').slice(0, 100) };
}

export function createWhiteboardDesign({ api, toast, host, capture, importImage, removeImage, sketch, onClose, prepareFile = prepareDesignFile }) {
  const state = { context: null, baseImageId: '', config: null, configLoaded: false, configTask: null, open: false, busy: false, starting: false, run: null, pending: null, result: null, error: '', phase: '', generation: 0, timer: null, startTask: null, leaving: 0, assets: [], baseAssets: new Map(), lastRun: null };
  host.classList.add('whiteboard-design'); host.id = 'whiteboard-design';
  const panel = el('aside', 'design-panel'); panel.setAttribute('aria-label', '建筑与城市设计');
  const header = el('header', 'design-header'), heading = el('div'); heading.append(el('span', 'design-eyebrow', 'DESIGN STUDIO'), el('h2', '', '建筑与城市设计'));
  const close = action('×', () => onClose(), 'design-close'); close.setAttribute('aria-label', '返回 AI 绘图助手'); header.append(heading, close);
  const body = el('div', 'design-body');
  body.append(el('p', 'design-intro', '描述你要绘制的内容，也可以导入底图或参考图辅助设计。'));
  const stepOne = el('section', 'design-section'); stepOne.append(el('h3', '', '01  原图与参考'));
  const upload = el('div', 'design-upload-actions');
  const baseInput = el('input', 'sr-only'); baseInput.type = 'file'; baseInput.accept = 'image/png,image/jpeg,image/webp'; baseInput.id = 'design-base-file';
  const referenceInput = el('input', 'sr-only'); referenceInput.type = 'file'; referenceInput.accept = baseInput.accept; referenceInput.id = 'design-reference-file';
  const uploadBase = action('导入原图', () => baseInput.click()), uploadReference = action('添加参考图', () => referenceInput.click()); uploadBase.id = 'design-import-base'; uploadReference.id = 'design-import-reference'; upload.append(uploadBase, uploadReference);
  const baseSelect = el('select'); baseSelect.id = 'design-base-select'; baseSelect.setAttribute('aria-label', '选择设计原图');
  baseSelect.addEventListener('change', () => { if (locked()) return; state.baseImageId = baseSelect.value; state.result = null; state.error = ''; render(); });
  const sources = el('div', 'design-sources'); stepOne.append(upload, baseInput, referenceInput, baseSelect, sources);
  const stepTwo = el('section', 'design-section'); stepTwo.append(el('h3', '', '02  勾画与要求'));
  const sketchButton = action('在原图上勾画', () => void perform(async () => { await sketch(state.baseImageId); state.phase = '已切换画笔。在原图上标出范围、动线或建筑意向，再填写要求。'; })); sketchButton.id = 'design-sketch';
  const kind = el('select'); kind.id = 'design-kind'; kind.setAttribute('aria-label', '设计任务类型');
  for (const [value, label] of [['architecture', '建筑设计图'], ['urban-analysis', '城市设计分析图']]) { const option = el('option', '', label); option.value = value; kind.append(option); }
  const presets = el('div', 'design-presets');
  for (const text of ['建筑体量与立面', '功能分区与空间结构', '交通动线与慢行', '绿地与公共空间']) presets.append(action(text, () => { const guidance = currentBase() ? '请根据原图与勾画绘制' : textMode() ? '请绘制' : '请根据参考图绘制'; prompt.value = `${guidance}${text}分析图，${currentBase() ? '保留未标注区域的空间关系，' : ''}配以清晰的中文图例与标题。`; kind.value = text.startsWith('建筑') ? 'architecture' : 'urban-analysis'; prompt.focus(); }));
  const prompt = el('textarea'); prompt.id = 'design-prompt'; prompt.rows = 5; prompt.maxLength = 20000; prompt.placeholder = '例如：保留现状建筑，在红线范围内增加公共空间；用绿色表示绿地、橙色表示慢行动线，并参考参考图的表达风格。'; prompt.setAttribute('aria-label', '建筑与城市设计绘制要求');
  const note = el('p', 'design-note', '原图默认锁定，勾画可随时撤销。生成结果是独立图片，原图与手绘内容会保留。');
  stepTwo.append(sketchButton, kind, presets, prompt, note);
  const modelSection = el('section', 'design-section design-output-section'), modelBadge = el('p', 'design-model-badge'); modelBadge.id = 'design-model-badge';
  modelSection.append(el('h3', '', '03  输出选项'));
  const generationOptions = el('div', 'design-generation-options'); generationOptions.id = 'design-generation-options';
  const ratio = el('select'); ratio.id = 'design-aspect-ratio'; ratio.setAttribute('aria-label', '宽高比');
  const resolution = el('select'); resolution.id = 'design-resolution'; resolution.setAttribute('aria-label', '输出分辨率');
  const background = el('select'); background.id = 'design-background'; background.setAttribute('aria-label', '图像背景');
  for (const value of ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9', '27:16', '16:27', '9:8', '8:9']) { const option = el('option', '', value === 'auto' ? '自动宽高比' : value); option.value = value; ratio.append(option); }
  for (const value of ['1K', '2K', '4K']) { const option = el('option', '', value); option.value = value; resolution.append(option); }
  for (const [value, label] of [['auto', '自动背景'], ['transparent', '透明背景（1K）'], ['opaque', '不透明背景（1K）']]) { const option = el('option', '', label); option.value = value; background.append(option); }
  const optionNote = el('p', 'design-note', '每次生成一张图片；图生图最多 16 张输入（含原图与勾画），高清附件临时保留 30 分钟。');
  generationOptions.append(ratio, resolution, background, optionNote);
  modelSection.append(modelBadge, generationOptions);
  const resultArea = el('section', 'design-results'); resultArea.id = 'design-results';
  body.append(stepOne, stepTwo, modelSection, resultArea);
  const footer = el('footer', 'design-footer'), status = el('p', 'design-status'); status.id = 'design-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const buttons = el('div', 'design-generate-actions');
  const generate = action('生成设计图', () => { void start(); }, 'design-button primary'); generate.id = 'design-generate';
  const stop = action('停止生成', () => void stopRun(), 'design-button stop'); stop.id = 'design-stop';
  const recover = action('查询提交状态', () => void recoverRequest()); recover.id = 'design-recover';
  const resumeOriginal = action('继续查询原任务', () => void resumeOriginalRun()); resumeOriginal.id = 'design-resume';
  buttons.append(generate, stop, recover, resumeOriginal); footer.append(status, buttons); panel.append(header, body, footer); host.append(panel);
  function locked() { return state.busy || state.starting || !!state.run || !!state.pending || state.leaving > 0; }
  const currentBase = () => (state.context?.images || []).find(image => image.role === 'base' && image.elementId === state.baseImageId);
  const references = () => (state.context?.images || []).filter(image => image.role === 'reference' && image.baseImageId === state.baseImageId);
  const textMode = () => !currentBase() && references().length === 0 && state.assets.length === 0;
  const modeAvailable = () => {
    const mode = textMode() ? 'textToImage' : 'imageToImage';
    return state.config?.modes ? state.config.modes[mode] === true : Boolean(state.config?.routes?.some(route => route.upstreamModel?.endsWith(textMode() ? '-text-to-image' : '-image-to-image')));
  };
  const cap = () => currentBase() ? 14 : 16;
  function updateGenerationOptions() {
    const oneK = ['27:16', '16:27', '9:8', '8:9'].includes(ratio.value);
    if (oneK) resolution.value = '1K';
    for (const option of resolution.options) option.disabled = oneK && option.value !== '1K';
    if (resolution.value !== '1K') background.value = 'auto';
    for (const option of background.options) option.disabled = resolution.value !== '1K' && option.value !== 'auto';
    render();
  }
  for (const control of [ratio, resolution, background]) control.addEventListener('change', updateGenerationOptions);
  function acceptConfig(config) {
    if (!config || typeof config.configured !== 'boolean') throw new Error('图像模型配置读取失败。');
    state.config = config; state.configLoaded = true; render();
  }
  async function request(action, fields = {}, context = state.context) { return api(`/api/whiteboards/design/${action}`, { method: 'POST', body: JSON.stringify({ workspace: context.workspace, ...fields }) }); }
  async function loadConfig() {
    if (state.configTask || !state.context) return state.configTask;
    const generation = state.generation, workspace = state.context.workspace;
    state.configTask = (async () => {
      try { const data = await api(`/api/whiteboards/design/config?workspace=${encodeURIComponent(workspace)}`); if (generation === state.generation) acceptConfig(data.config); }
      catch (error) { if (generation === state.generation) { state.error = error.message || '图像模型配置暂时无法读取。'; render(); } }
      finally { state.configTask = null; if (state.open && state.context && !state.configLoaded && generation !== state.generation) void loadConfig(); }
    })(); return state.configTask;
  }
  function render() {
    const images = state.context?.images || [], bases = images.filter(image => image.role === 'base'), base = currentBase(), refs = references();
    const selected = state.baseImageId; baseSelect.replaceChildren(); for (const image of bases) { const option = el('option', '', image.name); option.value = image.elementId; baseSelect.append(option); } baseSelect.value = selected; baseSelect.hidden = bases.length < 2;
    const frozen = locked(); panel.setAttribute('aria-busy', String(frozen));
    for (const control of [ratio, resolution, background, uploadBase, baseInput, baseSelect, kind, prompt]) control.disabled = frozen || !state.context;
    uploadReference.disabled = frozen || !state.context || refs.length + state.assets.length >= cap(); referenceInput.disabled = uploadReference.disabled; uploadReference.textContent = `添加参考图 ${refs.length + state.assets.length}/${cap()}`; sketchButton.disabled = frozen || !base;
    presets.querySelectorAll('button').forEach(button => { button.disabled = frozen || !state.context; });
    generate.disabled = frozen || !state.context || !state.config?.configured || !modeAvailable(); generate.hidden = Boolean(state.run) || Boolean(state.pending); stop.hidden = !state.run; stop.disabled = !state.run || state.run.cancelled;
    recover.hidden = !state.pending || Boolean(state.run); recover.disabled = state.starting || state.busy;
    resumeOriginal.hidden = !state.lastRun?.canResume || Boolean(state.run) || Boolean(state.pending) || Boolean(state.result); resumeOriginal.disabled = frozen;
    generationOptions.hidden = false;
    sources.replaceChildren();
    if (!base) sources.append(el('div', 'design-empty-source', state.context ? '可导入总平面、现状照片或建筑草图' : '先新建或打开一块白板'));
    if (base) { const card = el('figure', 'design-source base'); card.append(imageNode(base), el('figcaption', '', `原图 · ${base.name}`)); sources.append(card); }
    for (const image of refs) { const card = el('figure', 'design-source reference'), remove = action('移除', () => void perform(async () => { await removeImage(image.elementId); })); remove.disabled = frozen; card.append(imageNode(image), el('figcaption', '', `参考 · ${image.name}`), remove); sources.append(card); }
    for (const asset of state.assets) { const card = el('figure', 'design-source reference'), remove = action('移除', () => void perform(async () => { await api('/api/whiteboards/design/assets', { method: 'DELETE', body: JSON.stringify({ workspace: state.context.workspace, assetId: asset.assetId }) }); state.assets = state.assets.filter(item => item !== asset); })); remove.disabled = frozen; card.append(imageNode(asset.preview), el('figcaption', '', `高清参考 · ${asset.name}`), remove); sources.append(card); }
    modelBadge.textContent = state.configLoaded ? state.config?.configured && modeAvailable() ? '已自动连接平台图像服务' : '图像生成服务暂未开放，请稍后重试。' : '正在连接平台图像服务…';
    status.textContent = state.error || state.phase || (!state.context ? '新建白板后即可导入原图。' : textMode() ? '填写要求即可生成，也可以导入原图或添加参考图。' : !base ? '参考图已上传，可直接生成。' : '原图、勾画和参考图将一起用于生成。'); status.classList.toggle('error', Boolean(state.error)); status.setAttribute('role', state.error ? 'alert' : 'status');
    renderResults();
  }
  function renderResults() {
    resultArea.replaceChildren(); if (!state.result) return;
    resultArea.append(el('h3', '', '04  生成结果'));
    const unchanged = sameBoard(state.result.context, state.context) && state.result.context.canvasVersion === state.context.canvasVersion && state.result.context.baseImageId === (textMode() ? '' : state.baseImageId);
    state.result.images.forEach((image, index) => {
      const figure = el('figure', 'design-result'), controls = el('div', 'design-result-actions'); figure.append(imageNode(image));
      const apply = action(state.result.applied.has(index) ? '已放入画布' : '放入画布', () => void perform(async () => {
        if (!sameBoard(state.result.context, state.context) || state.result.context.canvasVersion !== state.context.canvasVersion) throw new Error('画布已有后续编辑，请先下载结果，或基于当前画布重新生成。');
        const preview = await canvasResult(image);
        const result = await importImage('result', { ...preview, name: `${kind.value === 'architecture' ? '建筑设计' : '城市分析'}生成图` }, state.result.context.baseImageId, `result-${state.result.runId}-${index}`, state.result.context);
        state.result.applied.add(index); state.result.context.canvasVersion = result.canvasVersion; state.phase = result.saved === false ? '结果已放入画布，保存尚未完成，请使用上方恢复选项。' : '结果已放入画布并保存。';
        if (preview !== image) state.phase += ' 画布保存缩小预览，下载按钮保留原尺寸和透明背景。';
      })); apply.disabled = locked() || !unchanged || state.result.applied.has(index);
      const download = action('下载图片', () => downloadImage(image, index)); controls.append(apply, download); figure.append(controls); resultArea.append(figure);
    });
    if (!unchanged) resultArea.append(el('p', 'design-note', '画布已有变化，生成图仍可下载；重新生成可使用当前画布。'));
  }
  function downloadImage(image, index) {
    if (!rasterURL.test(image.dataURL || '')) return;
    const extension = image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType === 'image/webp' ? 'webp' : 'png';
    const anchor = el('a'); anchor.href = image.dataURL; anchor.download = `设计分析图-${index + 1}.${extension}`; anchor.click();
  }
  async function perform(callback) {
    if (state.busy || state.starting || state.run || state.pending || state.leaving) return;
    const generation = state.generation; state.busy = true; state.error = ''; render();
    try { await callback(); } catch (error) { if (generation === state.generation) state.error = error.message || '操作未完成，请重试。'; }
    finally { if (generation === state.generation) { state.busy = false; render(); } }
  }
  for (const [input, role] of [[baseInput, 'base'], [referenceInput, 'reference']]) input.addEventListener('change', () => {
    const file = input.files?.[0]; input.value = ''; if (!file) return;
    const context = state.context, generation = state.generation, baseImageId = state.baseImageId;
    void perform(async () => {
      let asset;
      {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 30 * 1024 * 1024 || !file.size) throw new Error('请选择 30MB 以内的 PNG、JPEG 或 WebP 图片。');
        const dataURL = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败。')); reader.readAsDataURL(file); });
        asset = await api('/api/whiteboards/design/assets', { method: 'POST', body: JSON.stringify({ workspace: context.workspace, image: { dataURL, mimeType: file.type, name: file.name } }) });
      }
      const image = await prepareFile(file);
      if (generation !== state.generation || !sameBoard(context, state.context)) return;
      if (asset && role === 'reference') { state.assets.push({ ...asset, preview: image }); state.result = null; state.phase = '高清参考图已上传，生成时将使用原始文件；临时保留 30 分钟。'; return; }
      const result = await importImage(role, image, role === 'reference' ? baseImageId : undefined, undefined, context);
      if (generation !== state.generation || !sameBoard(context, state.context)) return;
      if (role === 'base') { state.baseImageId = result.imageId; if (asset) state.baseAssets.set(result.imageId, asset); }
      state.result = null; state.phase = result.saved === false ? '图片已加入画布，保存尚未完成，请处理上方保存提示。' : role === 'base' ? '原图已导入并锁定，可以开始勾画。' : '参考图已加入，生成时会与原图一起使用。';
    });
  });
  function start() { if (state.startTask) return state.startTask; const task = executeStart(); state.startTask = task; void task.finally(() => { if (state.startTask === task) state.startTask = null; }); return task; }
  async function executeStart() {
    if (locked() || !state.context || !state.config?.configured || !modeAvailable()) return;
    if (!prompt.value.trim()) { state.error = '请填写你希望绘制的建筑或城市设计要求。'; render(); prompt.focus(); return; }
    const generation = state.generation, baseImageId = textMode() ? '' : state.baseImageId; state.starting = true; state.error = ''; state.phase = '正在保存原图与勾画，准备生成…'; render();
    try {
      const snapshot = await capture(baseImageId);
      if (generation !== state.generation || !sameBoard(snapshot, state.context)) return;
      const requestId = crypto.randomUUID(), context = { ...snapshot, baseImageId };
      const body = { workspace: snapshot.workspace, id: snapshot.id, revision: snapshot.revision, canvasVersion: snapshot.canvasVersion, kind: kind.value, prompt: prompt.value.trim(), baseImageId, annotated: snapshot.annotated, requestId, aspect_ratio: ratio.value, resolution: resolution.value, background: background.value, ...(!textMode() ? { assetIds: state.assets.map(asset => asset.assetId), ...(state.baseAssets.get(baseImageId) ? { baseAssetId: state.baseAssets.get(baseImageId).assetId } : {}) } : {}) };
      rememberRequest(requestId, context);
      state.pending = { requestId, context }; const result = await api('/api/whiteboards/design/start', { method: 'POST', body: JSON.stringify(body) });
      if (!result?.runId) throw new Error('未收到有效的生成任务编号，请查询提交状态。');
      if (generation !== state.generation || !sameBoard(context, state.context)) { await request('stop', { runId: result.runId }, context).catch(() => {}); return; }
      beginRun(result.runId, requestId, context); state.pending = null;
    } catch (error) { if (generation === state.generation) {
      // A transport failure may hide a successfully accepted paid request. A
      // read-only receipt lookup resolves it without resubmitting generation.
      if (error.status && error.status < 500) state.pending = null;
      state.error = error.message || '生成请求未完成，请查询提交状态。'; state.phase = '';
    } }
    finally { if (generation === state.generation) { state.starting = false; render(); } }
  }
  function beginRun(id, requestId, context) { state.result = null; state.error = ''; state.run = { id, requestId, context, cancelled: false }; state.phase = '正在生成设计图…'; render(); void poll(state.generation, state.run); }
  const receiptKey = context => `ccagent-design-request:${encodeURIComponent(context.workspace)}:${context.id}`;
  function rememberRequest(requestId, context) { try { window.localStorage.setItem(receiptKey(context), requestId); } catch { /* Local browser storage is optional; the server retains the receipt. */ } }
  async function restoreSavedRequest(context, generation) {
    let requestId; try { requestId = window.localStorage.getItem(receiptKey(context)); } catch { return; }
    if (!/^[a-f0-9-]{36}$/.test(requestId || '')) return;
    try {
      const data = await api(`/api/whiteboards/design/request?requestId=${encodeURIComponent(requestId)}&workspace=${encodeURIComponent(context.workspace)}`);
      if (generation !== state.generation || !sameBoard(context, state.context) || data.id !== context.id || data.workspace !== context.workspace || data.requestId !== requestId) return;
      const originalContext = { ...context, revision: data.revision, canvasVersion: data.canvasVersion, baseImageId: data.baseImageId };
      if (data.status === 'running' || data.status === 'completed') beginRun(data.runId, requestId, originalContext);
      else if (data.canResume) { state.lastRun = { id: data.runId, requestId, context: originalContext, canResume: true }; state.phase = `可继续查询原图像任务。请求编号：${requestId}`; render(); }
    } catch { /* A receipt from a signed-out account is never displayed or dispatched. */ }
  }
  function resumeOriginalRun() {
    if (state.startTask) return state.startTask;
    const task = executeResumeOriginalRun(); state.startTask = task;
    void task.finally(() => { if (state.startTask === task) state.startTask = null; }); return task;
  }
  async function executeResumeOriginalRun() {
    const original = state.lastRun; if (!original?.canResume || locked()) return;
    const generation = state.generation; state.starting = true; state.error = ''; render();
    try {
      const accepted = await request('resume', { runId: original.id }, original.context);
      if (generation !== state.generation || !sameBoard(original.context, state.context)) { await request('stop', { runId: accepted.runId }, original.context).catch(() => {}); return; }
      beginRun(accepted.runId, original.requestId, original.context);
    } catch (error) { if (generation === state.generation) { state.error = error.message || '原任务暂时无法查询，请稍后重试。'; render(); } }
    finally { if (generation === state.generation) { state.starting = false; render(); } }
  }
  async function recoverRequest() {
    const pending = state.pending; if (!pending || state.starting) return; state.starting = true; state.error = ''; render();
    try { const data = await api(`/api/whiteboards/design/request?requestId=${encodeURIComponent(pending.requestId)}&workspace=${encodeURIComponent(pending.context.workspace)}`); if (state.pending !== pending || !sameBoard(pending.context, state.context)) return; state.pending = null; beginRun(data.runId, pending.requestId, pending.context); }
    catch (error) { if (state.pending === pending) { if (error.status === 404 || error.code === 'not_found') state.pending = null; state.error = error.message || '暂时无法确认提交状态，请稍后再查。'; } }
    finally { state.starting = false; render(); }
  }
  async function poll(generation, run) {
    if (generation !== state.generation || state.run !== run) return;
    try {
      const result = await api(`/api/whiteboards/design/run?runId=${encodeURIComponent(run.id)}&workspace=${encodeURIComponent(run.context.workspace)}`);
      if (generation !== state.generation || state.run !== run) return;
      if (result.runId !== run.id || result.requestId !== run.requestId || result.workspace !== run.context.workspace || result.id !== run.context.id || result.baseImageId !== run.context.baseImageId || result.revision !== run.context.revision || result.canvasVersion !== run.context.canvasVersion) throw Object.assign(new Error('生成结果与当前原图不一致，未修改画布。'), { code: 'result_mismatch' });
      if (result.status === 'running') { state.phase = `${run.cancelled ? '正在停止' : '正在生成设计图'} · 已处理 ${Math.max(0, Math.floor((result.elapsedMs || 0) / 1000))} 秒`; state.timer = setTimeout(() => void poll(generation, run), 1100); render(); return; }
      if (result.status === 'completed' && !run.cancelled && Array.isArray(result.images) && result.images.length && result.images.every(image => rasterURL.test(image.dataURL || ''))) { state.result = { runId: run.id, images: result.images, context: run.context, applied: new Set() }; state.phase = '设计图已生成，可预览、放入画布或下载。'; }
      else if (result.status === 'stopped' || run.cancelled) state.phase = '已停止等待，原图与勾画已保留。供应商可能仍会处理已发出的请求。';
      else if (result.status === 'failed') { state.error = result.error || '图像生成未完成，请稍后查看原任务。'; state.phase = ''; }
      else throw Object.assign(new Error('生成任务返回了无法识别的结果。'), { code: 'invalid_result' });
      state.lastRun = { ...run, canResume: result.canResume === true }; state.run = null;
      if (result.canResume && result.status !== 'completed') state.phase = `${state.phase || ''} 请求编号：${run.requestId}`;
      render();
    } catch (error) { if (generation === state.generation && state.run === run) { state.error = error.message || '读取生成状态失败，将继续重试。'; if (['not_found', 'result_expired', 'result_mismatch', 'invalid_result'].includes(error.code) || [401, 403, 404, 410].includes(error.status)) state.run = null; else state.timer = setTimeout(() => void poll(generation, run), 1600); render(); } }
  }
  async function stopRun() { const run = state.run; if (!run || run.cancelled) return; run.cancelled = true; state.error = ''; state.phase = '正在停止生成…'; render(); try { await request('stop', { runId: run.id }, run.context); } catch (error) { if (state.run === run) { state.error = error.message || '停止请求未确认，返回结果不会放入画布。'; render(); } } }
  async function beforeLeave() {
    state.leaving++; state.generation++; clearTimeout(state.timer); const run = state.run, pending = state.pending; state.run = null; state.pending = null;
    try {
      if (state.startTask) await state.startTask.catch(() => {});
      if (run) await request('stop', { runId: run.id }, run.context).catch(() => toast('生成任务停止状态尚未确认，返回结果不会应用到其他白板。'));
      else if (pending) { try { const found = await api(`/api/whiteboards/design/request?requestId=${encodeURIComponent(pending.requestId)}&workspace=${encodeURIComponent(pending.context.workspace)}`); if (found.runId) await request('stop', { runId: found.runId }, pending.context); } catch { /* No retrying a paid request while leaving. */ } }
    } finally { state.starting = false; state.busy = false; state.leaving--; render(); }
    return true;
  }
  function contextChanged(context) {
    if (!sameBoard(state.context, context)) { void beforeLeave(); state.context = context; state.baseImageId = ''; state.assets = []; state.baseAssets.clear(); state.lastRun = null; state.result = null; state.configLoaded = false; state.config = null; state.error = ''; state.phase = ''; prompt.value = ''; if (context) void restoreSavedRequest(context, state.generation); }
    else state.context = context;
    const bases = (state.context?.images || []).filter(image => image.role === 'base'); if (!bases.some(image => image.elementId === state.baseImageId)) state.baseImageId = bases.at(-1)?.elementId || '';
    render(); if (state.open && state.context && !state.configLoaded) void loadConfig();
  }
  render(); return { contextChanged, beforeLeave, open() { state.open = true; void loadConfig(); render(); }, close() { state.open = false; } };
}
