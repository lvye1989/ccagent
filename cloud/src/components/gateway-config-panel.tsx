'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';

type GatewayConfig = { allowedHosts: string[]; trustedHosts: string[]; version: number; usdCny: string; fxVersion: number; fxReadonly: boolean; fxSource: 'environment' | 'database' | 'default' };
const sources = { environment: '服务器已有配置', database: '后台保存', default: '默认值' };
function readConfig(value: GatewayConfig): GatewayConfig {
  if (!value || !Array.isArray(value.allowedHosts) || !Array.isArray(value.trustedHosts) || !value.allowedHosts.every(host => typeof host === 'string') || !value.trustedHosts.every(host => typeof host === 'string') || !Number.isSafeInteger(value.version) || !Number.isSafeInteger(value.fxVersion) || typeof value.usdCny !== 'string' || !Object.hasOwn(sources, value.fxSource)) throw new Error('INVALID_CONFIG');
  return value;
}
export function GatewayConfigPanel() {
  const [view, setView] = useState<GatewayConfig | null>(null), [hosts, setHosts] = useState(''), [usdCny, setUsdCny] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const request = useRef<AbortController | null>(null), generation = useRef(0), action = useRef(false);
  function apply(value: GatewayConfig) { const config = readConfig(value); setView(config); setHosts(config.allowedHosts.join('\n')); setUsdCny(config.usdCny); }
  async function load() {
    if (action.current) return;
    action.current = true; setBusy(true); setMessage(''); setError('');
    const current = ++generation.current, controller = new AbortController(); request.current = controller;
    try {
      const response = await fetch('/api/admin/routes/config', { signal: controller.signal, cache: 'no-store' }); const value = await response.json();
      if (current !== generation.current || controller.signal.aborted) return;
      if (!response.ok) throw new Error('LOAD_FAILED');
      apply(value);
    } catch { if (current === generation.current && !controller.signal.aborted) setError('网关域名与汇率配置读取未完成，请重新载入。'); }
    finally { if (current === generation.current && !controller.signal.aborted) { action.current = false; setBusy(false); } }
  }
  useEffect(() => { void load(); return () => { generation.current++; request.current?.abort(); action.current = false; }; }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (action.current || !view) return;
    const allowedHosts = [...new Set(hosts.split(/[\s,，]+/).filter(Boolean).map(host => host.toLowerCase()))];
    if (allowedHosts.length > 50 || allowedHosts.some(host => host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host))) { setError('请填写最多 50 个完整公共域名，不含协议、路径、端口、通配符或 IP。'); return; }
    const fxChanged = !view.fxReadonly && usdCny !== view.usdCny;
    if (fxChanged && !/^(?:|[1-9]\d{0,2}(?:\.\d{1,6})?)$/.test(usdCny)) { setError('美元结算汇率的整数部分应为 1 至 999，最多六位小数，不含前导零；留空表示暂不开放美元计价服务。'); return; }
    action.current = true; setBusy(true); setMessage(''); setError('');
    const current = ++generation.current, controller = new AbortController(); request.current = controller;
    try {
      const payload = { version: view.version, allowedHosts, ...(fxChanged ? { usdCny, fxVersion: view.fxVersion } : {}) };
      const response = await fetch('/api/admin/routes/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal }); const result = await response.json();
      if (current !== generation.current || controller.signal.aborted) return;
      if (!response.ok) {
        setError(result.code === 'ENVIRONMENT_OVERRIDE' ? '美元结算汇率由服务器配置覆盖，当前只读。请重新载入。' : response.status === 409 ? '配置已在其他页面更新，请重新载入后再保存。' : '配置未保存，请核对公共域名与汇率后重试。'); return;
      }
      apply(result); setMessage('允许域名与结算汇率已保存，将用于后续请求。');
    } catch { if (current === generation.current && !controller.signal.aborted) setError('保存结果未确认，请重新载入核对后再试。'); }
    finally { if (current === generation.current && !controller.signal.aborted) { action.current = false; setBusy(false); } }
  }
  return <section className="panel"><h2>上游允许域名与结算汇率</h2><p>在后台批准新供应商的域名，并设置美元公开成本的人民币结算汇率。</p>
    <form className="form-stack" onSubmit={save}>
      <label className="field">额外允许的上游域名<textarea aria-label="额外允许的上游域名" value={hosts} onChange={event => setHosts(event.target.value)} disabled={busy || !view} maxLength={26000} rows={4} placeholder="api.example.com" /><small>每行一个精确公共域名，不含 https://、端口或路径，不支持通配符。留空移除全部额外批准；服务器仍校验域名解析结果与实际连接地址。</small></label>
      {view && <div className="small-text"><strong>已有批准域名（只读）</strong><p>{view.trustedHosts.length ? view.trustedHosts.join('、') : '暂无'}</p></div>}
      <label className="field">美元结算汇率<input aria-label="美元结算汇率" value={usdCny} onChange={event => setUsdCny(event.target.value)} inputMode="decimal" maxLength={10} disabled={busy || !view || view.fxReadonly} /><small>人民币 / 美元。留空时暂停需要美元换算的服务；汇率随调用保存快照，历史账单保持原值。{view && ` 当前来源：${sources[view.fxSource]}。`}{view?.fxReadonly && '服务器配置覆盖此值，当前只读。'}</small></label>
      {message && <div className="notice" role="status">{message}</div>}{error && <div className="notice error" role="alert">{error}</div>}
      <div className="inline-actions"><button className="button" disabled={busy || !view}>{busy ? '正在处理…' : '保存域名与汇率'}</button><button type="button" className="button secondary" disabled={busy} onClick={() => void load()}>重新载入域名与汇率</button>{view && <span className="tag">配置版本 v{view.version}</span>}</div>
    </form>
  </section>;
}
