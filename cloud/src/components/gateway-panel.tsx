'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

const protocols: Record<string, [string, string][]> = { chat: [['openai-responses', 'Responses'], ['openai-chat', 'Chat Completions']], vision: [['openai-chat', 'Chat Completions'], ['openai-responses', 'Responses']],
  decision: [['jev-decisions', 'Jev Decisions']], search: [['tavily', 'Tavily'], ['bocha', '博查']], voice: [['dashscope-tts', 'Qwen 语音']] };
const services = [['chat', '主模型'], ['vision', '视觉读图'], ['decision', '结构化决策'], ['search', '联网搜索'], ['voice', '语音合成']];
const metrics = [['input_tokens', '未缓存输入 Token'], ['cached_input_tokens', '缓存输入 Token'], ['output_tokens', '输出 Token'], ['search_credits', '搜索 Credit'], ['requests', '请求次数'], ['input_characters', '输入字符']];
type Route = { id: string; name: string; service: string; protocol: string; provider: string; baseUrl: string; upstreamModel: string; credentialEnv: string; enabled: boolean; timeoutMs: number; retries: number;
  options: { contextWindow: number; maxOutputTokens: number; maxImages: number; fallbackRouteId: string | null } };
type Rate = { metric: string; price: string; unitQuantity: string; offPeakPrice?: string };
const blankRoute = (): Route => ({ id: '', name: '', service: 'chat', protocol: 'openai-responses', provider: '', baseUrl: '', upstreamModel: '', credentialEnv: 'CCAGENT_PROVIDER_', enabled: false, timeoutMs: 120000, retries: 0,
  options: { contextWindow: 131072, maxOutputTokens: 8192, maxImages: 20, fallbackRouteId: null } });
const blankRates = (): Rate[] => [{ metric: 'input_tokens', price: '', unitQuantity: '1000000' }, { metric: 'cached_input_tokens', price: '', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '', unitQuantity: '1000000' }];

