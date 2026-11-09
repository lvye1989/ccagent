'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { formatMicroYuan, parseYuanToMicro } from '@/core/money-display';

type Owner = { id: string; name: string; email: string; emailVerified: boolean; banned: boolean };
type Entry = { id: string; userId: string; email: string; name: string; prefix: string; enabled: boolean;
  limit: string | null; spent: string; frozen: string; revokedAt: unknown };
function entry(row: Record<string, unknown>): Entry {
  return { id: String(row.id), userId: String(row.userId ?? row.user_id ?? ''), email: String(row.email ?? ''),
    name: String(row.name ?? ''), prefix: String(row.prefix ?? ''), enabled: row.enabled === true,
    limit: row.limit == null ? null : String(row.limit), spent: String(row.spent ?? '0'), frozen: String(row.frozen ?? '0'),
    revokedAt: row.revokedAt ?? row.revoked_at ?? null };
}
function checkAmount(text: string) { if (text) parseYuanToMicro(text, { maxMicro: 9_000_000_000_000_000n }); }
async function result(response: Response) {
  const body = await response.json() as { message?: string; user?: Owner; key?: Record<string, unknown>; secret?: string };
  if (!response.ok) throw new Error(body.message || '操作未完成，请重试。');
  return body;
}

export function AdminKeysPanel({ rows }: { rows: Record<string, unknown>[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [email, setEmail] = useState(''), [owner, setOwner] = useState<Owner | null>(null);
  const [createName, setCreateName] = useState(''), [createLimit, setCreateLimit] = useState('');
  const [selected, setSelected] = useState<Entry | null>(null), [queryId, setQueryId] = useState('');
  const [editName, setEditName] = useState(''), [editLimit, setEditLimit] = useState(''), [action, setAction] = useState('update');
  const [confirmed, setConfirmed] = useState(false), [secret, setSecret] = useState(''), [copied, setCopied] = useState(false);
  function clearNotice() { setError(''); setMessage(''); }
  function select(value: Entry | null) {
    setSecret(''); setCopied(false);
    setSelected(value); setQueryId(value?.id ?? ''); setEditName(value?.name ?? '');
    setEditLimit(value?.limit == null ? '' : formatMicroYuan(value.limit)); setAction('update'); setConfirmed(false); clearNotice();
  }
  async function lookupOwner() {
    setBusy(true); clearNotice(); setOwner(null); setSecret(''); setCopied(false);
    try {
      const value = await result(await fetch('/api/admin/keys?email=' + encodeURIComponent(email.trim()), { cache: 'no-store' }));
      if (!value.user) throw new Error('用户查询结果无效。');
      setOwner(value.user);
    } catch (error) { setError(error instanceof Error ? error.message : '用户查询失败。'); }
    finally { setBusy(false); }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); clearNotice(); setSecret(''); setCopied(false);
    if (!owner || owner.email.toLowerCase() !== email.trim().toLowerCase()) { setError('请先查询并确认归属用户。'); return; }
    try { checkAmount(createLimit.trim()); } catch (error) { setError(error instanceof Error ? error.message : '累计额度无效。'); return; }
    setBusy(true);
    try {
      const value = await result(await fetch('/api/admin/keys', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: owner.id, name: createName.trim(), limitYuan: createLimit.trim() || null }) }));
      if (!value.secret || !value.key) throw new Error('未收到完整创建结果，请先查询列表确认，不要重复创建。');
      select(entry({ ...value.key, email: owner.email })); setSecret(value.secret); setCreateName(''); setCreateLimit('');
      setMessage('API Key 已创建，归属于 ' + owner.email + '。'); router.refresh();
    } catch (error) { setError((error instanceof Error ? error.message : '连接中断。') + ' 请先查询列表确认创建结果，避免重复创建。'); }
    finally { setBusy(false); }
  }
  async function lookupKey() {
    setBusy(true); clearNotice(); setSecret(''); setCopied(false);
    try {
      const value = await result(await fetch('/api/admin/keys/' + encodeURIComponent(queryId.trim()), { cache: 'no-store' }));
      if (!value.key) throw new Error('API Key 查询结果无效。');
      select(entry(value.key)); setMessage('已读取最新配置。');
    } catch (error) { setError(error instanceof Error ? error.message : '查询失败。'); }
    finally { setBusy(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); clearNotice();
    if (!selected) return;
    if (action !== 'update' && !confirmed) { setError('请先确认停止此 Key 的新调用。'); return; }
    try { if (action === 'update') checkAmount(editLimit.trim()); } catch (error) { setError(error instanceof Error ? error.message : '累计额度无效。'); return; }
    setBusy(true); setSecret('');
    try {
      const value = await result(await fetch('/api/admin/keys/' + encodeURIComponent(selected.id), { method: action === 'delete' ? 'DELETE' : 'PUT',
        ...(action === 'delete' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(action === 'update'
          ? { action, name: editName.trim(), limitYuan: editLimit.trim() || null } : { action: 'revoke' }) }) }));
      if (value.key) select(entry({ ...value.key, email: selected.email }));
      else select({ ...selected, enabled: false, revokedAt: new Date().toISOString() });
      setMessage(action === 'update' ? '名称和累计额度已保存。' : action === 'delete' ? 'API Key 已删除并立即撤销，历史调用和财务记录已保留。' : 'API Key 已撤销，已停止新调用。');
      router.refresh();
    } catch (error) { setError(error instanceof Error ? error.message : '操作失败，请查询最新状态后重试。'); }
    finally { setBusy(false); }
  }
  const inactive = !selected?.enabled || !!selected.revokedAt;
  return <section className="panel"><h2>管理 API Key</h2>
    <form className="form-stack" onSubmit={create}>
      <h3>为用户创建 API Key</h3>
      <div className="form-row"><label className="field">用户邮箱<input type="email" value={email} onChange={event => { setEmail(event.target.value); setOwner(null); setSecret(''); setCopied(false); clearNotice(); }} required maxLength={320} disabled={busy} autoComplete="off" /></label>
        <div className="inline-actions" style={{ alignItems: 'end' }}><button className="button secondary" type="button" onClick={lookupOwner} disabled={busy || !email.trim()}>查询用户</button></div></div>
      {owner && <div className="notice neutral">归属用户：<strong>{owner.name} · {owner.email}</strong>{owner.banned || !owner.emailVerified ? '（账户已禁用或邮箱未验证，暂不能创建）' : '（已验证）'}</div>}
      <div className="form-row"><label className="field">新 Key 名称<input value={createName} onChange={event => setCreateName(event.target.value)} maxLength={80} required disabled={busy} placeholder="例如：办公电脑" /></label>
        <label className="field">累计额度（元）<input value={createLimit} onChange={event => setCreateLimit(event.target.value)} inputMode="decimal" maxLength={24} disabled={busy} placeholder="留空表示不单独限制" /><small>最多六位小数，包含已使用和冻结金额；多个 Key 共用账户余额。</small></label></div>
      <div><button className="button" disabled={busy || !owner || owner.banned || !owner.emailVerified}>创建并显示完整 Key</button></div>
    </form>
    {secret && <div className="notice" role="status"><strong>完整 Key 仅创建时显示，请妥善保存。</strong><pre className="secret">{secret}</pre>
      <div className="inline-actions"><button className="button small" type="button" onClick={async () => { try { await navigator.clipboard.writeText(secret); setCopied(true); } catch { setError('复制失败，请手动复制。'); } }}>{copied ? '已复制' : '复制 Key'}</button>
        <button className="text-button" type="button" onClick={() => setSecret('')}>已保存，隐藏完整 Key</button></div></div>}
    <hr className="divider" />
    <form className="form-stack" onSubmit={save}><h3>查询与编辑已有 Key</h3>
      <label className="field">当前列表中的 Key<select value={rows.some(row => String(row.id) === selected?.id) ? selected!.id : ''} onChange={event => { const row = rows.find(row => String(row.id) === event.target.value); select(row ? entry(row) : null); }} disabled={busy}>
        <option value="">请选择，也可在下方按编号查询</option>{rows.map(row => <option key={String(row.id)} value={String(row.id)}>{String(row.email)} · {String(row.name)} · {String(row.prefix)}…{row.enabled !== true || row.revoked_at ? '（已撤销）' : ''}</option>)}
      </select></label>
      <div className="form-row"><label className="field">Key 编号<input value={queryId} onChange={event => { setQueryId(event.target.value); setSelected(null); setSecret(''); setCopied(false); clearNotice(); }} maxLength={200} disabled={busy} placeholder="输入编号后读取最新配置" /></label>
        <div className="inline-actions" style={{ alignItems: 'end' }}><button className="button secondary" type="button" disabled={busy || !queryId.trim()} onClick={lookupKey}>读取最新配置</button></div></div>
      {selected && <><div className="notice neutral">归属：{selected.email || selected.userId} · 前缀：<span className="mono">{selected.prefix}…</span> · 状态：{inactive ? '已撤销' : '可用'}<br />已使用 ¥{formatMicroYuan(selected.spent)} · 冻结 ¥{formatMicroYuan(selected.frozen)}</div>
        <label className="field">执行操作<select value={action} onChange={event => { setAction(event.target.value); setConfirmed(false); setSecret(''); setCopied(false); clearNotice(); }} disabled={busy}><option value="update">修改名称与累计额度</option><option value="revoke" disabled={inactive}>撤销 Key</option><option value="delete">删除 Key（立即撤销，保留财务记录）</option></select></label>
        {action === 'update' ? <div className="form-row"><label className="field">Key 名称<input value={editName} onChange={event => setEditName(event.target.value)} required maxLength={80} disabled={busy} /></label>
          <label className="field">累计额度（元）<input value={editLimit} onChange={event => setEditLimit(event.target.value)} inputMode="decimal" maxLength={24} disabled={busy} placeholder="留空表示不单独限制" /><small>不得低于已使用金额与冻结金额之和。已撤销的 Key 不会因修改额度而恢复。</small></label></div>
          : <label className="route-test-consent"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} /><span>确认立即停止新调用。此 Key 无法恢复，已经授权的调用仍会结算并释放剩余冻结额度；历史记录保留。</span></label>}
        <div><button className={`button${action === 'update' ? '' : ' danger'}`} disabled={busy || (action !== 'update' && !confirmed)}>{busy ? '正在处理…' : action === 'update' ? '保存 Key 修改' : action === 'delete' ? '删除并撤销 Key' : '确认撤销 Key'}</button></div></>}
    </form>
    {message && <div className="notice" role="status">{message}</div>}{error && <div className="notice error" role="alert">{error}</div>}
  </section>;
}
