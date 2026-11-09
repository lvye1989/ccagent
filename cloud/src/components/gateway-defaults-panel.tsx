'use client';
import { useState, type FormEvent } from 'react';
import type { ServiceDefaultsView, ServiceKind } from '@/core/service-defaults';

const names: Record<ServiceKind, string> = { chat: '主模型', vision: '视觉读图', decision: 'Jev 决策', search: '联网搜索', voice: '语音合成', image: '图像生成' };
export function GatewayDefaultsPanel({ initial }: { initial: ServiceDefaultsView }) {
  const [view, setView] = useState(initial), [selected, setSelected] = useState(initial.routes);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  async function submit(event?: FormEvent) {
    event?.preventDefault(); setBusy(true); setMessage(''); setError('');
    try {
      const response = await fetch('/api/admin/routes/defaults', event ? { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ routes: selected, version: view.version }) } : undefined);
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || '默认服务设置未完成。');
      setView(result); setSelected(result.routes);
      setMessage(event ? '默认服务已保存，新账户首次验证平台 Key 时可使用这些推荐。' : '已重新载入最新设置。');
    } catch (error) { setError(error instanceof Error ? error.message : '网络连接失败。'); }
    finally { setBusy(false); }
  }
  return <section className="panel"><h2>平台默认服务</h2><p className="small-text admin-filter-note">为新账户首次配置提供推荐。已有选择和主动清空的选择保持不变，辅助服务仍需用户自行启用。此处核对配置就绪状态，不调用供应商。</p>
    <form className="form-stack" onSubmit={submit}>{(Object.keys(names) as ServiceKind[]).map(service => {
      const current = selected[service], choices = view.choices.filter(route => route.service === service);
      return <label className="field" key={service}>{names[service]}默认路由<select aria-label={`${names[service]}默认路由`} aria-describedby={view.routes[service] && !view.available[service] ? `default-${service}-warning` : undefined} value={current || ''} disabled={busy} onChange={event => setSelected(previous => ({ ...previous, [service]: event.target.value || null }))}>
        <option value="">不设置推荐</option>{current && !choices.some(route => route.id === current) && <option value={current} disabled>{current} · 已不可用</option>}
        {choices.map(route => <option key={route.id} value={route.id} disabled={!route.ready}>{route.name}（{route.id}）{route.ready ? '' : ' · 配置未就绪'}</option>)}
      </select>{view.routes[service] && !view.available[service] && <small className="error" id={`default-${service}-warning`}>已保存的默认路由当前不可用，将不向新账户推荐，请重新选择或清空。</small>}</label>;
    })}{message && <div className="notice" role="status">{message}</div>}{error && <div className="notice error" role="alert">{error}</div>}
      <div className="inline-actions"><button className="button" disabled={busy}>{busy ? '正在处理…' : '保存默认服务'}</button><button className="button secondary" type="button" disabled={busy} onClick={() => void submit()}>重新载入</button><span className="tag">配置版本 v{view.version}</span></div>
    </form></section>;
}
