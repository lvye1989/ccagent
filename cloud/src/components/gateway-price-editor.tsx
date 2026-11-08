'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { UsageMetric } from '@/core/catalog';
import { blankQwenTierDraft, qwenTierDefinition, qwenTierDraft, QwenTierEditor } from './qwen-tier-editor';
import { priceDefinition } from '../../../src/platform/pricingDefinition';

const metricNames: Record<UsageMetric, string> = { input_tokens: '未缓存输入 Token', cached_input_tokens: '缓存输入 Token', image_input_tokens: '图片输入 Token', audio_input_tokens: '音频输入 Token',
  video_input_tokens: '视频输入 Token', output_tokens: '输出 Token', audio_output_tokens: '音频输出 Token', search_credits: '搜索 Credit', requests: '请求次数', input_characters: '输入字符' };
const metrics = Object.entries(metricNames);
type Rate = { metric: string; price: string; unitQuantity: string; offPeakPrice?: string };
export type GatewayPrice = { version: number; currency: string; sourceUrl: string; components: { definition?: unknown } };
const blankRates = (): Rate[] => [{ metric: 'input_tokens', price: '', unitQuantity: '1000000' }, { metric: 'cached_input_tokens', price: '', unitQuantity: '1000000' }, { metric: 'output_tokens', price: '', unitQuantity: '1000000' }];
function initialDraft(price: GatewayPrice | null) {
  const definition = price?.components.definition ? priceDefinition.parse(price.components.definition) : null;
  const policy = definition?.tariff;
  return { rates: definition && policy?.kind !== 'qwen-input-tiers' ? definition.rates.filter((rate): rate is typeof rate & { price: string } => 'price' in rate) : blankRates(),
    tierDraft: definition && policy?.kind === 'qwen-input-tiers' ? qwenTierDraft(definition) : blankQwenTierDraft(),
    currency: price?.currency || 'CNY', tariff: policy?.kind || 'constant', sourceUrl: price?.sourceUrl || '',
    holidays: policy?.kind === 'deepseek' ? policy.holidays.join('\n') : '', calendarYear: policy?.kind === 'deepseek' ? policy.calendarYear : new Date().getFullYear(),
    calendarSource: policy?.kind === 'deepseek' ? policy.calendarSourceUrl : '' };
}

