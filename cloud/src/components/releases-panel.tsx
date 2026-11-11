'use client';
import { useRef, useState } from 'react';
import type { ClientRelease } from '@/core/releases';

export function ReleasesPanel({ initial }: { initial: { revision: number; release: ClientRelease | null } }) {
  const [saved, setSaved] = useState(initial), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [version, setVersion] = useState(initial.release?.version || ''), [title, setTitle] = useState(initial.release?.title || 'CCAGENT 版本更新');
  const [notes, setNotes] = useState(initial.release?.notes || ''), [downloadUrl, setDownloadUrl] = useState(initial.release?.downloadUrl || '');
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  async function send(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setMessage('正在发送版本通知…');
    const fields = { revision: saved.revision, version: version.trim(), title: title.trim(), notes: notes.trim(), downloadUrl: downloadUrl.trim() };
    const fingerprint = JSON.stringify(fields);
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, id: crypto.randomUUID() };
    try {
      const response = await fetch('/api/admin/releases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...fields, id: attempt.current.id }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.message || '发送失败，请重试。');
      setSaved(result); attempt.current = null; setMessage('版本通知已发送。在线客户端约一分钟内收到，离线客户端下次联网时收到。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '发送失败，请重试。'); }
    finally { setBusy(false); }
  }
  async function reload() {
    if (busy) return; setBusy(true);
    try { const response = await fetch('/api/admin/releases', { cache: 'no-store' }); const data = await response.json(); if (!response.ok) throw new Error(data.message || '载入失败'); setSaved(data); setMessage('已载入最新发布状态，填写内容保留。'); }
    catch (error) { setMessage(error instanceof Error ? error.message : '载入失败'); }
    finally { setBusy(false); }
  }
  return <><section className="panel"><h2>发送版本更新通知</h2><p className="small-text muted">填写版本说明和下载链接，发送后通知所有使用旧版本的客户端。用户查看说明后红点消失，下载由用户主动点击。</p>
    <form onSubmit={send} className="release-editor"><fieldset disabled={busy} style={{ border: 0, padding: 0, display: 'grid', gap: 16 }}>
      <label>版本号<input required value={version} onChange={event => setVersion(event.target.value)} placeholder="例如 0.1.4" pattern="[0-9]+\.[0-9]+\.[0-9]+" maxLength={20} /></label>
      <label>通知标题<input required value={title} onChange={event => setTitle(event.target.value)} maxLength={140} /></label>
      <label>版本说明<textarea required value={notes} onChange={event => setNotes(event.target.value)} rows={10} maxLength={12000} placeholder="说明新增功能、问题修复和更新方式" /></label>
      <label>下载链接<input required type="url" value={downloadUrl} onChange={event => setDownloadUrl(event.target.value)} placeholder="https://…" maxLength={2048} /></label>
      <div className="inline-actions"><button className="button" type="submit">{busy ? '发送中…' : '发送版本通知'}</button><button className="button secondary" type="button" onClick={reload}>重新载入发布状态</button></div>
    </fieldset></form><p role="status" className="small-text">{message}</p></section>
    <section className="panel"><h2>当前已发布</h2>{saved.release ? <><h3>{saved.release.title} · {saved.release.version}</h3><p className="small-text muted">{new Date(saved.release.publishedAt).toLocaleString('zh-CN')}</p><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{saved.release.notes}</p><a href={saved.release.downloadUrl} target="_blank" rel="noopener noreferrer">查看下载链接</a></> : <p className="muted">暂无已发布版本通知。</p>}</section></>;
}
