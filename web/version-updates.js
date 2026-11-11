export function newerVersion(candidate, current) {
  const pattern = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
  if (!pattern.test(candidate || '') || !pattern.test(current || '')) return false;
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number);
  for (let index = 0; index < 3; index++) { if (a[index] !== b[index]) return a[index] > b[index]; }
  return false;
}
function safeRelease(value) {
  if (!value || typeof value !== 'object' || !/^[a-f0-9-]{36}$/.test(value.id) || typeof value.title !== 'string' || typeof value.notes !== 'string' || value.title.length > 140 || value.notes.length > 12000 || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value.version)) return null;
  try { const url = new URL(value.downloadUrl); if (url.protocol !== 'https:' || url.username || url.password) return null; }
  catch { return null; }
  return value;
}
export function createVersionUpdates({ accountButton, accountMenu, after }) {
  const entry = document.createElement('button'); entry.type = 'button'; entry.className = 'version-updates-entry'; entry.textContent = '版本更新';
  after.after(entry);
  const page = document.createElement('dialog'); page.className = 'version-updates-dialog'; page.setAttribute('aria-label', '版本更新');
  const heading = document.createElement('h2'); heading.textContent = '版本更新';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const content = document.createElement('section');
  const refreshButton = document.createElement('button'); refreshButton.type = 'button'; refreshButton.textContent = '检查更新';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭'; close.addEventListener('click', () => page.close());
  const actions = document.createElement('div'); actions.className = 'version-updates-actions'; actions.append(refreshButton, close);
  page.append(heading, status, content, actions); document.body.append(page);
  let identity = null, latest = null, currentVersion = '', inflight = null, generation = 0, stopped = false;
  const read = new Map();
  const storageKey = () => identity ? `ccagent.release-read:${identity.origin}:${identity.id}` : '';
  function seen() { try { return localStorage.getItem(storageKey()) || read.get(storageKey()); } catch { return read.get(storageKey()); } }
  function badge() {
    const unread = !!identity && !!latest && newerVersion(latest.version, currentVersion) && seen() !== latest.id;
    accountButton.classList.toggle('has-version-update', unread); entry.classList.toggle('has-version-update', unread);
    accountButton.setAttribute('aria-label', unread ? '账户与退出登录，有版本更新' : '账户与退出登录');
    entry.textContent = unread ? '版本更新 · 新版本' : '版本更新';
  }
  function render() {
    content.replaceChildren();
    status.textContent = currentVersion ? `当前版本 ${currentVersion}` : '';
    if (!latest) { const empty = document.createElement('p'); empty.textContent = '暂无已发布的版本更新。'; content.append(empty); return; }
    const title = document.createElement('h3'); title.textContent = `${latest.title} · ${latest.version}`;
    const date = document.createElement('p'); date.className = 'version-release-date'; const time = Date.parse(latest.publishedAt); date.textContent = Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN') : '';
    const notes = document.createElement('div'); notes.className = 'version-release-notes'; notes.textContent = latest.notes;
    const download = document.createElement('a'); download.className = 'version-download'; download.textContent = '下载新版本'; download.href = latest.downloadUrl; download.target = '_blank'; download.rel = 'noopener noreferrer';
    content.append(title, date, notes, download);
    if (page.open && identity) { read.set(storageKey(), latest.id); try { localStorage.setItem(storageKey(), latest.id); } catch { /* Keep an in-memory acknowledgement when storage is unavailable. */ } badge(); }
  }
  async function refresh(showError = false) {
    if (stopped || !identity) return;
    if (inflight) return inflight;
    const token = generation, expected = { ...identity };
    const operation = (async () => {
      try {
        const response = await fetch('/api/account/releases', { headers: { 'x-ccagent-web': '1' }, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
        const data = await response.json();
        if (token !== generation || stopped) return;
        if (!response.ok) throw new Error(data.error || '检查更新失败，请稍后重试。');
        if (data.userId !== expected.id || data.origin !== expected.origin) return;
        const release = data.release === null ? null : safeRelease(data.release);
        if (data.release !== null && !release) throw new Error('版本信息格式无效，请联系管理员。');
        latest = release; currentVersion = data.currentVersion; badge(); if (page.open) render();
      } catch (error) { if (token === generation && showError && page.open) status.textContent = error.message; }
    })();
    inflight = operation; try { await operation; } finally { if (inflight === operation) inflight = null; }
  }
  entry.addEventListener('click', () => { accountMenu.close(); page.showModal(); render(); void refresh(true); });
  refreshButton.addEventListener('click', () => { status.textContent = '正在检查更新…'; void refresh(true); });
  window.addEventListener('focus', () => void refresh());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  window.addEventListener('storage', event => { if (event.key === storageKey()) badge(); });
  window.addEventListener('ccagent:account-changing', () => { stopped = true; generation++; identity = null; latest = null; badge(); page.close(); });
  setInterval(() => { if (!document.hidden) void refresh(); }, 60000);
  return { setAccount(user, origin) {
    if (stopped || identity?.id === user.id && identity.origin === origin) return;
    generation++; identity = { id: user.id, origin }; latest = null; currentVersion = ''; inflight = null; badge(); if (page.open) render(); void refresh();
  } };
}