/** Reused by the routes workflow and the existing standalone prices page. Remount on route/reload. */
export function GatewayPriceEditor({ routeId, expectedRouteFingerprint, initial, disabled = false, showHeading = true, onSaved, onBusyChange }: { routeId: string; expectedRouteFingerprint: string; initial: GatewayPrice | null; disabled?: boolean; showHeading?: boolean; onSaved: () => void; onBusyChange?: (busy: boolean) => void }) {
  const [draft] = useState(() => initialDraft(initial));
  const [rates, setRates] = useState<Rate[]>(draft.rates), [tierDraft, setTierDraft] = useState(draft.tierDraft);
  const [currency, setCurrency] = useState(draft.currency), [tariff, setTariff] = useState(draft.tariff);
  const [sourceUrl, setSourceUrl] = useState(draft.sourceUrl), [holidays, setHolidays] = useState(draft.holidays), [calendarYear, setCalendarYear] = useState(draft.calendarYear), [calendarSource, setCalendarSource] = useState(draft.calendarSource);
  const [version, setVersion] = useState(initial?.version ?? null), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const request = useRef<AbortController | null>(null), mounted = useRef(true), submitting = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || submitting.current || !routeId || !expectedRouteFingerprint) return;
    submitting.current = true; onBusyChange?.(true); setBusy(true); setMessage(''); setError('');
    const controller = new AbortController(); request.current = controller;
    try {
      const policy = tariff === 'constant' ? { kind: 'constant' } : { kind: 'deepseek', calendarYear, holidays: holidays.split(/[\s,，]+/).filter(Boolean), calendarSourceUrl: calendarSource };
      let definition;
      try { definition = tariff === 'qwen-input-tiers' ? qwenTierDefinition(tierDraft) : priceDefinition.parse({ rates: rates.map(rate => ({ metric: rate.metric, price: rate.price, unitQuantity: rate.unitQuantity, ...(tariff === 'deepseek' ? { offPeakPrice: rate.offPeakPrice || '' } : {}) })), tariff: policy }); }
      catch { setError(tariff === 'qwen-input-tiers' ? '请填写完整单价与计价单位，按升序填写整数 Token 边界，并核对最大思考长度。' : '请核对计价项目、单价、计价单位和价格日历。'); return; }
      const payload = { routeId, expectedRouteFingerprint, currency, sourceUrl, effectiveAt: String(new FormData(event.currentTarget).get('effectiveAt') || '').trim() || new Date().toISOString(), definition };
      const response = await fetch('/api/admin/prices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
      const result = await response.json();
      if (!mounted.current || controller.signal.aborted) return;
      if (!response.ok) { setError(result.code === 'ROUTE_CONFIGURATION_CHANGED' ? '此路由已被其他管理员修改，成本版本未保存。请重新载入路由并核对新模型的价格。' : response.status === 409 ? '成本版本未保存，请先核对并保存路由配置后重试。' : '成本版本未保存，请核对字段后重试。'); return; }
      setVersion(result.version); setMessage(`成本版本 v${result.version} 已追加，历史账单保持原价格快照。可在上方保存开放状态。`); onSaved();
    } catch { if (mounted.current && !controller.signal.aborted) setError('成本版本保存未完成，请重新载入确认后重试。'); }
    finally { submitting.current = false; if (mounted.current && !controller.signal.aborted) { setBusy(false); onBusyChange?.(false); } }
  }
  const locked = disabled || busy || !expectedRouteFingerprint;
  return <section className="form-stack" aria-label="成本版本编辑器">{showHeading && <h3>新增成本版本</h3>}
    <form className="form-stack" onSubmit={save}>
      <div className="notice neutral">当前版本：{version ? `v${version}` : '暂无'}。保存将追加新版本，服务费固定为公开成本 × 1.3。</div>
      <div className="form-row"><label className="field">成本币种<select aria-label="成本币种" value={currency} onChange={event => setCurrency(event.target.value)} disabled={locked}><option value="CNY">人民币 CNY</option><option value="USD">美元 USD</option></select></label><label className="field">价格策略<select aria-label="价格策略" value={tariff} onChange={event => setTariff(event.target.value as typeof tariff)} disabled={locked}><option value="constant">固定单价</option><option value="deepseek">DeepSeek 峰谷价格</option><option value="qwen-input-tiers">Qwen 输入阶梯与思考模式</option></select></label></div>
      {tariff === 'qwen-input-tiers' ? <QwenTierEditor value={tierDraft} onChange={setTierDraft} currency={currency} disabled={locked} /> : <>
        {rates.map((rate, index) => <div className="panel" key={index}><div className="form-row"><label className="field">计价项目<select value={rate.metric} onChange={event => setRates(previous => previous.map((item, i) => i === index ? { ...item, metric: event.target.value } : item))} disabled={locked}>{metrics.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><label className="field">计价单位数量<input value={rate.unitQuantity} inputMode="numeric" pattern="[1-9][0-9]{0,9}" required onChange={event => setRates(previous => previous.map((item, i) => i === index ? { ...item, unitQuantity: event.target.value } : item))} disabled={locked} /></label></div><div className="form-row"><label className="field">{tariff === 'deepseek' ? '高峰' : '公开'}单价（{currency}）<input value={rate.price} inputMode="decimal" required onChange={event => setRates(previous => previous.map((item, i) => i === index ? { ...item, price: event.target.value } : item))} disabled={locked} /></label>{tariff === 'deepseek' && <label className="field">低谷单价（{currency}）<input value={rate.offPeakPrice || ''} inputMode="decimal" required onChange={event => setRates(previous => previous.map((item, i) => i === index ? { ...item, offPeakPrice: event.target.value } : item))} disabled={locked} /></label>}</div><button className="button secondary small" type="button" disabled={locked || rates.length === 1} onClick={() => setRates(previous => previous.filter((_, i) => i !== index))}>移除此项目</button></div>)}
        <div><button className="button secondary" type="button" disabled={locked || rates.length >= 10} onClick={() => setRates(previous => [...previous, { metric: 'requests', price: '', unitQuantity: '1' }])}>增加计价项目</button></div>
      </>}
      {tariff === 'deepseek' && <><label className="field">价格日历年份<input type="number" min={2026} max={2100} value={calendarYear} onChange={event => setCalendarYear(Number(event.target.value))} required disabled={locked} /></label><label className="field">法定假期日期<textarea value={holidays} onChange={event => setHolidays(event.target.value)} placeholder="每行一个日期，如 2026-10-01" disabled={locked} /><small>按公开价格中的北京时间规则，周末全天低谷。</small></label><label className="field">官方假期来源<input type="url" value={calendarSource} onChange={event => setCalendarSource(event.target.value)} required disabled={locked} /></label></>}
      <label className="field">供应商公开价格来源<input type="url" value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} required maxLength={500} disabled={locked} /></label>
      <label className="field">生效时间（留空表示保存时生效）<input name="effectiveAt" placeholder="如 2026-11-07T00:00:00+08:00" disabled={locked} /><small>指定时间时，请使用含时区的 ISO 8601 格式。</small></label>
      {message && <div className="notice" role="status">{message}</div>}{error && <div className="notice error" role="alert">{error}</div>}
      <div><button className="button" disabled={locked || !routeId}>{busy ? '正在保存…' : '追加成本版本'}</button></div>
    </form>
  </section>;
}
