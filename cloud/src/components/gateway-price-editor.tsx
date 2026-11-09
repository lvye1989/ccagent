'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { UsageMetric } from '@/core/catalog';
import { blankQwenTierDraft, qwenTierDefinition, qwenTierDraft, QwenTierEditor } from './qwen-tier-editor';
import { priceDefinition } from '../../../src/platform/pricingDefinition';
import { imageConfigurationOnly, kieImageCnyRates, kieImageMetrics, kieImagePriceSource } from './kie-image-configuration';

const metricNames: Record<UsageMetric, string> = { input_tokens: '未缓存输入 Token', cached_input_tokens: '缓存输入 Token', image_input_tokens: '图片输入 Token', audio_input_tokens: '音频输入 Token',
  video_input_tokens: '视频输入 Token', input_images: '输入图片（张）', output_tokens: '输出 Token', audio_output_tokens: '音频输出 Token', output_images: '输出图片（张）', output_images_1k: '1K 输出图片（张）', output_images_2k: '2K 输出图片（张）', output_images_4k: '4K 输出图片（张）', search_credits: '搜索 Credit', requests: '请求次数', input_characters: '输入字符' };
const metrics = Object.entries(metricNames);
type Rate = { metric: string; price: string; unitQuantity: string; offPeakPrice?: string };
export type GatewayPrice = { version: number; currency: string; sourceUrl: string; components: { definition?: unknown } };
type PriceContext = { service?: string; protocol?: string; upstreamModel?: string };
function blankRates({ service, protocol, upstreamModel }: PriceContext): Rate[] {
  if (protocol === 'kie-images') return kieImageMetrics.map(metric => ({ metric, price: '', unitQuantity: '1' }));
  const imageRates: [UsageMetric, string][] = upstreamModel === 'qwen-image-3.0' ? [['input_images', '1'], ['output_images', '1']] : [['output_images', '1']];
  const selected: [UsageMetric, string][] = service === 'image' || protocol === 'openai-images' || protocol === 'dashscope-images' ? imageRates
    : protocol === 'tavily' ? [['search_credits', '1']] : protocol === 'bocha' ? [['requests', '1']]
      : service === 'voice' || service === 'decision' || protocol === 'dashscope-tts' || protocol === 'jev-decisions' ? [['input_tokens', '1000000'], ['output_tokens', '1000000']]
        : [['input_tokens', '1000000'], ['cached_input_tokens', '1000000'], ['output_tokens', '1000000']];
  return selected.map(([metric, unitQuantity]) => ({ metric, price: '', unitQuantity }));
}
function initialDraft(price: GatewayPrice | null, context: PriceContext) {
  const definition = price?.components.definition ? priceDefinition.parse(price.components.definition) : null;
  const policy = definition?.tariff;
  return { rates: definition && policy?.kind !== 'qwen-input-tiers' ? definition.rates.filter((rate): rate is typeof rate & { price: string } => 'price' in rate) : blankRates(context),
    tierDraft: definition && policy?.kind === 'qwen-input-tiers' ? qwenTierDraft(definition) : blankQwenTierDraft(),
    currency: price?.currency || 'CNY', tariff: policy?.kind || 'constant', sourceUrl: price?.sourceUrl || (context.protocol === 'kie-images' ? kieImagePriceSource : ''),
    holidays: policy?.kind === 'deepseek' ? policy.holidays.join('\n') : '', calendarYear: policy?.kind === 'deepseek' ? policy.calendarYear : new Date().getFullYear(),
    calendarSource: policy?.kind === 'deepseek' ? policy.calendarSourceUrl : '' };
}

