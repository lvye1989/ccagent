'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';

export function ResetForm({ token, invalid }: { token: string; invalid: boolean }) {
  const [busy, setBusy] = useState(false), [done, setDone] = useState(false), [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    if (form.get('password') !== form.get('confirm')) { setError('两次输入的密码不一致。'); setBusy(false); return; }
    try {
      const response = await fetch('/api/auth/reset-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, newPassword: String(form.get('password') || '') }) });
      if (!response.ok) throw new Error(response.status === 400 ? '链接已失效，或密码不符合要求。请重新申请密码重置。' : '暂时无法重置密码，请稍后重试。');
      setDone(true);
    } catch (error) { setError(error instanceof Error ? error.message : '网络连接失败。'); }
    finally { setBusy(false); }
  }
  if (invalid || !token) return <div className="auth-card"><h1>重置链接已失效</h1><p>请返回登录页面，重新申请密码重置邮件。</p><Link className="button" href="/login">返回登录</Link></div>;
  return <div className="auth-card"><div className="eyebrow">ACCOUNT SECURITY</div><h1>{done ? '密码已更新' : '设置新密码'}</h1><p>{done ? '请使用新密码重新登录。' : '重置完成后，需要使用新密码重新登录你的设备。'}</p>{done ? <Link href="/login" className="button full">返回登录 →</Link> : <form className="form-stack" onSubmit={submit}><label className="field">新密码<input type="password" name="password" minLength={8} maxLength={128} required autoComplete="new-password" /></label><label className="field">确认新密码<input type="password" name="confirm" minLength={8} maxLength={128} required autoComplete="new-password" /></label><button className="button full" disabled={busy}>{busy ? '正在更新…' : '更新密码'}</button></form>}{error && <div className="notice error" role="alert">{error}</div>}</div>;
}
