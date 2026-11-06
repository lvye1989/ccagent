'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

type KeyEntry = { id: string; name: string; prefix: string; enabled: boolean; limit: string | null; spent: string; frozen: string; createdAt: string; revokedAt: string | null };
function amount(value: string) { const micro = BigInt(value); return `¥${micro / 1000000n}.${(micro % 1000000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')}`; }
export function KeysPanel({ keys }: { keys: KeyEntry[] }) {
  const router = useRouter(), [creating, setCreating] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [secret, setSecret] = useState(''), [copied, setCopied] = useState(false);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setSecret(''); setCopied(false);
    const data = new FormData(event.currentTarget), text = String(data.get('limit') || '').trim();
    if (text && !/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(text)) { setError('额度请输入人民币金额，最多两位小数。'); setBusy(false); return; }
    const [whole, fraction = ''] = text.split('.');
    const limit = text ? ((BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * 10000n).toString() : null;
    try {
      const response = await fetch('/api/account/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: String(data.get('name') || '').trim(), limit }) });
      const result = await response.json() as { secret?: string; message?: string };
      if (!response.ok || !result.secret) throw new Error(result.message || '创建失败，请重试。');
      setSecret(result.secret); setCreating(false); router.refresh();
    } catch (error) { setError(error instanceof Error ? error.message : '网络连接失败。'); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/account/keys', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
      if (!response.ok) throw new Error('撤销失败，请重试。');
      router.refresh();
    } catch (error) { setError(error instanceof Error ? error.message : '网络连接失败。'); }
    finally { setBusy(false); }
  }
  return <><section className="panel"><div className="panel-header"><div><h2>你的 API Key</h2><span className="muted small-text">完整内容仅创建时显示，请妥善保存。</span></div><button className="button" disabled={busy} onClick={() => setCreating(!creating)}>{creating ? '收起表单' : '+ 创建 Key'}</button></div>
    {creating && <form className="form-stack" onSubmit={create}><div className="form-row"><label className="field">名称<input name="name" required maxLength={80} placeholder="例如：我的办公电脑" /></label><label className="field">累计使用额度（元）<input name="limit" inputMode="decimal" placeholder="留空表示不单独限制" /><small>多个 Key 共用账户余额，单独额度包含已使用及冻结部分。</small></label></div><div><button className="button" disabled={busy}>{busy ? '正在创建…' : '创建并显示 Key'}</button></div><hr className="divider" /></form>}
    {secret && <div className="notice"><strong>Key 已创建。离开此页面后将无法再次查看完整内容。</strong><pre className="secret">{secret}</pre><div className="inline-actions"><button className="button small" onClick={async () => { try { await navigator.clipboard.writeText(secret); setCopied(true); } catch { setError('无法写入剪贴板，请手动复制。'); } }}>{copied ? '已复制' : '复制 Key'}</button><button className="text-button" onClick={() => setSecret('')}>我已保存，隐藏内容</button></div></div>}
    {error && <div className="notice error" role="alert">{error}</div>}{keys.length ? <div className="table-wrap"><table><thead><tr><th>名称 / 前缀</th><th>状态</th><th>已使用</th><th>冻结</th><th>累计额度</th><th>操作</th></tr></thead><tbody>{keys.map(key => <tr key={key.id}><td><strong>{key.name}</strong><br /><span className="mono muted">{key.prefix}…</span></td><td><span className={`tag ${key.enabled ? 'success' : ''}`}>{key.enabled ? '可用' : '已撤销'}</span></td><td>{amount(key.spent)}</td><td>{amount(key.frozen)}</td><td>{key.limit ? amount(key.limit) : '不单独限制'}</td><td>{key.enabled ? <button className="button small danger" disabled={busy} onClick={() => revoke(key.id)}>撤销</button> : '—'}</td></tr>)}</tbody></table></div> : <div className="empty"><strong>还没有个人 Key</strong>为需要使用官方服务的设备创建一个 Key。</div>}</section><div className="notice neutral">撤销后，此 Key 将立即停止新的调用。已经授权的调用会继续结算并释放未使用的冻结额度。</div></>;
}
