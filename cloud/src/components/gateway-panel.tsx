'use client';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { RouteTestPanel } from './route-test-panel';
import { GatewayPriceEditor, type GatewayPrice } from './gateway-price-editor';
import { priceDefinition } from '../../../src/platform/pricingDefinition';
import { imageConfigurationOnly, kieImageBaseUrl, kieImageModels } from './kie-image-configuration';
import { KieImageGuide } from './kie-image-guide';

const protocols: Record<string, [string, string][]> = { chat: [['openai-responses', 'Responses'], ['openai-chat', 'Chat Completions']], vision: [['openai-chat', 'Chat Completions'], ['openai-responses', 'Responses']],
  decision: [['jev-decisions', 'Jev Decisions']], search: [['tavily', 'Tavily'], ['bocha', '博查']], voice: [['dashscope-tts', 'Qwen 语音']], image: [['kie-images', 'KIE GPT Image 2.5'], ['openai-images', 'OpenAI Images（待接入）'], ['dashscope-images', 'DashScope 图像生成（待接入）']] };
const services = [['chat', '主模型'], ['vision', '视觉读图'], ['decision', '结构化决策'], ['search', '联网搜索'], ['voice', '语音合成'], ['image', '图像生成']];
const serviceHelp: Record<string, string> = {
  chat: '用于对话与 Agent 任务。上游地址填写 API 基础地址。',
  vision: '用于图片理解与 OCR，请选择具备视觉能力的上游模型。上游地址填写 API 基础地址。',
  decision: '使用 Jev Decisions 结构化决策协议，上游地址填写完整接口地址。',
  search: '支持 Tavily 与博查搜索，上游地址填写完整搜索接口地址，上游模型填写该搜索服务的标识。',
  voice: '使用 Qwen 语音合成协议，填写完整接口地址与供应商语音模型。',
  image: '图像生成执行、计费及连接检测待接入，当前仅可保存暂停的配置与成本元数据。',
};
type Route = { id: string; name: string; service: string; protocol: string; provider: string; baseUrl: string; upstreamModel: string; credentialEnv: string; enabled: boolean; timeoutMs: number; retries: number;
  options: { contextWindow: number; maxOutputTokens: number; maxImages: number; fallbackRouteId: string | null; fallbackEnabled: boolean } };
type CredentialStatus = { configured: boolean; source: 'managed' | 'environment' | 'none' };
type Loaded = { route: Route; updatedAt: string | null; routeFingerprint: string; latestPrice: GatewayPrice | null; credentialStatus: CredentialStatus; ready: boolean };
const blankRoute = (): Route => ({ id: '', name: '', service: 'chat', protocol: 'openai-responses', provider: '', baseUrl: '', upstreamModel: '', credentialEnv: 'CCAGENT_PROVIDER_MANAGED', enabled: false, timeoutMs: 120000, retries: 0,
  options: { contextWindow: 131072, maxOutputTokens: 8192, maxImages: 20, fallbackRouteId: null, fallbackEnabled: false } });
const withKiePreset = (route: Route): Route => ({ ...route, service: 'image', protocol: 'kie-images', provider: 'kie', baseUrl: kieImageBaseUrl,
  upstreamModel: kieImageModels[0][0], credentialEnv: 'CCAGENT_PROVIDER_KIE', enabled: false, timeoutMs: 180000, retries: 0,
  options: { contextWindow: 20000, maxOutputTokens: 1, maxImages: 16, fallbackRouteId: null, fallbackEnabled: false } });
