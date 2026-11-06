'use client';
import { useState } from 'react';

export function Logout() {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <><button className="text-button" disabled={busy} onClick={async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error();
      window.location.assign('/login');
    } catch { setError('退出未完成，请重试。'); setBusy(false); }
  }}>{busy ? '正在退出…' : '退出登录'}</button>{error && <span role="alert" className="small-text">{error}</span>}</>;
}
