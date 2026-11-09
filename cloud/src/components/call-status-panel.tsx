'use client';
import { useEffect, useRef, useState } from 'react';
import { callIdentifierPattern } from '@/core/call-identifiers';
import { formatMicroYuan } from '@/core/money-display';

type CallStatus = { requestId: string; taskId: string; routeId: string; status: 'held' | 'pending' | 'settled' | 'released';
  authorized: string; charged: string; resultAvailable: boolean; resultExpiresAt: string | null; updatedAt: string };
const statusNames = { held: '正在执行', pending: '用量待核实', settled: '已结算', released: '已释放授权' };
class CallStatusError extends Error {}
function money(value: string) {
  return `¥${formatMicroYuan(value)}`;
}
function date(value: string | null) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）' : '—';
}
function parseStatus(value: unknown, requestId: string): CallStatus {
  if (!value || typeof value !== 'object') throw new CallStatusError('调用状态暂时无法读取，请稍后查询原编号。');
  const call = value as CallStatus;
  if (call.requestId !== requestId || !Object.hasOwn(statusNames, call.status) ||
      typeof call.authorized !== 'string' || !/^\d{1,30}$/.test(call.authorized) ||
      typeof call.charged !== 'string' || !/^\d{1,30}$/.test(call.charged) ||
      typeof call.taskId !== 'string' || typeof call.routeId !== 'string' || typeof call.resultAvailable !== 'boolean') {
    throw new CallStatusError('调用状态暂时无法读取，请稍后查询原编号。');
  }
  return call;
}

/** Read-only recovery: never issues a model request or requires an active consumption Key. */
export function CallStatusPanel({ recentCalls }: { recentCalls: { requestId: string; taskId: string }[] }) {
  const [requestId, setRequestId] = useState(''), [result, setResult] = useState<CallStatus | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const revision = useRef(0), active = useRef<AbortController | null>(null);
  useEffect(() => () => { revision.current++; active.current?.abort(); }, []);
  function select(id: string) {
    revision.current++; active.current?.abort(); active.current = null;
    setRequestId(id); setResult(null); setError(''); setBusy(false);
  }
  async function query() {
    if (active.current) return;
    // Identifiers are exact values: trimming would make a different input look valid.
    if (!callIdentifierPattern.test(requestId)) { setResult(null); setError('请输入 1–200 位请求编号，仅限字母、数字及 . _ : -。'); return; }
    const generation = ++revision.current, controller = new AbortController(); active.current = controller;
    const timer = setTimeout(() => controller.abort(), 15000);
    setBusy(true); setError(''); setResult(null);
    try {
      const response = await fetch('/api/account/calls?' + new URLSearchParams({ id: requestId }),
        { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new CallStatusError(response.status === 401 ? '登录已失效，请重新登录后查询。'
        : response.status === 403 ? '当前账户无权查看，请确认登录账户状态。'
        : response.status === 404 ? '当前账户未找到该请求编号。请核对原编号，不要直接重新发起收费调用。'
        : '暂时无法查询。请保留原编号，稍后再查；当前状态与费用尚未确认。');
      const value = parseStatus(await response.json(), requestId);
      if (generation === revision.current) setResult(value);
    } catch (error) {
      if (generation === revision.current) setError(controller.signal.aborted ? '查询超时，请保留原编号并稍后再查。'
        : error instanceof CallStatusError ? error.message : '连接中断或响应无法读取，状态尚未确认。请保留原编号并稍后再查。');
    } finally {
      clearTimeout(timer);
      if (generation === revision.current) { active.current = null; setBusy(false); }
    }
  }
  return <section className="panel" aria-labelledby="call-status-heading">
    <h2 id="call-status-heading">查询原调用状态</h2>
    <p>停止回答或连接中断后，先核对原请求。查询只读取记录，不调用模型、不新增消费；消费 Key 撤销后仍可查询本人的记录。</p>
    <form className="form-stack" onSubmit={event => { event.preventDefault(); void query(); }}>
      {recentCalls.length > 0 && <label className="field">从本页记录选择<select value={recentCalls.some(call => call.requestId === requestId) ? requestId : ''} onChange={event => select(event.target.value)}>
        <option value="">选择原请求，或在下方输入</option>
        {recentCalls.map(call => <option key={call.requestId} value={call.requestId}>{call.requestId} · {call.taskId}</option>)}
      </select></label>}
      <label className="field">原请求编号<input value={requestId} maxLength={200} autoComplete="off" spellCheck={false} onChange={event => select(event.target.value)} placeholder="使用明细中的请求编号，或应用错误提示中的请求编号" /></label>
      <div><button className="button secondary" disabled={busy || !requestId}>{busy ? '正在查询…' : '查询原调用'}</button></div>
    </form>
    {error && <div className="notice error" role="alert">{error}</div>}
    {result && <div className={`notice${result.status === 'pending' || result.status === 'held' ? ' neutral' : ''}`} role="status">
      <strong>{statusNames[result.status]}</strong>
      <p className="mono">请求编号：{result.requestId}<br />任务编号：{result.taskId}<br />服务：{result.routeId}</p>
      <p>授权上限：{money(result.authorized)} · {result.status === 'settled' ? `已结算费用：${money(result.charged)}` : result.status === 'released' ? '本次授权已释放，费用以账户流水为准。' : '最终费用尚未确认，当前零扣费数值不代表免费。'}</p>
      {(result.status === 'held' || result.status === 'pending') && <p>原调用仍在执行或核验用量，可能保留冻结额度。可稍后查询同一编号，避免另起收费调用。</p>}
      <p>{result.resultAvailable ? `原结果仍在保留期内，到期时间：${date(result.resultExpiresAt)}。` : '当前没有可恢复结果，可能尚未生成或已过期。'}</p>
      <p>最后更新：{date(result.updatedAt)}</p>
    </div>}
    <p className="small-text admin-filter-note">授权上限不是已扣费金额，当前冻结以余额页面为准。停止接收回答后，上游可能继续生成；最终按可核实用量结算。查询不会重新生成或重放回答。</p>
  </section>;
}
