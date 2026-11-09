'use client';
import { useEffect, useRef, useState } from 'react';
import type { RouteTestResult } from '@/core/route-tests';
import type { PriceDefinition } from '../../../src/platform/pricingDefinition';
import { formatMicroYuan } from '@/core/money-display';

type Quote = { routeId: string; name: string; provider: string; upstreamModel: string; protocol: string; enabled: boolean; confirmationFingerprint: string;
  estimatedPublicCostMicro: string; timeoutMs: number; description: string; pricing: { version: number; currency: string; sourceUrl: string; usdCny: string | null; definition?: PriceDefinition } };
function money(value: string) {
  try { return formatMicroYuan(value); } catch { return '—'; }
}
const stateNames = { running: '正在检测', succeeded: '检测通过', failed: '检测失败', unknown: '结果待确认' };
const metricNames: Record<string, string> = { input_tokens: '未缓存输入 Token', cached_input_tokens: '缓存输入 Token', output_tokens: '输出 Token', image_input_tokens: '图片输入 Token',
  audio_input_tokens: '音频输入 Token', audio_output_tokens: '音频输出 Token', video_input_tokens: '视频输入 Token', input_characters: '输入字符', input_images: '输入图片（张）', output_images: '输出图片（张）',
  output_images_1k: '1K 输出图片（张）', output_images_2k: '2K 输出图片（张）', output_images_4k: '4K 输出图片（张）', search_credits: '搜索 Credit', requests: '请求次数' };