/** Reused by the routes workflow and the existing standalone prices page. Remount on route/reload. */
export function GatewayPriceEditor({ routeId, expectedRouteFingerprint, initial, service, protocol, upstreamModel, disabled = false, showHeading = true, onSaved, onBusyChange }: { routeId: string; expectedRouteFingerprint: string; initial: GatewayPrice | null; disabled?: boolean; showHeading?: boolean; onSaved: () => void; onBusyChange?: (busy: boolean) => void } & PriceContext) {
  const [draft] = useState(() => initialDraft(initial, { service, protocol, upstreamModel }));
  const imageConfiguration = imageConfigurationOnly(service, protocol), kieImage = protocol === 'kie-images';
  const tokenVoice = protocol === 'dashscope-tts' && upstreamModel === 'qwen-audio-3.1-tts-flash';
  const [rates, setRates] = useState<Rate[]>(draft.rates), [tierDraft, setTierDraft] = useState(draft.tierDraft);
  const [currency, setCurrency] = useState(draft.currency), [tariff, setTariff] = useState(draft.tariff);
  const [sourceUrl, setSourceUrl] = useState(draft.sourceUrl), [holidays, setHolidays] = useState(draft.holidays), [calendarYear, setCalendarYear] = useState(draft.calendarYear), [calendarSource, setCalendarSource] = useState(draft.calendarSource);
  const [version, setVersion] = useState(initial?.version ?? null), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [fxBusy, setFxBusy] = useState(kieImage && !initial && Boolean(expectedRouteFingerprint)), [fxNote, setFxNote] = useState('');
  const request = useRef<AbortController | null>(null), mounted = useRef(true), submitting = useRef(false);
  const fxRequest = useRef<AbortController | null>(null), fxLoading = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); fxRequest.current?.abort(); fxLoading.current = false; }; }, []);
  useEffect(() => { if (kieImage && !initial && expectedRouteFingerprint) void fillCnyPrices(); }, [kieImage, Boolean(initial), expectedRouteFingerprint]);
  async function fillCnyPrices() {
    if (submitting.current || fxLoading.current) return;
    fxLoading.current = true; setFxBusy(true); setFxNote('正在读取后台默认汇率…');
    const controller = new AbortController(); fxRequest.current = controller;
    try {
      const response = await fetch('/api/admin/routes/config', { signal: controller.signal, cache: 'no-store' });
      const config = await response.json();
      if (!response.ok || typeof config.usdCny !== 'string') throw new Error('FX_UNAVAILABLE');
      const converted = kieImageCnyRates(config.usdCny);
      if (!mounted.current || controller.signal.aborted) return;
      setRates(converted); setCurrency('CNY'); setTariff('constant'); setSourceUrl(kieImagePriceSource);
      setFxNote(`已按后台默认汇率 ${config.usdCny} 元/美元填入 1K、2K、4K 每张人民币公开成本，尚未保存。`);
    } catch { if (mounted.current && !controller.signal.aborted) setFxNote('默认汇率读取未完成，请先核对后台汇率后重新填入；未猜测或修改单价。'); }
    finally { if (fxRequest.current === controller) { fxLoading.current = false; if (mounted.current && !controller.signal.aborted) setFxBusy(false); } }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || submitting.current || fxLoading.current || !routeId || !expectedRouteFingerprint) return;
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
      setVersion(result.version); setMessage(imageConfiguration ? `成本版本 v${result.version} 已追加，仅保存图像成本配置；执行、计费及连接检测仍待接入。` : `成本版本 v${result.version} 已追加，历史账单保持原价格快照。可在上方保存开放状态。`); onSaved();
    } catch { if (mounted.current && !controller.signal.aborted) setError('成本版本保存未完成，请重新载入确认后重试。'); }
    finally { submitting.current = false; if (mounted.current && !controller.signal.aborted) { setBusy(false); onBusyChange?.(false); } }
  }
  const locked = disabled || busy || fxBusy || !expectedRouteFingerprint;
  return <section className="form-stack" aria-label="成本版本编辑器">{showHeading && <h3>新增成本版本</h3>}
    <form className="form-stack" onSubmit={save}>
      <div className="notice neutral">当前版本：{version ? `v${version}` : '暂无'}。保存将追加新版本，服务费固定为公开成本 × 1.3。</div>
      {imageConfiguration && <p className="notice neutral">图像生成可按输入、输出图片张数保存成本配置，执行、计费及连接检测待接入，当前不可开放。</p>}
      {kieImage && <div className="notice neutral"><p>KIE GPT Image 2.5 按输出图片分辨率计费，每次只计实际输出分辨率的一项，其余两项为零。文生图与图生图、Flare 与 Sunburst 同价；1K / 2K / 4K 公开成本分别为 0.03 / 0.05 / 0.08 美元每张，不按 Token 计费。</p><button type="button" className="button secondary" disabled={locked} onClick={() => void fillCnyPrices()}>按后台默认汇率填入人民币单价</button>{fxNote && <p role="status">{fxNote}</p>}</div>}
      {tokenVoice && <p className="small-text">此语音模型的输入 Token 对应文本，输出 Token 对应合成音频；请分别填写供应商的文本输入与音频输出单价。</p>}
      <div className="form-row"><label className="field">成本币种<select aria-label="成本币种" value={currency} onChange={event => setCurrency(event.target.value)} disabled={locked}><option value="CNY">人民币 CNY</option><option value="USD">美元 USD</option></select></label><label className="field">价格策略<select aria-label="价格策略" value={tariff} onChange={event => setTariff(event.target.value as typeof tariff)} disabled={locked || kieImage}><option value="constant">固定单价</option><option value="deepseek">DeepSeek 峰谷价格</option><option value="qwen-input-tiers">Qwen 输入阶梯与思考模式</option></select></label></div>
      {tariff === 'qwen-input-tiers' ? <QwenTierEditor value={tierDraft} onChange={setTierDraft} currency={currency} disabled={locked} /> : <>
        {rates.map((rate, index) => <div className="panel" key={index}><div className="form-row"><label className="field">计价项目<select value={rate.metric} onChange={event => setRates(previous => previous.map((item, i) => i === index ? { ...item, metric: event.target.value } : item))} disabled={locked || kieImage}>{metrics.filter(([value]) => !kieImage || kieImageMetrics.some(metric => metric === value)).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><label className="field">计价单位数量<input value={rate.unitQuantity} inputMode="numeric" pattern="[1-9][0-9]{0,9}" required onChange={event => setRates(previous => previous.map((item, i) => i === index ? { ...item, unitQuantity: event.target.value } : item))} disabled={locked || kieImage} /></label></div><div className="form-row"><label className="field">{tariff === 'deepseek' ? '高峰' : '公开'}单价（{currency}）<input value={rate.price} inputMode="decimal" required onChange={event => setRates(previous => previous.map((item, i) => i === index ? { ...item, price: event.target.value } : item))} disabled={locked} /></label>{tariff === 'deepseek' && <label className="field">低谷单价（{currency}）<input value={rate.offPeakPrice || ''} inputMode="decimal" required onChange={event => setRates(previous => previous.map((item, i) => i === index ? { ...item, offPeakPrice: event.target.value } : item))} disabled={locked} /></label>}</div><button className="button secondary small" type="button" disabled={locked || kieImage || rates.length === 1} onClick={() => setRates(previous => previous.filter((_, i) => i !== index))}>移除此项目</button></div>)}
        <div><button className="button secondary" type="button" disabled={locked || kieImage || rates.length >= 10} onClick={() => setRates(previous => [...previous, { metric: 'requests', price: '', unitQuantity: '1' }])}>增加计价项目</button></div>
      </>}
      {tariff === 'deepseek' && <><label className="field">价格日历年份<input type="number" min={2026} max={2100} value={calendarYear} onChange={event => setCalendarYear(Number(event.target.value))} required disabled={locked} /></label><label className="field">法定假期日期<textarea value={holidays} onChange={event => setHolidays(event.target.value)} placeholder="每行一个日期，如 2026-10-01" disabled={locked} /><small>按公开价格中的北京时间规则，周末全天低谷。</small></label><label className="field">官方假期来源<input type="url" value={calendarSource} onChange={event => setCalendarSource(event.target.value)} required disabled={locked} /></label></>}
      <label className="field">供应商公开价格来源<input type="url" value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} required maxLength={500} disabled={locked} /></label>
      <label className="field">生效时间（留空表示保存时生效）<input name="effectiveAt" placeholder="如 2026-11-07T00:00:00+08:00" disabled={locked} /><small>指定时间时，请使用含时区的 ISO 8601 格式。</small></label>
      {message && <div className="notice" role="status">{message}</div>}{error && <div className="notice error" role="alert">{error}</div>}
      <div><button className="button" disabled={locked || !routeId}>{busy ? '正在保存…' : '追加成本版本'}</button></div>
    </form>
  </section>;
}