const credentialLabel = (status: CredentialStatus | null) => !status || !status.configured ? '尚未配置 API Key' : status.source === 'managed' ? 'API Key 已在后台安全保存' : '正在使用服务器已有 API Key';
function readLoaded(result: Record<string, unknown>, id: string): Loaded {
  const row = result.route as Route & { updatedAt?: unknown };
  if (!row || row.id !== id || !protocols[row.service] || !row.options) throw new Error('INVALID_ROUTE');
  // Pick public fields explicitly; response additions must never enter a later save payload.
  const route: Route = { id: row.id, name: row.name, service: row.service, protocol: row.protocol, provider: row.provider, baseUrl: row.baseUrl, upstreamModel: row.upstreamModel,
    credentialEnv: row.credentialEnv || 'CCAGENT_PROVIDER_MANAGED', enabled: row.enabled, timeoutMs: row.timeoutMs, retries: row.retries,
    options: { contextWindow: row.options.contextWindow, maxOutputTokens: row.options.maxOutputTokens, maxImages: row.options.maxImages, fallbackRouteId: row.options.fallbackRouteId || null, fallbackEnabled: Boolean(row.options.fallbackEnabled) } };
  const latestPrice = result.latestPrice as GatewayPrice | null;
  if (latestPrice?.components.definition) priceDefinition.parse(latestPrice.components.definition);
  const status = result.credentialStatus as CredentialStatus | undefined;
  return { route, updatedAt: typeof row.updatedAt === 'string' && Number.isFinite(Date.parse(row.updatedAt)) ? row.updatedAt : null, routeFingerprint: typeof result.routeFingerprint === 'string' && /^[a-f0-9]{64}$/.test(result.routeFingerprint) ? result.routeFingerprint : '', latestPrice: latestPrice || null, credentialStatus: status && ['managed', 'environment', 'none'].includes(status.source) ? { configured: Boolean(status.configured), source: status.source } : { configured: Boolean(result.credentialConfigured), source: result.credentialConfigured ? 'environment' : 'none' }, ready: Boolean(result.ready) };
}
function safeSaveError(status: number, code: unknown) {
  if (code === 'ROUTE_DELETED' || status === 410) return '此路由已删除，不能继续编辑或重建同一编号。请刷新列表。';
  if (code === 'ROUTE_ALREADY_EXISTS') return '路由编号已存在，请从列表编辑已有路由，或使用新的编号。';
  if (code === 'ROUTE_CONFIGURATION_CHANGED') return '其他管理员已修改路由，请重新载入最新配置后再保存。';
  if (code === 'PROTOCOL_NOT_READY') return '该协议尚未接入执行与计费，当前只能保存暂停配置。';
  if (code === 'SERVICE_NOT_READY') return '启用前请先保存 API Key、对应成本版本和美元结算汇率。';
  if (code === 'UPSTREAM_HOST_NOT_ALLOWED' || code === 'UPSTREAM_HOST_DENIED') return '上游域名尚未批准，请在本页的允许域名配置中核对。';
  if (status === 401 || status === 403) return '当前账户没有保存路由的权限，请重新登录或联系管理员。';
  if (status === 409) return '路由未保存，请核对成本、备用路由及开放条件后重试。';
  return '路由保存未完成，请核对字段后重试。API Key 已清空，需要时请重新填写。';
}

