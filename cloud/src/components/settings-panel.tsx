'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

type Entry = { key: string; value: unknown; version: number; source: string; readonly: boolean };
const descriptions: Record<string, [string, string]> = {
  support_email: ['客服邮箱', '在用户需要协助时提供的联系邮箱。'], payment_enabled: ['开放余额充值', '启用前请确认支付商户、回调和对账均已验证。'],
  recharge_min_fen: ['单笔最低充值（分）', '100 分 = 1 元。'], recharge_max_fen: ['单笔最高充值（分）', '与最低充值额共同限制可提交金额。'],
  settlement_usd_cny: ['美元结算汇率', '人民币 / 美元。留空时不开放需要美元换算的服务。'],
};
export function SettingsPanel({ settings, credentials }: { settings: Entry[]; credentials: { database: boolean; auth: boolean; email: boolean; emailDomain: string; payment: { merchantConfigured: boolean; keyConfigured: boolean; baseUrl: string; channel: string }; markup: string } }) {
  const router = useRouter(), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(''); setError('');
    const form = new FormData(event.currentTarget);
    const changes = settings.filter(item => !item.readonly).map(item => ({ key: item.key, version: item.version,
      value: typeof item.value === 'boolean' ? form.get(item.key) === 'true' : typeof item.value === 'number' ? Number(form.get(item.key)) : String(form.get(item.key) || '').trim() })).filter(change => change.value !== settings.find(item => item.key === change.key)?.value);
    if (!changes.length) { setMessage('当前设置未发生变化。'); setBusy(false); return; }
    try {
      const response = await fetch('/api/admin/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes }) });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message || '保存失败。');
      setMessage('设置已保存，将从下一次请求开始生效。'); router.refresh();
    } catch (error) { setError(error instanceof Error ? error.message : '网络连接失败。'); }
    finally { setBusy(false); }
  }
  return <div className="grid-two"><section className="panel"><div className="panel-header"><h2>通用与计费设置</h2><span className="tag">人民币预付余额</span></div><form onSubmit={save}>{settings.map(item => <label className="setting-row" key={`${item.key}-${item.version}`}><div className="setting-label"><strong>{descriptions[item.key]?.[0] || item.key}</strong><p>{descriptions[item.key]?.[1]}</p><span className="tag">{item.source === 'environment' ? '环境变量 · 只读' : item.source === 'database' ? `数据库 · v${item.version}` : '默认值'}</span></div>{typeof item.value === 'boolean' ? <select name={item.key} defaultValue={String(item.value)} disabled={item.readonly || busy}><option value="false">关闭</option><option value="true">开启</option></select> : <input name={item.key} type={typeof item.value === 'number' ? 'number' : item.key === 'support_email' ? 'email' : 'text'} defaultValue={String(item.value)} disabled={item.readonly || busy} maxLength={320} />}</label>)}{message && <div className="notice" role="status">{message}</div>}{error && <div className="notice error" role="alert">{error}</div>}<button className="button" disabled={busy}>{busy ? '正在保存…' : '保存设置'}</button></form></section>
    <section className="panel"><h2>服务配置状态</h2><p className="small-text">密钥通过服务器安全配置维护。这里仅展示配置状态。</p><div className="status-list">{[['数据库连接', credentials.database], ['认证密钥', credentials.auth], ['邮件服务密钥', credentials.email], ['支付商户编号', credentials.payment.merchantConfigured], ['支付商户密钥', credentials.payment.keyConfigured]].map(([name, configured]) => <div className="status-line" key={String(name)}><span>{name}</span><span className={`tag ${configured ? 'success' : ''}`}>{configured ? '已配置' : '未配置'}</span></div>)}</div><hr className="divider" /><div className="status-list"><div className="status-line"><span>发信域名</span><span className="mono">{credentials.emailDomain}</span></div><div className="status-line"><span>支付接口</span><span className="mono">{credentials.payment.baseUrl}</span></div><div className="status-line"><span>支付方式</span><span>支付宝</span></div><div className="status-line"><span>收费倍率</span><span>{credentials.markup} × 供应商成本</span></div></div><div className="notice neutral">配置状态仅表示存在相应配置。实际连通情况与业务状态请在对应服务中核对。</div></section></div>;
}
