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
  const services = document.createElement('button'); services.type = 'button'; services.textContent = '官方服务设置'; services.addEventListener('click', () => { menu.close(); document.dispatchEvent(new CustomEvent('ccagent:official-services')); });
  const logout = document.createElement('button'); logout.type = 'button'; logout.textContent = '退出登录 / 切换账户';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭'; close.addEventListener('click', () => menu.close());
  logout.addEventListener('click', async () => { if (busy) return; busy = true; logout.disabled = true; message.textContent = '正在停止任务并退出…'; try { await request('logout', {}); window.location.replace('/login'); } catch (error) { message.textContent = error.message; } finally { busy = false; logout.disabled = false; } });
  menu.append(title, email, balance, center, services, admin, logout, close, message); document.body.append(menu);
  button.addEventListener('click', async () => {
    menu.showModal(); message.textContent = '正在读取账户信息…'; admin.hidden = true;
    try {
      const response = await fetch('/api/customize/official-services', { headers: { 'x-ccagent-web': '1' }, credentials: 'same-origin' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '账户信息暂时不可用');
      const format = value => { const amount = BigInt(value); return `${amount / 1000000n}.${(amount % 1000000n).toString().padStart(6, '0').slice(0, 4)}`; };
      if (data.wallet) balance.textContent = `余额 ¥${format(data.wallet.available ?? data.wallet.balance)} · 冻结 ¥${format(data.wallet.frozen)}`;
      admin.href = new URL('/admin', data.origin).href; admin.hidden = !data.permissions.includes('admin.read'); message.textContent = '';
    } catch (error) { message.textContent = error.message; }
  });
  async function refresh() {
    try { const data = await request('status'); if (userId && userId !== data.user.id) { window.location.replace('/'); return; } userId = data.user.id; email.textContent = data.user.email; button.textContent = (data.user.name || data.user.email).slice(0, 1).toUpperCase(); button.title = data.user.email; center.href = new URL('/account', data.origin).href; }
    catch (error) { message.textContent = error.message; }
  }
  await refresh();
  // Revoked/disabled sessions return to login even while the user is idle.
  setInterval(() => { if (!busy) void refresh(); }, 15000);
}
