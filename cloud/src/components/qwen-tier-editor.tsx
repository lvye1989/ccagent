'use client';
import { useId, useRef } from 'react';
import { priceDefinition, type PriceDefinition } from '../../../src/platform/pricingDefinition';

const metrics = ['input_tokens', 'cached_input_tokens', 'output_tokens'] as const;
const names = { input_tokens: '未缓存输入', cached_input_tokens: '缓存输入', output_tokens: '非思考输出' };
type Row = { key: string; limit: string; input_tokens: string; cached_input_tokens: string; output_tokens: string; thinkingPrice: string };
export type QwenTierDraft = { defaultThinking: boolean; maxThinkingTokens: string; units: Record<typeof metrics[number], string>; rows: Row[] };
const blankRow = (key: string): Row => ({ key, limit: '', input_tokens: '', cached_input_tokens: '', output_tokens: '', thinkingPrice: '' });
export const blankQwenTierDraft = (): QwenTierDraft => ({ defaultThinking: false, maxThinkingTokens: '', units: { input_tokens: '1000000', cached_input_tokens: '1000000', output_tokens: '1000000' }, rows: [blankRow('initial')] });
export function qwenTierDraft(definition: PriceDefinition): QwenTierDraft {
  if (definition.tariff.kind !== 'qwen-input-tiers') return blankQwenTierDraft();
  const rates = metrics.map(metric => definition.rates.find(rate => rate.metric === metric)!);
  if (rates.some(rate => !('tiers' in rate))) throw new Error('输入阶梯价格配置无效。');
  const first = rates[0]!;
  if (!('tiers' in first)) throw new Error('输入阶梯价格配置无效。');
  return { defaultThinking: definition.tariff.defaultThinking, maxThinkingTokens: String(definition.tariff.maxThinkingTokens),
    units: Object.fromEntries(rates.map(rate => [rate.metric, rate.unitQuantity])) as QwenTierDraft['units'],
    rows: first.tiers.map((tier, index) => ({ key: `loaded-${index}`, limit: String(tier.upToInputTokens),
      ...Object.fromEntries(rates.map(rate => [rate.metric, 'tiers' in rate ? rate.tiers[index]!.price : ''])),
      thinkingPrice: 'tiers' in rates[2]! ? rates[2].tiers[index]!.thinkingPrice! : '',
    }) as Row) };
}
export function qwenTierDefinition(draft: QwenTierDraft): PriceDefinition {
  const result = priceDefinition.safeParse({ tariff: { kind: 'qwen-input-tiers', defaultThinking: draft.defaultThinking, maxThinkingTokens: Number(draft.maxThinkingTokens) },
    rates: metrics.map(metric => ({ metric, unitQuantity: draft.units[metric], tiers: draft.rows.map(row => ({ upToInputTokens: Number(row.limit), price: row[metric], ...(metric === 'output_tokens' ? { thinkingPrice: row.thinkingPrice } : {}) })) })) });
  if (!result.success) throw new Error('请填写完整单价与计价单位，按升序填写整数 Token 边界，并核对最大思考长度。');
  return result.data;
}

export function QwenTierEditor({ value, onChange, currency, disabled }: { value: QwenTierDraft; onChange: (value: QwenTierDraft) => void; currency: string; disabled: boolean }) {
  const next = useRef(0);
  const id = useId();
  const changeRow = (key: string, field: keyof Omit<Row, 'key'>, text: string) => onChange({ ...value, rows: value.rows.map(row => row.key === key ? { ...row, [field]: text } : row) });
  return <div className="form-stack">
    <p>按整次请求的输入总 Token（含缓存）选一档，输入和全部输出均按该档计费，不逐段累进。请按实际部署的官方规则填写，零价也须明确填写。</p>
    <div className="form-row"><label className="field">默认思考模式<select aria-label="默认思考模式" value={String(value.defaultThinking)} disabled={disabled} onChange={event => onChange({ ...value, defaultThinking: event.target.value === 'true' })}><option value="false">关闭思考</option><option value="true">开启思考</option></select></label>
      <label className="field">供应商最大思考长度（Token）<input aria-label="供应商最大思考长度（Token）" aria-describedby={`${id}-thinking-help`} value={value.maxThinkingTokens} type="number" min={1} max={4000000} step={1} required disabled={disabled} onChange={event => onChange({ ...value, maxThinkingTokens: event.target.value })} /><small id={`${id}-thinking-help`}>填写所选模型的公开上限，用于授权预算；不会据此缩短模型思考。</small></label></div>
    <div className="form-row">{metrics.map(metric => <label className="field" key={metric}>{names[metric]}计价单位（Token）<input inputMode="numeric" pattern="[1-9][0-9]{0,9}" value={value.units[metric]} required disabled={disabled} onChange={event => onChange({ ...value, units: { ...value.units, [metric]: event.target.value } })} /></label>)}</div>
    {value.rows.map((row, index) => <fieldset className="panel form-stack" key={row.key} disabled={disabled}><legend>输入档位 {index + 1}</legend>
      <label className="field">本档输入总 Token 上限（含本数）<input aria-label="本档输入总 Token 上限（含本数）" aria-describedby={`${id}-${row.key}-limit-help`} type="number" min={1} max={4000000} step={1} value={row.limit} required onChange={event => changeRow(row.key, 'limit', event.target.value)} /><small id={`${id}-${row.key}-limit-help`}>{index ? `大于上一档 ${value.rows[index - 1]!.limit || '待填写'} Token；` : '从输入起点至本档上限；'}最后一档须覆盖路由完整上下文。填写整数 Token 数，勿直接填写 K 或 M。</small></label>
      <div className="form-row">{metrics.map(metric => <label className="field" key={metric}>{names[metric]}单价（{currency}）<input inputMode="decimal" value={row[metric]} required onChange={event => changeRow(row.key, metric, event.target.value)} /></label>)}
        <label className="field">思考输出单价（{currency}）<input aria-label={`思考输出单价（${currency}）`} aria-describedby={`${id}-${row.key}-output-help`} inputMode="decimal" value={row.thinkingPrice} required onChange={event => changeRow(row.key, 'thinkingPrice', event.target.value)} /><small id={`${id}-${row.key}-output-help`}>包括供应商计入输出的思维链和回答。</small></label></div>
      <div><button type="button" className="button secondary small" disabled={value.rows.length === 1} onClick={() => onChange({ ...value, rows: value.rows.filter(item => item.key !== row.key) })}>移除此档</button></div>
    </fieldset>)}
    <div><button type="button" className="button secondary" disabled={disabled || value.rows.length >= 16} onClick={() => onChange({ ...value, rows: [...value.rows, blankRow(`new-${next.current++}`)] })}>增加输入档位</button></div>
  </div>;
}
