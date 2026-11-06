const $ = (id) => document.getElementById(id);
let mode = 'login', busy = false;
function message(value, error = false) { $('status').textContent = value; $('status').dataset.error = String(error); }
async function api(route, body) {
  const response = await fetch('/api/account/' + route, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: { 'x-ccagent-web': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '暂时无法完成操作，请重试。');
  return value;
}
function setMode(next) {
  if (busy) return;
  mode = next; message('');
  $('name-row').hidden = mode !== 'register'; $('name').required = mode === 'register';
  $('password-row').hidden = mode === 'forgot'; $('password').required = mode !== 'forgot';
  $('password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('password').value = ''; $('password').type = 'password'; $('show-password').textContent = '显示';
  $('forgot').hidden = mode !== 'login'; $('back-login').hidden = mode !== 'forgot';
  $('title').textContent = { login: '欢迎回来', register: '创建你的账户', forgot: '找回密码' }[mode];
  $('description').textContent = { login: '使用邮箱和密码登录，继续你的工作。', register: '注册后会发送验证邮件，请使用可接收邮件的邮箱。', forgot: '输入注册邮箱，我们会发送密码重置邮件。' }[mode];
  $('submit').textContent = { login: '登录 CCAGENT', register: '注册并发送验证邮件', forgot: '发送重置邮件' }[mode];
  document.querySelectorAll('[data-mode]').forEach(button => { if (button.dataset.mode === mode) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
}
function setBusy(value) { busy = value; document.querySelectorAll('form button, .tabs button, .form-links button, #change-server').forEach(button => { button.disabled = value; }); }
function panels(config) { $('setup-panel').hidden = config.configured; $('account-panel').hidden = !config.configured; $('service-origin').textContent = config.origin || ''; $('server').value = config.origin || ''; }
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
$('forgot').addEventListener('click', () => setMode('forgot')); $('back-login').addEventListener('click', () => setMode('login'));
$('show-password').addEventListener('click', () => { const show = $('password').type === 'password'; $('password').type = show ? 'text' : 'password'; $('show-password').textContent = show ? '隐藏' : '显示'; $('show-password').setAttribute('aria-label', show ? '隐藏密码' : '显示密码'); });
$('change-server').addEventListener('click', () => { if (!busy) { $('setup-panel').hidden = false; $('account-panel').hidden = true; $('server').focus(); } });
$('setup-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return; setBusy(true); message('正在连接…');
  try { const config = await api('setup', { origin: $('server').value.trim() }); panels({ configured: true, ...config }); message(''); }
  catch (error) { message(error.message, true); } finally { setBusy(false); }
});
$('account-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return; setBusy(true); message('正在处理，请稍候…');
  const password = $('password').value; $('password').value = '';
  try {
    const value = await api(mode, { email: $('email').value.trim(), ...(mode !== 'forgot' ? { password } : {}), ...(mode === 'register' ? { name: $('name').value.trim() } : {}) });
    if (mode === 'login') { message('登录成功，正在打开工作区…'); window.location.replace('/'); }
    else message(value.message);
  } catch (error) { message(error.message, true); } finally { setBusy(false); }
});
try {
  panels(await api('config'));
  if (!$('account-panel').hidden) { try { await api('status'); window.location.replace('/'); } catch { /* A fresh browser must sign in separately. */ } }
} catch (error) { message(error.message, true); }
