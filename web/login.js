const $ = (id) => document.getElementById(id);
let mode = 'login', busy = false;
let interactionRevision = 0;
let verificationEmail = '';
function message(value, error = false) { $('status').textContent = value; $('status').dataset.error = String(error); }
function verificationOption(email = '') { verificationEmail = email && email.toLowerCase() === $('email').value.trim().toLowerCase() ? email : ''; $('verification-actions').hidden = !verificationEmail; }
async function api(route, body) {
  let response;
  try { response = await fetch('/api/account/' + route, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: { 'x-ccagent-web': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
  catch { throw new Error('无法连接账户服务，请检查网络后重试。'); }
  let value;
  try { value = await response.json(); } catch { /* The service may return an HTML error page while unavailable. */ }
  if (!response.ok || !value || typeof value !== 'object' || Array.isArray(value)) {
    const detail = typeof value?.error === 'string' && value.error ? value.error : response.status >= 500 ? '账户服务暂时不可用，请稍后重试。' : !response.ok ? '暂时无法完成操作，请重试。' : '账户服务返回了无效响应，请稍后重试。';
    const error = new Error(detail); error.status = response.status; if (typeof value?.code === 'string') error.code = value.code; throw error;
  }
  return value;
}
function setMode(next) {
  if (busy) return;
  interactionRevision++; mode = next; message(''); verificationOption();
  $('name-row').hidden = mode !== 'register'; $('name').required = mode === 'register';
  $('password-row').hidden = mode === 'forgot'; $('password').required = mode !== 'forgot';
  $('password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('password').value = ''; $('password').type = 'password'; $('show-password').textContent = '显示'; $('show-password').setAttribute('aria-label', '显示密码');
  $('forgot').hidden = mode !== 'login'; $('back-login').hidden = mode !== 'forgot';
  $('title').textContent = { login: '欢迎回来', register: '创建你的账户', forgot: '找回密码' }[mode];
  $('description').textContent = { login: '使用邮箱和密码登录，继续你的工作。', register: '注册后会发送验证邮件，请使用可接收邮件的邮箱。', forgot: '输入注册邮箱，我们会发送密码重置邮件。' }[mode];
  $('submit').textContent = { login: '登录 CCAGENT', register: '注册并发送验证邮件', forgot: '发送重置邮件' }[mode];
  document.querySelectorAll('[data-mode]').forEach(button => { if (button.dataset.mode === mode) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
}
function setBusy(value) { busy = value; document.querySelectorAll('form input, form button, .tabs button, .form-links button').forEach(control => { control.disabled = value; }); }
function connectionConfig(config) { const origin = typeof config.origin === 'string' ? config.origin : ''; $('service-origin').textContent = origin || '官方账户服务'; $('server').value = origin; }
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
$('forgot').addEventListener('click', () => setMode('forgot')); $('back-login').addEventListener('click', () => setMode('login'));
$('email').addEventListener('input', () => { verificationOption(); });
$('show-password').addEventListener('click', () => { const show = $('password').type === 'password'; $('password').type = show ? 'text' : 'password'; $('show-password').textContent = show ? '隐藏' : '显示'; $('show-password').setAttribute('aria-label', show ? '隐藏密码' : '显示密码'); });
$('setup-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return; interactionRevision++; setBusy(true); message('正在连接…');
  try { const config = await api('setup', { origin: $('server').value.trim() }); connectionConfig(config); $('connection-settings').open = false; $('password').value = ''; verificationOption(); message('账户服务连接设置已保存，请登录。'); }
  catch (error) { message(error.message, true); } finally { setBusy(false); }
});
$('resend-verification').addEventListener('click', async () => {
  if (busy || !verificationEmail) return;
  const email = $('email').value.trim();
  if (!email || email.toLowerCase() !== verificationEmail.toLowerCase()) { verificationOption(); return; }
  if (!$('email').reportValidity()) return;
  interactionRevision++; setBusy(true); $('password').value = ''; message('正在重新发送验证邮件…');
  try { const value = await api('resend-verification', { email }); message(value.message); }
  catch (error) { message(error.message, true); } finally { setBusy(false); }
});
$('account-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return; interactionRevision++; setBusy(true); verificationOption(); message('正在处理，请稍候…');
  const action = mode, email = $('email').value.trim();
  const password = $('password').value; $('password').value = '';
  try {
    const value = await api(action, { email, ...(action !== 'forgot' ? { password } : {}), ...(action === 'register' ? { name: $('name').value.trim() } : {}) });
    if (action === 'login') { message('登录成功，正在打开工作区…'); window.location.replace('/'); }
    else { message(value.message); if (action === 'register') verificationOption(email); }
  } catch (error) { message(error.message, true); if (['email_not_verified', 'account_exists'].includes(error.code) || (action === 'register' && error.code === 'mail_unavailable')) verificationOption(email); } finally { setBusy(false); }
});
try {
  const revision = interactionRevision, config = await api('config');
  if (revision === interactionRevision) {
    connectionConfig(config);
    if (config.configured === false) message('账户服务尚未就绪，请稍后重试登录。', true);
    else { try { await api('status'); if (revision === interactionRevision) window.location.replace('/'); } catch (error) { if (revision === interactionRevision && error.status !== 401) { message(error.message, true); if (['email_not_verified', 'account_exists'].includes(error.code)) verificationOption($('email').value.trim()); } } }
  }
} catch (error) { if (interactionRevision === 0) message('暂时无法读取账户服务设置。' + error.message, true); }