export function GatewayPanel({ mode, rows, initialRouteId, hideLookup = false, onBusyChange }: { mode: 'routes' | 'prices'; rows: Record<string, unknown>[]; initialRouteId?: string; hideLookup?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const router = useRouter(), listId = useId();
  const [route, setRoute] = useState<Route>(blankRoute), [snapshot, setSnapshot] = useState<Route | null>(null), [price, setPrice] = useState<GatewayPrice | null>(null), [priceRevision, setPriceRevision] = useState(0);
  const [routeFingerprint, setRouteFingerprint] = useState('');
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [routeBusy, setBusy] = useState(false), [priceBusy, setPriceBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(''), [credential, setCredential] = useState<CredentialStatus | null>(null), [removeApiKey, setRemoveApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const busy = routeBusy || priceBusy;
  const keyInput = useRef<HTMLInputElement | null>(null), action = useRef(false), priceAction = useRef(false), generation = useRef(0), activeRequest = useRef<AbortController | null>(null);
  const bindKeyInput = useCallback((node: HTMLInputElement | null) => { if (keyInput.current && keyInput.current !== node) keyInput.current.value = ''; keyInput.current = node; }, []);
  const priceBusyChanged = useCallback((value: boolean) => { priceAction.current = value; setPriceBusy(value); }, []);
  const clearKey = () => { if (keyInput.current) keyInput.current.value = ''; };
  useEffect(() => () => { generation.current++; activeRequest.current?.abort(); action.current = false; clearKey(); }, []);
  // The surrounding inspector may close a read-only load, but stays open while writes are pending.
  useEffect(() => { onBusyChange?.(saving || priceBusy); return () => onBusyChange?.(false); }, [saving, priceBusy, onBusyChange]);
  useEffect(() => {
    if (!initialRouteId) return;
    const operation = begin(); if (!operation) return;
    void (async () => {
      try { const loaded = await fetchRoute(initialRouteId, operation.controller.signal); if (operation.valid()) { applyLoaded(loaded); setMessage('已载入路由，API Key 留空将保留已保存凭据。'); } }
      catch { if (operation.valid()) setError('路由读取未完成，请关闭后重试或刷新列表。'); }
      finally { finish(operation); }
    })();
    return () => { operation.controller.abort(); if (generation.current === operation.current) { generation.current++; action.current = false; } };
  }, [initialRouteId]);
  const change = <K extends keyof Route>(key: K, value: Route[K]) => {
    if (action.current || priceAction.current) return;
    if (key === 'id' || key === 'provider' || key === 'baseUrl' || key === 'upstreamModel' || key === 'protocol') { clearKey(); setRemoveApiKey(false); }
    if (key === 'id') { setSnapshot(null); setUpdatedAt(null); setRouteFingerprint(''); setCredential(null); setPrice(null); setPriceRevision(previous => previous + 1); }
    setRoute(previous => key === 'protocol' && value === 'kie-images' ? withKiePreset(previous)
      : { ...previous, [key]: value, ...(key === 'protocol' && previous.service === 'image' ? { enabled: false } : {}) });
  };
  function begin() {
    if (action.current || priceAction.current) return null;
    action.current = true; clearKey(); setBusy(true); setMessage(''); setError('');
    const current = ++generation.current, controller = new AbortController(); activeRequest.current = controller;
    return { current, controller, valid: () => current === generation.current && !controller.signal.aborted };
  }
  function finish(operation: NonNullable<ReturnType<typeof begin>>) { if (operation.valid()) { action.current = false; setBusy(false); activeRequest.current = null; } }
  function applyLoaded(loaded: Loaded) {
    clearKey(); setRemoveApiKey(false); setRoute(loaded.route); setSnapshot(loaded.route); setUpdatedAt(loaded.updatedAt); setRouteFingerprint(loaded.routeFingerprint); setCredential(loaded.credentialStatus); setPrice(loaded.latestPrice); setPriceRevision(previous => previous + 1);
  }
  async function fetchRoute(id: string, signal: AbortSignal) {
    const response = await fetch(`/api/admin/routes?id=${encodeURIComponent(id)}`, { signal, cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error('LOAD_FAILED');
    return readLoaded(result, id);
  }
  async function load(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = String(new FormData(event.currentTarget).get('routeId') || '').trim(), operation = begin();
    if (!operation) return;
    setRemoveApiKey(false);
    try {
      const loaded = await fetchRoute(id, operation.controller.signal);
      if (!operation.valid()) return;
      applyLoaded(loaded); setMessage(loaded.ready ? '路由已开放，已配置 API Key 与成本。' : '已载入路由，请核对 API Key、成本和开放状态。');
    } catch { if (operation.valid()) setError('路由读取未完成，请核对编号后重试。API Key 已清空。'); }
    finally { finish(operation); }
  }
  function create() {
    if (action.current || priceAction.current) return;
    generation.current++; clearKey(); setRemoveApiKey(false); setRoute(blankRoute()); setSnapshot(null); setUpdatedAt(null); setRouteFingerprint(''); setCredential(null); setPrice(null); setPriceRevision(previous => previous + 1); setMessage('先保存暂停中的路由，再在下方追加成本版本，最后开放服务。'); setError('');
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (action.current || priceAction.current) return;
    if (imageConfigurationOnly(route.service, route.protocol) && route.enabled) { setError(serviceHelp.image); return; }
    // Capture the Key with this exact route, then erase the password input before awaiting.
    const apiKey = keyInput.current?.value || '', savedRoute = { ...route, options: { ...route.options } }, removing = removeApiKey;
    const operation = begin(); if (!operation) return;
    setSaving(true);
    setRemoveApiKey(false);
    try {
      const editing = snapshot?.id === savedRoute.id;
      const payload = { ...savedRoute, ...(editing && updatedAt ? { expectedUpdatedAt: updatedAt } : {}), ...(removing ? { removeApiKey: true } : apiKey ? { apiKey } : {}) };
      const response = await fetch('/api/admin/routes', { method: editing ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: operation.controller.signal });
      const result = await response.json();
      if (!operation.valid()) return;
      if (!response.ok) { setError(safeSaveError(response.status, result.code)); return; }
      setRoute({ ...savedRoute, enabled: Boolean(result.enabled) }); setSnapshot(null); setRouteFingerprint('');
      try {
        const loaded = await fetchRoute(savedRoute.id, operation.controller.signal);
        if (!operation.valid()) return;
        applyLoaded(loaded);
        setMessage(imageConfigurationOnly(savedRoute.service, savedRoute.protocol) ? '图像生成配置已保存并暂停，可在下方追加按张成本；执行、计费及连接检测待接入。' : result.repricingRequired ? '路由已保存并暂停开放。供应商或模型已改变，请在下方创建对应成本版本后再启用。' : removing ? 'API Key 已移除，路由已暂停开放。' : `路由已保存，当前${result.enabled ? '已开放' : '未开放'}。可在下方追加成本版本。`);
      } catch { if (operation.valid()) { setCredential(null); setError('路由已提交，但最新状态读取未完成。请重新载入确认，API Key 无需重复提交。'); } }
      if (operation.valid()) router.refresh();
    } catch { if (operation.valid()) setError('路由保存结果未确认，请先重新载入核对。API Key 已清空。'); }
    finally { clearKey(); if (operation.valid()) setSaving(false); finish(operation); }
  }
  const dirty = !snapshot || JSON.stringify(route) !== JSON.stringify(snapshot), costDisabled = busy || (mode === 'routes' && dirty);
  const configurationOnly = imageConfigurationOnly(route.service, route.protocol), kieImage = route.service === 'image' && route.protocol === 'kie-images';
  return <section className="panel"><h2>{mode === 'routes' ? '编辑服务网关' : '新增成本版本'}</h2>
    {mode === 'routes' && <p>在此配置上游 API Key、地址、模型与价格。新路由先暂停保存，追加成本版本后再开放。</p>}
    <datalist id={listId}>{[...new Set(rows.map(row => String(row.route_id || row.id)))].map(id => <option value={id} key={id} />)}</datalist>
    {!hideLookup && <form className="filters" onSubmit={load}><input name="routeId" list={listId} required placeholder="输入已有路由编号" aria-label="已有路由编号" maxLength={80} disabled={busy} /><button className="button secondary" disabled={busy}>载入配置</button>{mode === 'routes' && <button className="button secondary" type="button" disabled={busy} onClick={create}>新建路由</button>}</form>}
    {mode === 'routes' ? <form className="form-stack" onSubmit={save}>
      <label className="field">路由编号<input value={route.id} onChange={event => change('id', event.target.value)} required pattern="[a-z0-9][a-z0-9._:\-]{0,79}" maxLength={80} disabled={busy || Boolean(snapshot)} /><small>应用使用此编号选择服务，已有路由编号不可修改。</small></label>
      <label className="field">显示名称<input value={route.name} onChange={event => change('name', event.target.value)} required maxLength={100} disabled={busy} /></label>
      <div className="form-row"><label className="field">服务类型<select value={route.service} disabled={busy} onChange={event => { const service = event.target.value; if (!action.current && !priceAction.current) { clearKey(); setRemoveApiKey(false); setRoute(previous => service === 'image' ? withKiePreset(previous) : ({ ...previous, service, protocol: protocols[service][0][0] })); } }}>{services.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><label className="field">供应商协议<select value={route.protocol} disabled={busy} onChange={event => change('protocol', event.target.value)}>{protocols[route.service].map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label></div>
      <p className={route.service === 'image' ? 'notice neutral' : 'small-text'}>{kieImage ? 'KIE GPT Image 2.5 支持文生图、参考图编辑、三档分辨率和透明背景。先保存路由与人民币按张成本，再填写 KIE API Key 并开放。图像生成采用异步任务，可查询原任务与获取结果文件。' : serviceHelp[route.service]}</p>
      <div className="form-row"><label className="field">供应商编号<input value={route.provider} onChange={event => change('provider', event.target.value)} required pattern="[a-z0-9][a-z0-9_\-]{0,49}" disabled={busy} /></label><label className="field">上游模型{kieImage ? <select aria-label="KIE 图像模型" value={route.upstreamModel} onChange={event => change('upstreamModel', event.target.value)} disabled={busy}>{!kieImageModels.some(([id]) => id === route.upstreamModel) && <option value={route.upstreamModel} disabled>请选择 GPT Image 2.5 模型</option>}{kieImageModels.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select> : <input value={route.upstreamModel} onChange={event => change('upstreamModel', event.target.value)} required maxLength={200} disabled={busy} />}</label></div>
      <label className="field">上游地址<input value={route.baseUrl} onChange={event => change('baseUrl', event.target.value)} type="url" required maxLength={500} disabled={busy} /><small>{kieImage ? `KIE API 基础地址：${kieImageBaseUrl}，无需附加 createTask 路径。` : '聊天服务填写 API 基础地址；决策、搜索、语音填写完整接口地址。在本页下方批准额外上游域名。'}</small></label>
      <label className="field">供应商 API Key<input key={route.id} ref={bindKeyInput} type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} maxLength={8192} disabled={busy || removeApiKey} /><small>{credentialLabel(credential)}。留空保留现有 Key；保存后不回显。修改供应商或地址时请重新填写对应 Key。</small></label>
      <div className="field"><label className="route-test-consent"><input type="checkbox" aria-describedby={`${listId}-remove-key-help`} checked={removeApiKey} disabled={busy || !snapshot} onChange={event => { clearKey(); setRemoveApiKey(event.target.checked); }} /><span>明确移除已保存的 API Key</span></label><small id={`${listId}-remove-key-help`}>保存后立即暂停此路由；服务器已有凭据仅显示状态，不会暴露或改写环境配置。</small></div>
      {!kieImage && <div className="form-row"><label className="field">上下文上限（Token）<input type="number" min={128} max={4000000} value={route.options.contextWindow} onChange={event => change('options', { ...route.options, contextWindow: Number(event.target.value) })} required disabled={busy} /></label><label className="field">输出上限（Token）<input type="number" min={1} max={1000000} value={route.options.maxOutputTokens} onChange={event => change('options', { ...route.options, maxOutputTokens: Number(event.target.value) })} required disabled={busy} /></label></div>}
      <div className="form-row"><label className="field">超时（毫秒）<input type="number" min={1000} max={180000} value={route.timeoutMs} onChange={event => change('timeoutMs', Number(event.target.value))} required disabled={busy} /></label><label className="field">内部重试次数<select value={route.retries} onChange={event => change('retries', Number(event.target.value))} disabled={busy || kieImage}>{[0, 1, 2].map(value => <option key={value} value={value}>{value}</option>)}</select><small>{kieImage ? '创建任务不自动重试；结果未确认时查询原任务，避免重复生成和付费。' : '内部重试产生的额外成本由平台承担。'}</small></label></div>
      <label className="field">每次最多图片数<input type="number" min={0} max={kieImage ? 16 : 600} value={route.options.maxImages} onChange={event => change('options', { ...route.options, maxImages: Number(event.target.value) })} required disabled={busy} /></label>
      <label className="field">管理员备用开关<select aria-label="管理员备用开关" aria-describedby="gateway-fallback-help" value={String(Boolean(route.options.fallbackEnabled))} disabled={busy} onChange={event => change('options', { ...route.options, fallbackEnabled: event.target.value === 'true' })}><option value="false">关闭备用</option><option value="true">启用一级备用</option></select><small id="gateway-fallback-help">用户须另外确认主、备用价格才会切换。一次调用共用原超时预算，内部失败成本由平台承担。</small></label>
      <label className="field">备用路由编号<input aria-label="备用路由编号" value={route.options.fallbackRouteId || ''} list={listId} maxLength={80} pattern="[a-z0-9][a-z0-9._:\-]{0,79}" required={Boolean(route.options.fallbackEnabled)} disabled={busy} onChange={event => change('options', { ...route.options, fallbackRouteId: event.target.value || null })} /><small>须为另一条同服务类型、同协议且已开放的路由，不允许循环；不会调用用户的个人供应商 Key。</small></label>
      <label className="field">开放状态<select value={String(route.enabled)} onChange={event => change('enabled', event.target.value === 'true')} disabled={busy || configurationOnly}><option value="false">暂停开放</option><option value="true" disabled={configurationOnly}>开放服务</option></select><small>{configurationOnly ? '此图像协议待接入，当前不可启用或连接检测。' : '启用前校验 API Key、完整公开成本和美元结算汇率。'}</small></label>
      {message && <div className="notice" role="status">{message}</div>}{error && <div className="notice error" role="alert">{error}</div>}
      <div><button className="button" disabled={busy}>{busy ? '正在保存…' : '保存路由'}</button></div>
    </form> : <>
      <label className="field">路由编号<input value={route.id} onChange={event => change('id', event.target.value)} required pattern="[a-z0-9][a-z0-9._:\-]{0,79}" maxLength={80} disabled={busy} /></label>
      {message && <div className="notice" role="status">{message}</div>}{error && <div className="notice error" role="alert">{error}</div>}
    </>}
    {mode === 'routes' && dirty && <p className="notice neutral">先保存当前路由配置，再为这条路由编辑成本版本。</p>}
    {mode === 'prices' && !routeFingerprint && <p className="notice neutral">请先载入目标路由，再为已确认的供应商和模型追加成本版本。</p>}
    <GatewayPriceEditor key={`${route.id}-${route.service}-${route.protocol}-${route.upstreamModel}-${priceRevision}`} routeId={route.id} expectedRouteFingerprint={routeFingerprint} initial={price} service={route.service} protocol={route.protocol} upstreamModel={route.upstreamModel} disabled={costDisabled} showHeading={mode === 'routes'} onSaved={() => router.refresh()} onBusyChange={priceBusyChanged} />
    {configurationOnly && mode === 'prices' && <p className="notice neutral">{serviceHelp.image}</p>}
    {kieImage && <KieImageGuide routeId={route.id} upstreamModel={route.upstreamModel} />}
    {mode === 'routes' && snapshot && !imageConfigurationOnly(snapshot.service, snapshot.protocol) && <RouteTestPanel routeId={snapshot.id} />}
  </section>;
}