export function GatewayPanel({ mode, rows }: { mode: 'routes' | 'prices'; rows: Record<string, unknown>[] }) {
  const router = useRouter();
  const [route, setRoute] = useState<Route>(blankRoute), [rates, setRates] = useState<Rate[]>(blankRates), [currency, setCurrency] = useState('CNY'), [tariff, setTariff] = useState('constant');
  const [sourceUrl, setSourceUrl] = useState(''), [holidays, setHolidays] = useState(''), [calendarYear, setCalendarYear] = useState(new Date().getFullYear()), [calendarSource, setCalendarSource] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(''), [configured, setConfigured] = useState<boolean | null>(null), [version, setVersion] = useState<number | null>(null);
  const change = <K extends keyof Route>(key: K, value: Route[K]) => setRoute(previous => ({ ...previous, [key]: value }));
  async function load(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(''); setError('');
    const id = String(new FormData(event.currentTarget).get('routeId') || '');
    try {
      const response = await fetch(`/api/admin/routes?id=${encodeURIComponent(id)}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || '路由读取失败。');
      const { createdAt: _created, updatedAt: _updated, ...loaded } = result.route as Route & { createdAt: string; updatedAt: string };
      setRoute(loaded); setConfigured(Boolean(result.credentialConfigured)); setVersion(result.latestPrice?.version ?? null);
      const latest = result.latestPrice;
      if (latest?.components?.definition) {
        setRates(latest.components.definition.rates); setCurrency(latest.currency); setSourceUrl(latest.sourceUrl);
        const policy = latest.components.definition.tariff;
        setTariff(policy.kind); setHolidays((policy.holidays || []).join('\n')); setCalendarYear(policy.calendarYear || new Date().getFullYear()); setCalendarSource(policy.calendarSourceUrl || '');
      } else { setRates(blankRates()); setTariff('constant'); setSourceUrl(''); setCurrency('CNY'); }
      setMessage(result.ready ? '路由已开放，服务器已配置凭据与成本。' : '已载入路由，请核对凭据、成本和开放状态。');
    } catch (error) { setError(error instanceof Error ? error.message : '读取失败。'); }
    finally { setBusy(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(''); setError('');
    try {
      const policy = tariff === 'constant' ? { kind: 'constant' } : { kind: 'deepseek', calendarYear, holidays: holidays.split(/[\s,，]+/).filter(Boolean), calendarSourceUrl: calendarSource };
      const payload = mode === 'routes' ? route : { routeId: route.id, currency, sourceUrl, effectiveAt: String(new FormData(event.currentTarget).get('effectiveAt') || '').trim() || new Date().toISOString(),
        definition: { rates: rates.map(rate => ({ metric: rate.metric, price: rate.price, unitQuantity: rate.unitQuantity, ...(tariff === 'deepseek' ? { offPeakPrice: rate.offPeakPrice || '' } : {}) })), tariff: policy } };
      const response = await fetch(mode === 'routes' ? '/api/admin/routes' : '/api/admin/prices', { method: mode === 'routes' ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || '保存失败，请核对字段。');
      if (mode === 'routes') {
        change('enabled', Boolean(result.enabled));
        setMessage(result.repricingRequired ? '路由已保存并暂停开放。供应商或模型已改变，请创建对应成本版本后再启用。' : `路由已保存，当前${result.enabled ? '已开放' : '未开放'}。`);
      } else { setVersion(result.version); setMessage(`成本版本 v${result.version} 已追加，历史账单保持原价格快照。`); }
      router.refresh();
    } catch (error) { setError(error instanceof Error ? error.message : '保存未完成。'); }
    finally { setBusy(false); }
  }
  return <section className="panel"><h2>{mode === 'routes' ? '编辑服务网关' : '新增成本版本'}</h2>
    <form className="filters" onSubmit={load}><input name="routeId" list="gateway-route-ids" required placeholder="输入已有路由编号" aria-label="已有路由编号" maxLength={80} disabled={busy} /><datalist id="gateway-route-ids">{[...new Set(rows.map(row => String(row.route_id || row.id)))].map(id => <option value={id} key={id} />)}</datalist><button className="button secondary" disabled={busy}>载入配置</button>{mode === 'routes' && <button className="button secondary" type="button" disabled={busy} onClick={() => { setRoute(blankRoute()); setConfigured(null); setVersion(null); setMessage('请填写新路由配置。'); setError(''); }}>新建路由</button>}</form>
    <form className="form-stack" onSubmit={save}>
      <label className="field">路由编号<input value={route.id} onChange={event => change('id', event.target.value)} required pattern="[a-z0-9][a-z0-9._:\-]{0,79}" maxLength={80} disabled={busy} /><small>应用使用此编号选择服务。</small></label>
      {mode === 'routes' ? <>
        <label className="field">显示名称<input value={route.name} onChange={event => change('name', event.target.value)} required maxLength={100} disabled={busy} /></label>
        <div className="form-row"><label className="field">服务类型<select value={route.service} disabled={busy} onChange={event => { const service = event.target.value; setRoute(previous => ({ ...previous, service, protocol: protocols[service][0][0] })); }}>{services.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><label className="field">供应商协议<select value={route.protocol} disabled={busy} onChange={event => change('protocol', event.target.value)}>{protocols[route.service].map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label></div>
        <div className="form-row"><label className="field">供应商编号<input value={route.provider} onChange={event => change('provider', event.target.value)} required pattern="[a-z0-9][a-z0-9_\-]{0,49}" disabled={busy} /></label><label className="field">上游模型<input value={route.upstreamModel} onChange={event => change('upstreamModel', event.target.value)} required maxLength={200} disabled={busy} /></label></div>
        <label className="field">上游地址<input value={route.baseUrl} onChange={event => change('baseUrl', event.target.value)} type="url" required maxLength={500} disabled={busy} /><small>聊天服务填写 API 基础地址；决策、搜索、语音填写完整接口地址。主机需经服务器允许。</small></label>
        <label className="field">供应商凭据配置名<input value={route.credentialEnv} onChange={event => { change('credentialEnv', event.target.value); setConfigured(null); }} required pattern="CCAGENT_PROVIDER_[A-Z0-9_]{1,64}" disabled={busy} /><small>{configured === null ? '填写服务器上的凭据配置名。密钥本身通过安全环境配置维护。' : configured ? '服务器已配置此凭据。' : '服务器尚未配置此凭据。'}</small></label>
        <div className="form-row"><label className="field">上下文上限（Token）<input type="number" min={128} max={4000000} value={route.options.contextWindow} onChange={event => change('options', { ...route.options, contextWindow: Number(event.target.value) })} required disabled={busy} /></label><label className="field">输出上限（Token）<input type="number" min={1} max={1000000} value={route.options.maxOutputTokens} onChange={event => change('options', { ...route.options, maxOutputTokens: Number(event.target.value) })} required disabled={busy} /></label></div>
        <div className="form-row"><label className="field">超时（毫秒）<input type="number" min={1000} max={180000} value={route.timeoutMs} onChange={event => change('timeoutMs', Number(event.target.value))} required disabled={busy} /></label><label className="field">内部重试次数<select value={route.retries} onChange={event => change('retries', Number(event.target.value))} disabled={busy}>{[0, 1, 2].map(value => <option key={value} value={value}>{value}</option>)}</select><small>内部重试产生的额外成本由平台承担。</small></label></div>
        <label className="field">每次最多图片数<input type="number" min={0} max={600} value={route.options.maxImages} onChange={event => change('options', { ...route.options, maxImages: Number(event.target.value) })} required disabled={busy} /></label>
        <label className="field">开放状态<select value={String(route.enabled)} onChange={event => change('enabled', event.target.value === 'true')} disabled={busy}><option value="false">暂停开放</option><option value="true">开放服务</option></select><small>启用前校验凭据、完整公开成本和美元结算汇率。</small></label>
      </> : <>
        <div className="notice neutral">当前版本：{version ? `v${version}` : '尚未载入'}。保存将追加新版本，服务费固定为公开成本 × 1.3。</div>
        <div className="form-row"><label className="field">成本币种<select value={currency} onChange={event => setCurrency(event.target.value)} disabled={busy}><option value="CNY">人民币 CNY</option><option value="USD">美元 USD</option></select></label><label className="field">价格策略<select value={tariff} onChange={event => setTariff(event.target.value)} disabled={busy}><option value="constant">固定单价</option><option value="deepseek">DeepSeek 峰谷价格</option></select></label></div>
        {rates.map((rate, index) => <div className="panel" key={index}><div className="form-row"><label className="field">计价项目<select value={rate.metric} onChange={event => setRates(previous => previous.map((item, i) => i === index ? { ...item, metric: event.target.value } : item))} disabled={busy}>{metrics.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><label className="field">计价单位数量<input value={rate.unitQuantity} inputMode="numeric" pattern="[1-9][0-9]{0,9}" required onChange={event => setRates(previous => previous.map((item, i) => i === index ? { ...item, unitQuantity: event.target.value } : item))} disabled={busy} /></label></div><div className="form-row"><label className="field">{tariff === 'deepseek' ? '高峰' : '公开'}单价（{currency}）<input value={rate.price} inputMode="decimal" required onChange={event => setRates(previous => previous.map((item, i) => i === index ? { ...item, price: event.target.value } : item))} disabled={busy} /></label>{tariff === 'deepseek' && <label className="field">低谷单价（{currency}）<input value={rate.offPeakPrice || ''} inputMode="decimal" required onChange={event => setRates(previous => previous.map((item, i) => i === index ? { ...item, offPeakPrice: event.target.value } : item))} disabled={busy} /></label>}</div><button className="button secondary small" type="button" disabled={busy || rates.length === 1} onClick={() => setRates(previous => previous.filter((_, i) => i !== index))}>移除此项目</button></div>)}
        <div><button className="button secondary" type="button" disabled={busy || rates.length >= 10} onClick={() => setRates(previous => [...previous, { metric: 'requests', price: '', unitQuantity: '1' }])}>增加计价项目</button></div>
        {tariff === 'deepseek' && <><label className="field">价格日历年份<input type="number" min={2026} max={2100} value={calendarYear} onChange={event => setCalendarYear(Number(event.target.value))} required disabled={busy} /></label><label className="field">法定假期日期<textarea value={holidays} onChange={event => setHolidays(event.target.value)} placeholder="每行一个日期，如 2026-10-01" disabled={busy} /><small>按公开价格中的北京时间规则，周末全天低谷。</small></label><label className="field">官方假期来源<input type="url" value={calendarSource} onChange={event => setCalendarSource(event.target.value)} required disabled={busy} /></label></>}
        <label className="field">供应商公开价格来源<input type="url" value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} required maxLength={500} disabled={busy} /></label>
        <label className="field">生效时间（留空表示保存时生效）<input name="effectiveAt" placeholder="如 2026-11-07T00:00:00+08:00" disabled={busy} /><small>指定时间时，请使用含时区的 ISO 8601 格式。</small></label>
      </>}
      {message && <div className="notice" role="status">{message}</div>}{error && <div className="notice error" role="alert">{error}</div>}
      <div><button className="button" disabled={busy}>{busy ? '正在保存…' : mode === 'routes' ? '保存路由' : '追加成本版本'}</button></div>
    </form>
  </section>;
}
