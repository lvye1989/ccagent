'use client';
import { useState, type FormEvent } from 'react';

export function AuthForm({ initialError = '', verified = false }: { initialError?: string; verified?: boolean }) {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [busy, setBusy] = useState(false), [error, setError] = useState(initialError), [notice, setNotice] = useState(verified ? '邮箱验证已完成，请登录。' : '');
  const title = mode === 'login' ? '欢迎回来' : mode === 'register' ? '创建你的账户' : '找回密码';
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    const form = new FormData(event.currentTarget), email = String(form.get('email') || '').trim();
    const endpoint = mode === 'login' ? 'sign-in/email' : mode === 'register' ? 'sign-up/email' : 'request-password-reset';
    const body = mode === 'forgot' ? { email, redirectTo: `${window.location.origin}/reset-password` }
      : mode === 'register' ? { email, password: String(form.get('password') || ''), name: String(form.get('name') || '').trim(), callbackURL: `${window.location.origin}/login?verified=1` }
      : { email, password: String(form.get('password') || '') };
    try {
      const response = await fetch(`/api/auth/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) {
        if (response.status === 429) throw new Error('操作过于频繁，请稍后再试。');
        if (response.status === 401) throw new Error('邮箱或密码不正确。');
        if (response.status === 403) throw new Error('请先完成邮箱验证；账户被停用时请联系管理员。');
        if (response.status === 400) throw new Error('请检查邮箱、密码和填写内容。');
        throw new Error('暂时无法完成操作，请稍后重试。');
      }
      if (mode === 'login') { window.location.assign('/account'); return; }
      setNotice(mode === 'register' ? '请查看注册邮箱中的验证邮件，完成验证后登录。' : '如该邮箱已注册，你将收到密码重置邮件，请查收。');
    } catch (error) { setError(error instanceof Error ? error.message : '网络连接失败，请重试。'); }
    finally { setBusy(false); }
  }
  function switchMode(value: typeof mode) { setMode(value); setError(''); setNotice(''); }
  return <div className="auth-card"><div className="eyebrow">YOUR WORK, CONNECTED</div><h1>{title}</h1><p>{mode === 'login' ? '使用邮箱和密码登录，继续你的 CCAGENT 工作。' : mode === 'register' ? '一个账户，管理你的服务、余额与使用明细。' : '输入注册邮箱，我们将发送密码重置链接。'}</p>
    <form className="form-stack" onSubmit={submit} key={mode}>{mode === 'register' && <label className="field">如何称呼你<input name="name" required maxLength={80} autoComplete="name" placeholder="你的姓名或昵称" /></label>}
      <label className="field">邮箱地址<input name="email" type="email" required autoComplete="email" maxLength={320} placeholder="you@example.com" /></label>
      {mode !== 'forgot' && <label className="field">密码<input name="password" type="password" required minLength={8} maxLength={128} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder={mode === 'register' ? '至少 8 位字符' : '输入你的密码'} /></label>}
      <button className="button full" type="submit" disabled={busy}>{busy ? '正在处理…' : mode === 'login' ? '登录账户 →' : mode === 'register' ? '创建账户并验证邮箱 →' : '发送重置邮件 →'}</button>
    </form>{error && <div className="notice error" role="alert">{error}</div>}{notice && <div className="notice" role="status">{notice}</div>}
    <div className="auth-links"><button className="text-button" disabled={busy} onClick={() => switchMode(mode === 'register' ? 'login' : 'register')}>{mode === 'register' ? '已有账户？去登录' : '注册新账户'}</button><button className="text-button" disabled={busy} onClick={() => switchMode(mode === 'forgot' ? 'login' : 'forgot')}>{mode === 'forgot' ? '返回登录' : '忘记密码？'}</button></div>
  </div>;
}
