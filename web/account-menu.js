const button = document.getElementById('account-menu');
let busy = false;
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
  const message = document.createElement('p'); message.setAttribute('role', 'status');
  const center = document.createElement('a'); center.textContent = '余额、充值与个人 Key'; center.target = '_blank'; center.rel = 'noopener noreferrer';
  const logout = document.createElement('button'); logout.type = 'button'; logout.textContent = '退出登录 / 切换账户';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭'; close.addEventListener('click', () => menu.close());
  logout.addEventListener('click', async () => { if (busy) return; busy = true; logout.disabled = true; message.textContent = '正在停止任务并退出…'; try { await request('logout', {}); window.location.replace('/login'); } catch (error) { message.textContent = error.message; } finally { busy = false; logout.disabled = false; } });
  menu.append(title, email, center, logout, close, message); document.body.append(menu);
  button.addEventListener('click', () => menu.showModal());
  async function refresh() {
    try { const data = await request('status'); email.textContent = data.user.email; button.textContent = (data.user.name || data.user.email).slice(0, 1).toUpperCase(); button.title = data.user.email; center.href = new URL('/account', data.origin).href; }
    catch (error) { message.textContent = error.message; }
  }
  await refresh();
  // Revoked/disabled sessions return to login even while the user is idle.
  setInterval(() => { if (!busy) void refresh(); }, 15000);
}
