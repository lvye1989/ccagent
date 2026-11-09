import { openAccountCenter } from './account-center.js';

const button = document.getElementById('account-menu');
let busy = false, userId;
async function request(route, body) {
  const response = await fetch('/api/account/' + route, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: { 'x-ccagent-web': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (response.status === 401 || response.status === 403) window.location.replace('/login');
  if (!response.ok) throw new Error(data.error || '账户服务暂时不可用。');
  return data;
}
if (button) {
  const menu = document.createElement('dialog'); menu.className = 'account-dialog';
  const title = document.createElement('h2'); title.textContent = '你的账户';
  const email = document.createElement('p');
  const balance = document.createElement('p'); balance.textContent = '余额信息可在用户中心查看';
  const message = document.createElement('p'); message.setAttribute('role', 'status');
  const center = document.createElement('a'); center.textContent = '余额、充值与个人 Key'; center.target = '_blank'; center.rel = 'noopener noreferrer';
  const admin = document.createElement('a'); admin.textContent = '管理后台'; admin.target = '_blank'; admin.rel = 'noopener noreferrer'; admin.hidden = true;
  for (const [link, target] of [[center, '/account'], [admin, '/admin']]) {
    const open = event => {
      if (event.type === 'auxclick' && event.button !== 1) return;
      event.preventDefault();
      if (!link.hasAttribute('href')) { message.textContent = '账户信息尚未就绪，请稍后重试。'; return; }
      void openAccountCenter({ origin: new URL(link.href).origin, target }).catch(error => { message.textContent = error.message; });
    };
    link.addEventListener('click', open); link.addEventListener('auxclick', open);
  }
  const logout = document.createElement('button'); logout.type = 'button'; logout.textContent = '退出登录 / 切换账户';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭'; close.addEventListener('click', () => menu.close());
  logout.addEventListener('click', async () => {
    if (busy) return;
    busy = true; logout.disabled = true; message.textContent = '正在保存画布并退出…';
    try {
      if (typeof window.ccagentBeforeAccountChange === 'function' && !await window.ccagentBeforeAccountChange()) {
        throw new Error('画布尚未保存，请关闭此窗口后重试保存或导出备份。');
      }
      window.dispatchEvent(new window.Event('ccagent:account-changing'));
      await request('logout', {}); window.location.replace('/login');
    } catch (error) { message.textContent = error.message; }
    finally { busy = false; logout.disabled = false; }
  });
  menu.append(title, email, balance, center, admin, logout, close, message); document.body.append(menu);
  button.addEventListener('click', async () => {
    menu.showModal(); message.textContent = '正在读取账户信息…'; admin.hidden = true;
    try {
      const response = await fetch('/api/customize/official-services', { headers: { 'x-ccagent-web': '1' }, credentials: 'same-origin' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '账户信息暂时不可用');
      const format = value => { const amount = BigInt(value), absolute = amount < 0n ? -amount : amount; return `${amount < 0n ? '-' : ''}${absolute / 1000000n}.${(absolute % 1000000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')}`; };
      if (data.wallet) balance.textContent = `余额 ¥${format(data.wallet.available ?? data.wallet.balance)} · 冻结 ¥${format(data.wallet.frozen)}`;
      admin.href = new URL('/admin', data.origin).href; admin.hidden = !data.permissions.includes('admin.read'); message.textContent = '';
    } catch (error) { message.textContent = error.message; }
  });
  async function refresh() {
    try { const data = await request('status'); if (userId && userId !== data.user.id) { window.dispatchEvent(new window.Event('ccagent:account-changing')); window.location.replace('/'); return; } userId = data.user.id; email.textContent = data.user.email; button.textContent = (data.user.name || data.user.email).slice(0, 1).toUpperCase(); button.title = data.user.email; center.href = new URL('/account', data.origin).href; }
    catch (error) { message.textContent = error.message; }
  }
  await refresh();
  // Revoked/disabled sessions return to login even while the user is idle.
  setInterval(() => { if (!busy) void refresh(); }, 15000);
}
