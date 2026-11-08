/** Offline login UI contracts with simulated HTTP responses; no live account service. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Window } from 'happy-dom';

const html = await fs.readFile(new URL('../web/login.html', import.meta.url), 'utf8');
const sourceUrl = new URL('../web/login.js', import.meta.url).href;
const response = (status, value) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check, label) { for (let i = 0; i < 200; i++) { if (check()) return; await tick(); } assert.fail(label); }
let serial = 0;
async function scenario(handler, check) {
  const browser = new Window({ url: 'http://login.test/login', settings: { disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false, enableCSSFileLoading: false, enableImageFileLoading: false } });
  browser.document.write(html);
  const originals = new Map(['window', 'document', 'fetch'].map(key => [key, globalThis[key]]));
  const calls = [];
  globalThis.window = browser; globalThis.document = browser.document;
  globalThis.fetch = async (route, options = {}) => { const call = { route, options, body: options.body ? JSON.parse(options.body) : undefined }; calls.push(call); return handler(call); };
  const $ = id => browser.document.getElementById(id);
  const submit = id => $(id).dispatchEvent(new browser.Event('submit', { cancelable: true }));
  const boot = import(sourceUrl + '?login-ui-case=' + ++serial);
  try { await check({ $, calls, boot, submit, browser }); await boot; }
  finally { await browser.happyDOM.close(); for (const [key, value] of originals) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
}

let releaseConfig;
await scenario(({ route }) => {
  if (route.endsWith('/config')) return new Promise(resolve => { releaseConfig = () => resolve(response(200, { configured: true, origin: 'https://official.example.test' })); });
  if (route.endsWith('/status')) return response(401, { error: '未登录' });
  if (route.endsWith('/login')) return response(401, { error: '<img src=x onerror=alert(1)>邮箱或密码错误' });
  if (route.endsWith('/register')) return response(200, { message: '验证邮件已发送' });
  if (route.endsWith('/resend-verification')) return response(200, { message: '如果该邮箱已注册且尚未验证，系统将发送验证邮件，请查收。' });
  if (route.endsWith('/forgot')) return response(200, { message: '重置邮件已发送' });
  if (route.endsWith('/setup')) return response(200, { origin: 'https://private.example.test' });
  assert.fail('Unexpected route ' + route);
}, async ({ $, calls, boot, submit, browser }) => {
  assert.equal($('account-panel').hidden, false, 'Login is present before any configuration request finishes');
  assert.equal($('connection-settings').open, false, 'Connection settings are collapsed by default');
  assert.ok($('connection-settings').contains($('server')), 'Raw server address is inside advanced settings');
  await until(() => releaseConfig, 'Configuration read starts'); releaseConfig(); await boot;
  assert.equal($('status').textContent, '', 'Ordinary logged-out status is not shown as an error');
  assert.equal($('server').value, 'https://official.example.test');
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 0, 'Default connection is never saved by the UI');
  $('email').value = 'person@example.test'; $('password').value = 'sample-password'; submit('account-form');
  await until(() => $('status').textContent.includes('邮箱或密码错误'), 'Login failure is shown');
  assert.equal($('status').querySelector('img'), null, 'Service errors are rendered as text');
  assert.equal($('password').value, '', 'Submitted passwords are cleared from the form');
  assert.deepEqual(calls.find(call => call.route.endsWith('/login')).body, { email: 'person@example.test', password: 'sample-password' });
  assert.equal($('account-panel').hidden, false);
  $('show-password').click(); browser.document.querySelector('[data-mode="register"]').click();
  assert.equal($('password').autocomplete, 'new-password'); assert.equal($('show-password').getAttribute('aria-label'), '显示密码');
  $('name').value = '测试用户'; $('password').value = 'new-password'; submit('account-form');
  await until(() => $('status').textContent === '验证邮件已发送', 'Register stays available');
  assert.equal(calls.find(call => call.route.endsWith('/register')).body.name, '测试用户');
  assert.equal($('verification-actions').hidden, false, 'Successful registration offers a resend action');
  assert.equal(calls.filter(call => call.route.endsWith('/resend-verification')).length, 0, 'Showing recovery never sends mail automatically');
  $('name').value = ''; $('password').value = ''; $('resend-verification').click();
  await until(() => $('status').textContent.includes('如果该邮箱已注册且尚未验证'), 'An explicit resend has a generic success notice');
  assert.deepEqual(calls.find(call => call.route.endsWith('/resend-verification')).body, { email: 'person@example.test' }, 'Resend requires no password or registration name');
  browser.document.querySelector('[data-mode="login"]').click(); $('forgot').click();
  assert.equal($('password-row').hidden, true); submit('account-form');
  await until(() => $('status').textContent === '重置邮件已发送', 'Password recovery stays available');
  assert.deepEqual(calls.find(call => call.route.endsWith('/forgot')).body, { email: 'person@example.test' });
  $('back-login').click(); $('connection-settings').open = true; $('server').value = ' https://private.example.test '; submit('setup-form');
  await until(() => $('status').textContent.includes('连接设置已保存'), 'Explicit advanced settings save is supported');
  assert.equal(calls.filter(call => call.route.endsWith('/setup')).length, 1);
  assert.deepEqual(calls.find(call => call.route.endsWith('/setup')).body, { origin: 'https://private.example.test' });
  assert.equal($('connection-settings').open, false); assert.equal($('account-panel').hidden, false);
});

let releaseResend, resendAttempts = 0, loginCode = 'email_not_verified';
await scenario(({ route }) => {
  if (route.endsWith('/config')) return response(200, { configured: true, origin: 'https://official.example.test' });
  if (route.endsWith('/status')) return response(401, { error: '未登录', code: 'unauthorized' });
  if (route.endsWith('/login')) return response(403, { error: '请先完成邮箱验证，再登录。', code: loginCode });
  if (route.endsWith('/register')) return response(503, { error: '账户邮件服务暂不可用。', code: 'mail_unavailable' });
  if (route.endsWith('/resend-verification')) {
    resendAttempts++;
    if (resendAttempts === 1) return new Promise(resolve => { releaseResend = () => resolve(response(503, { error: '账户邮件服务暂不可用，请稍后重试。', code: 'mail_unavailable' })); });
    return response(200, { message: '如果该邮箱已注册且尚未验证，系统将发送验证邮件，请查收。' });
  }
  assert.fail('Unexpected verification fixture route ' + route);
}, async ({ $, calls, boot, submit, browser }) => {
  await boot; assert.equal($('verification-actions').hidden, true);
  $('email').value = 'unverified@example.test'; $('password').value = 'sample-password'; submit('account-form');
  await until(() => !$('verification-actions').hidden, 'Local safe error codes expose verification recovery');
  assert.equal($('password').value, ''); assert.equal(resendAttempts, 0);
  $('resend-verification').click(); await until(() => releaseResend, 'Explicit resend can be delayed');
  assert.equal($('email').disabled, true); assert.equal($('submit').disabled, true); assert.equal($('resend-verification').disabled, true);
  const callsWhileBusy = calls.length;
  $('resend-verification').dispatchEvent(new browser.Event('click')); submit('account-form');
  browser.document.querySelector('[data-mode="register"]').dispatchEvent(new browser.Event('click'));
  await tick(); assert.equal(calls.length, callsWhileBusy, 'Repeated clicks/submits cannot overlap a pending resend'); assert.equal($('title').textContent, '欢迎回来');
  releaseResend(); await until(() => !$('resend-verification').disabled, 'A failed resend allows retry');
  assert.match($('status').textContent, /邮件服务暂不可用/); assert.equal($('verification-actions').hidden, false);
  $('resend-verification').click(); await until(() => $('status').textContent.includes('如果该邮箱'), 'Recovery can be retried after a delivery outage');
  $('email').value = 'different@example.test'; $('email').dispatchEvent(new browser.Event('input'));
  assert.equal($('verification-actions').hidden, true, 'Changing email cannot reuse another email recovery action');
  $('resend-verification').dispatchEvent(new browser.Event('click')); await tick(); assert.equal(resendAttempts, 2);
  loginCode = 'account_exists'; $('password').value = 'sample-password'; submit('account-form');
  await until(() => !$('verification-actions').hidden, 'An existing-account code also offers resend');
  browser.document.querySelector('[data-mode="register"]').click(); $('name').value = '测试用户'; $('password').value = 'sample-password'; submit('account-form');
  await until(() => $('status').textContent.includes('邮件服务暂不可用'), 'Registration delivery failure remains accurate');
  assert.equal($('verification-actions').hidden, false, 'A possibly created unverified account has recovery after registration mail failure');
  assert.equal($('password').value, '');
});

await scenario(({ route }) => route.endsWith('/config') ? response(200, { configured: false }) : response(503, { error: '账户服务正在维护，请稍后重试。' }), async ({ $, boot, submit }) => {
  await boot; assert.equal($('account-panel').hidden, false); assert.equal($('connection-settings').open, false);
  assert.match($('status').textContent, /账户服务尚未就绪/);
  $('email').value = 'person@example.test'; $('password').value = 'sample-password'; submit('account-form');
  await until(() => $('status').textContent.includes('正在维护'), 'Unavailable service reports its actual error');
  assert.equal($('account-panel').hidden, false);
});

await scenario(({ route }) => {
  if (route.endsWith('/config')) return { ok: false, status: 502, json: async () => { throw new SyntaxError('HTML gateway response'); } };
  throw new TypeError('Failed to fetch');
}, async ({ $, boot, submit }) => {
  await boot; assert.equal($('account-panel').hidden, false); assert.match($('status').textContent, /暂时无法读取账户服务设置.*账户服务暂时不可用/);
  assert.doesNotMatch($('status').textContent, /SyntaxError|JSON|邮箱.*验证/);
  $('email').value = 'person@example.test'; $('password').value = 'sample-password'; submit('account-form');
  await until(() => $('status').textContent.includes('无法连接账户服务'), 'Network failure uses a useful error');
  assert.equal($('submit').disabled, false, 'A failed connection allows retry');
});

await scenario(({ route }) => route.endsWith('/config') ? response(200, { configured: true, origin: 'https://official.example.test' }) : response(403, { error: '账户已禁用，请联系管理员。' }), async ({ $, boot }) => {
  await boot; assert.equal($('account-panel').hidden, false); assert.equal($('status').textContent, '账户已禁用，请联系管理员。', 'Account restrictions are not swallowed as ordinary logged-out status');
});

let releaseStaleConfig;
await scenario(({ route }) => {
  if (route.endsWith('/config')) return new Promise(resolve => { releaseStaleConfig = () => resolve(response(200, { configured: true, origin: 'https://old.example.test' })); });
  if (route.endsWith('/setup')) return response(200, { origin: 'https://private.example.test' });
  assert.fail('Stale configuration must not start a session check');
}, async ({ $, boot, submit }) => {
  await until(() => releaseStaleConfig, 'Delayed initial read starts');
  $('connection-settings').open = true; $('server').value = 'https://private.example.test'; submit('setup-form');
  await until(() => $('status').textContent.includes('连接设置已保存'), 'Explicit settings save finishes');
  releaseStaleConfig(); await boot;
  assert.equal($('server').value, 'https://private.example.test', 'Late initial configuration cannot replace an explicit saved change');
  assert.match($('status').textContent, /连接设置已保存/);
});

console.log('Offline login UI passed: immediate login, collapsed advanced settings, no implicit setup writes, login/register/recovery, explicit private service configuration, service errors, safe rendering and delayed configuration handling. No live account service was contacted.');