export function RouteTestPanel({ routeId }: { routeId: string }) {
  const [quote, setQuote] = useState<Quote | null>(null), [test, setTest] = useState<RouteTestResult | null>(null), [testId, setTestId] = useState('');
  const [confirmed, setConfirmed] = useState(false), [submitted, setSubmitted] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const revision = useRef(0), action = useRef(false);
  useEffect(() => {
    revision.current++; action.current = false; setQuote(null); setTest(null); setTestId(''); setConfirmed(false); setSubmitted(false); setBusy(false); setError('');
    return () => { revision.current++; };
  }, [routeId]);
  async function prepare() {
    if (action.current) return; action.current = true;
    const generation = revision.current; setBusy(true); setError(''); setConfirmed(false);
    try {
      const response = await fetch('/api/admin/routes/test?' + new URLSearchParams({ routeId })); const body = await response.json();
      if (!response.ok) throw new Error(body.message || '暂时无法准备连接检测。');
      if (generation !== revision.current) return;
      setQuote(body.quote); setTest(body.lastTest); setTestId(body.lastTest?.status === 'running' ? body.lastTest.id : ''); setSubmitted(false);
    } catch (error) { if (generation === revision.current) { setQuote(null); setError(error instanceof Error ? error.message : '读取失败。'); } }
    finally { if (generation === revision.current) { action.current = false; setBusy(false); } }
  }
  async function query(id: string) {
    const generation = revision.current;
    try {
      const response = await fetch('/api/admin/routes/test?' + new URLSearchParams({ routeId, testId: id })); const body = await response.json();
      if (!response.ok) throw new Error(body.message || '检测状态暂不可查询，请稍后查询原编号。');
      if (generation === revision.current) { setTest(body.test); setError(''); }
    } catch (error) { if (generation === revision.current) setError(error instanceof Error ? error.message : '检测状态暂不可查询。'); }
  }
  useEffect(() => {
    if (!testId || test?.status && test.status !== 'running') return;
    const timer = setTimeout(() => { void query(testId); }, 2000);
    return () => clearTimeout(timer);
  }, [testId, test, routeId]);
  async function start() {
    if (!quote || !confirmed || submitted || busy || action.current) return;
    action.current = true;
    const generation = revision.current, id = crypto.randomUUID(); setTestId(id); setTest(null); setBusy(true); setSubmitted(true); setConfirmed(false); setError('');
    try {
      const response = await fetch('/api/admin/routes/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ routeId: quote.routeId, testId: id, confirmationFingerprint: quote.confirmationFingerprint, confirmPlatformCost: true }) });
      const body = await response.json();
      if (generation !== revision.current) return;
      if (!response.ok) { if (response.status < 500) setTestId(''); throw new Error(body.message || '检测提交结果未确认，请先查询原检测编号。'); }
      setTest(body.test); setError('');
    } catch (error) { if (generation === revision.current) setError(error instanceof Error ? error.message : '连接中断，请先查询原检测状态，避免重复请求。'); }
    finally { if (generation === revision.current) { action.current = false; setBusy(false); } }
  }
  const unresolved = Boolean(testId && (!test || test.status === 'running'));
  const displayedId = testId || test?.id || '';
  return <section className="form-stack" aria-labelledby="route-test-heading">
    <h3 id="route-test-heading">真实连接检测</h3>
    <p className="muted">检测服务器已保存的路由。修改配置后请先保存，再准备检测；暂停开放的路由也可检测。检测按对应协议执行一次任务，时限与内容以准备后的报价为准，费用由平台承担，用户余额不扣费。KIE 图像检测会真实生成一张 1K 图片，提交后查询原检测状态，避免重复付费。</p>
    <div><button type="button" className="button secondary" disabled={!routeId || busy || unresolved} onClick={() => { void prepare(); }}>准备连接检测</button></div>
    {quote && <div className="form-stack">
      <div className="notice neutral">{quote.name} · {quote.provider} · {quote.upstreamModel} · {quote.protocol}<br />{quote.enabled ? '已开放路由' : '暂停中的路由'} · 成本 v{quote.pricing.version} · 单次超时 {quote.timeoutMs / 1000} 秒<br />{quote.description}</div>
      <p>预计公开成本上界（平台承担）：<strong>¥{money(quote.estimatedPublicCostMicro)}</strong>。按已保存成本估算，实际费用以上游账单为准。{quote.pricing.currency === 'USD' && `结算汇率 ${quote.pricing.usdCny} 元/美元。`}<a href={quote.pricing.sourceUrl} target="_blank" rel="noopener noreferrer">公开价格来源 ↗</a></p>
      {quote.pricing.definition?.tariff.kind === 'qwen-input-tiers' && <p>本次按默认{quote.pricing.definition.tariff.defaultThinking ? '思考' : '非思考'}模式执行；思考模式的预算另计供应商最大思考长度 {quote.pricing.definition.tariff.maxThinkingTokens} Token。</p>}
      <label className="route-test-consent"><input type="checkbox" checked={confirmed} disabled={busy || unresolved || submitted} onChange={event => setConfirmed(event.target.checked)} /><span>我已核对已保存配置与预计费用，同意发送一次真实检测请求</span></label>
      <div><button type="button" className="button" disabled={!confirmed || busy || unresolved || submitted} onClick={() => { void start(); }}>发起真实检测</button></div>
    </div>}
    {displayedId && <div><button type="button" className="button secondary" disabled={busy} onClick={() => { void query(displayedId); }}>查询原检测状态</button><p className="muted">检测编号：{displayedId}</p></div>}
    {test && <div className={`notice${test.status === 'failed' ? ' error' : test.status === 'unknown' ? ' neutral' : ''}`} role="status">
      <strong>{stateNames[test.status]}</strong><p>{test.message}</p>
      <p>开始：{new Date(test.startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）{test.durationMs === undefined ? '' : ` · 耗时 ${test.durationMs} 毫秒`}{test.upstreamStatus === undefined ? '' : ` · 上游 HTTP ${test.upstreamStatus}`}</p>
      <p>公开成本：{test.publicCostMicro === null ? '尚未核实' : `¥${money(test.publicCostMicro)}`} · 用户扣费 ¥0.000000</p>
      {test.priceTier && <p>输入总量 {test.priceTier.inputTokens} Token，档位上限 {test.priceTier.upToInputTokens} Token，{test.priceTier.thinking ? '思考' : '非思考'}模式。</p>}
      {test.quantities && <p>核实用量：{Object.entries(test.quantities).map(([name, value]) => `${metricNames[name] || name} ${value}`).join('，')}</p>}
      {test.estimateExceeded && <p>实际公开成本超过原估算，差额由平台承担，请核对供应商用量与价格配置。</p>}
      {quote && quote.confirmationFingerprint !== test.confirmationFingerprint && <p>此记录对应较早的已保存配置，不能作为当前配置检测结果。</p>}
    </div>}
    {error && <div className="notice error" role="alert">{error}</div>}
    <small className="muted">检测结果记录在操作审计中，仅反映当次响应；不自动开启服务、重试或切换备用。结果待确认时请先核对供应商记录，再决定是否重新准备检测。</small>
  </section>;
}
