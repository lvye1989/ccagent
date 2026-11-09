/** Offline real-DOM bridge contracts. Popup transport is simulated; no account or cloud request. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Window } from 'happy-dom';
import { openAccountCenter } from '../web/account-center.js';

const origin = 'https://accounts.example.test', local = 'http://127.0.0.1:4174';
const fixtureTicket = 'T'.repeat(43);
const ticketReply = () => ({ ticket: fixtureTicket, expiresAt: new Date(Date.now() + 30000).toISOString(), userId: 'fixture-user', origin });
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check, description) { for (let i = 0; i < 200; i++) { if (check()) return; await tick(); } assert.fail(description); }
const watch = promise => { const result = { done: false }; result.finished = promise.then(() => { result.done = true; }, error => { result.done = true; result.error = error; }); return result; };
let serial = 0;
async function scenario(check, { html = '<button id="launch">账户中心</button><textarea id="draft">未保存画布说明</textarea>' } = {}) {
  const browser = new Window({ url: local + '/', settings: { disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false, enableCSSFileLoading: false, enableImageFileLoading: false } });
  browser.document.write(html); browser.localStorage.setItem('existing-account-state', 'preserve');
  const names = ['window', 'document', 'fetch', 'location', 'history', 'CustomEvent', 'setInterval'];
  const originals = new Map(names.map(key => [key, globalThis[key]]));
  const timers = new Map(), messageListeners = new Set(), calls = [], popups = [];
  let nextTimer = 0, inGesture = false, blocked = false, fetcher = () => response(ticketReply());
  const add = browser.addEventListener.bind(browser), remove = browser.removeEventListener.bind(browser);
  browser.addEventListener = (type, listener, ...rest) => { if (type === 'message') messageListeners.add(listener); return add(type, listener, ...rest); };
  browser.removeEventListener = (type, listener, ...rest) => { if (type === 'message') messageListeners.delete(listener); return remove(type, listener, ...rest); };
  browser.setTimeout = (callback, ms) => { const id = ++nextTimer; timers.set(id, { callback, ms, kind: 'timeout' }); return id; };
  browser.setInterval = (callback, ms) => { const id = ++nextTimer; timers.set(id, { callback, ms, kind: 'interval' }); return id; };
  browser.clearTimeout = browser.clearInterval = id => { timers.delete(id); };
  browser.open = (url, name, features) => {
    if (blocked) return null;
    const popup = { url, name, features, inGesture, closed: false, sent: [], postMessage(value, targetOrigin) { this.sent.push({ value, targetOrigin }); } };
    popups.push(popup); return popup;
  };
  for (const key of ['window', 'document', 'location', 'history', 'CustomEvent']) globalThis[key] = key === 'window' ? browser : browser[key];
  globalThis.setInterval = (...args) => browser.setInterval(...args);
  globalThis.fetch = async (route, options = {}) => { const call = { route, options, body: options.body ? JSON.parse(options.body) : undefined }; calls.push(call); return fetcher(call); };
  const channel = popup => new URL(popup.url).searchParams.get('channel');
  const send = (popup, data, { eventOrigin = origin, source = popup } = {}) => browser.dispatchEvent(new browser.MessageEvent('message', { origin: eventOrigin, source, data: { channel: channel(popup), ...data } }));
  const ready = (popup, state = 'signed-state.payload.signature') => send(popup, { type: 'ccagent:account-bridge-ready', state });
  const complete = popup => send(popup, { type: 'ccagent:account-bridge-complete' });
  const gesture = fn => { inGesture = true; try { return fn(); } finally { inGesture = false; } };
  const start = target => watch(gesture(() => openAccountCenter({ origin, target })));
  const fireTimer = (kind, ms) => { const timer = [...timers.values()].find(item => item.kind === kind && (ms === undefined || item.ms === ms)); assert.ok(timer, 'Expected bridge timer'); timer.callback(); };
  try { await check({ browser, $, calls, popups, timers, messageListeners, start, send, ready, complete, channel, gesture, fireTimer, setFetcher: fn => { fetcher = fn; }, blockPopup: value => { blocked = value; } }); }
  finally {
    assert.equal(browser.localStorage.getItem('existing-account-state'), 'preserve', 'Existing account state is never overwritten');
    await browser.happyDOM.close();
    for (const [key, value] of originals) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
  function $(id) { return browser.document.getElementById(id); }
}

await scenario(async ({ $, calls, popups, timers, messageListeners, start, send, ready, complete, channel, browser }) => {
  let outcome;
  $('launch').addEventListener('click', () => { outcome = start('/account/billing'); });
  assert.equal(popups.length, 0, 'Importing/rendering never opens an account window'); $('launch').click();
  assert.equal(popups.length, 1, 'The user gesture synchronously creates the popup');
  const popup = popups[0], url = new URL(popup.url);
  assert.equal(popup.inGesture, true); assert.equal(url.origin, origin); assert.equal(url.pathname, '/account/bridge');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['channel', 'clientOrigin', 'target']);
  assert.equal(url.searchParams.get('clientOrigin'), local); assert.equal(url.searchParams.get('target'), '/account/billing');
  assert.match(channel(popup), /^[A-Za-z0-9_-]{43}$/); assert.equal(calls.length, 0, 'No bridge request precedes trusted cloud readiness');
  complete(popup); await tick(); assert.equal(outcome.done, false, 'A premature complete message cannot authenticate a window');
  send(popup, { type: 'ccagent:account-bridge-ready', state: 'a.b.c' }, { eventOrigin: 'https://attacker.example.test' });
  send(popup, { type: 'ccagent:account-bridge-ready', state: 'a.b.c' }, { source: {} });
  send(popup, { type: 'ccagent:account-bridge-ready', state: 'a.b.c', channel: 'wrong-channel' });
  await tick(); assert.equal(calls.length, 0, 'Origin, exact popup source and channel are independently required');
  ready(popup); ready(popup, 'duplicate.ready.state'); await until(() => popup.sent.length === 1, 'One trusted state issues one ticket');
  assert.equal(calls.length, 1); assert.equal(calls[0].route, '/api/account/bridge'); assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'same-origin'); assert.equal(calls[0].options.headers['x-ccagent-web'], '1');
  assert.deepEqual(calls[0].body, { state: 'signed-state.payload.signature' });
  assert.deepEqual(popup.sent[0], { targetOrigin: origin, value: { type: 'ccagent:account-bridge-ticket', channel: channel(popup), state: 'signed-state.payload.signature', ticket: fixtureTicket } });
  assert.equal(browser.localStorage.length, 1, 'Tickets are not stored locally'); assert.equal($('draft').value, '未保存画布说明');
  complete(popup); await outcome.finished; assert.equal(outcome.error, undefined); assert.equal(timers.size, 0); assert.equal(messageListeners.size, 0);
});

await scenario(async ({ calls, popups, start, ready, complete, send, channel, messageListeners }) => {
  const first = start('/account/keys'), second = start('/admin');
  const [a, b] = popups; assert.notEqual(a.name, b.name); assert.notEqual(channel(a), channel(b));
  send(a, { type: 'ccagent:account-bridge-ready', state: 'cross.window.state' }, { source: b });
  ready(b, 'second.window.state'); ready(a, 'first.window.state'); await until(() => a.sent.length && b.sent.length, 'Concurrent windows each receive their own ticket');
  assert.equal(calls.length, 2); assert.equal(a.sent[0].value.state, 'first.window.state'); assert.equal(b.sent[0].value.state, 'second.window.state');
  complete(a); await first.finished; assert.equal(second.done, false); assert.equal(messageListeners.size, 1);
  complete(b); await second.finished; assert.equal(messageListeners.size, 0);
});

await scenario(async ({ popups, start, ready, setFetcher }) => {
  for (const value of [
    { ...ticketReply(), expiresAt: new Date(Date.now() - 1000).toISOString() },
    { ...ticketReply(), expiresAt: new Date(Date.now() + 180000).toISOString() },
    { ...ticketReply(), origin: 'https://other.example.test' },
    { ...ticketReply(), ticket: 'bad ticket with whitespace' },
  ]) {
    setFetcher(() => response(value)); const outcome = start('/account'); const popup = popups.at(-1); ready(popup);
    await outcome.finished; assert.ok(outcome.error); assert.equal(popup.sent.length, 0, 'Expired or mismatched ticket responses are never sent');
  }
  setFetcher(() => response({ code: 'state_expired', error: '<img src=x onerror=alert(1)>secret' }, 503));
  const outcome = start('/account'); ready(popups.at(-1)); await outcome.finished; assert.match(outcome.error.message, /已过期/); assert.doesNotMatch(outcome.error.message, /img|secret/);
});

await scenario(async ({ calls, popups, start, ready, blockPopup, fireTimer, timers, messageListeners, setFetcher }) => {
  blockPopup(true); const blocked = start('/account'); await blocked.finished; assert.match(blocked.error.message, /拦截/); assert.equal(calls.length, 0); assert.equal(messageListeners.size, 0);
  blockPopup(false); const closed = start('/account'); popups.at(-1).closed = true; fireTimer('interval', 500); await closed.finished; assert.match(closed.error.message, /已关闭/);
  const timedOut = start('/account'); fireTimer('timeout', 120000); await timedOut.finished; assert.match(timedOut.error.message, /超时/); assert.equal(timers.size, 0);
  let release;
  setFetcher(() => new Promise(resolve => { release = () => resolve(response(ticketReply())); }));
  const late = start('/account'); const popup = popups.at(-1); ready(popup); await until(() => release, 'Ticket request can be delayed');
  popup.closed = true; fireTimer('interval', 500); await late.finished; release(); await tick(); assert.equal(popup.sent.length, 0, 'A late ticket cannot reach a cancelled/closed popup');
  assert.equal(messageListeners.size, 0); assert.equal(timers.size, 0);
});

await scenario(async ({ browser, popups, start, ready, setFetcher, timers, messageListeners }) => {
  for (const event of ['pagehide', 'ccagent:account-changing']) {
    let release;
    setFetcher(() => new Promise(resolve => { release = () => resolve(response(ticketReply())); }));
    const outcome = start('/account'); const popup = popups.at(-1); ready(popup); await until(() => release, 'An in-flight ticket can span an account transition');
    browser.dispatchEvent(new browser.Event(event)); await outcome.finished; release(); await tick();
    assert.match(outcome.error.message, /连接已取消/); assert.equal(popup.sent.length, 0, 'Account transition prevents late ticket forwarding');
    assert.equal(timers.size, 0); assert.equal(messageListeners.size, 0);
  }
});

await scenario(async ({ popups, calls, start, ready }) => {
  const invalid = watch(openAccountCenter({ origin, target: 'https://attacker.example.test/' })); await invalid.finished; assert.ok(invalid.error); assert.equal(popups.length, 0);
  const badOrigin = watch(openAccountCenter({ origin: origin + '/unexpected', target: '/account' })); await badOrigin.finished; assert.ok(badOrigin.error); assert.equal(popups.length, 0);
  const oversized = start('/account'); const popup = popups.at(-1); ready(popup, 'x'.repeat(8193)); await oversized.finished;
  assert.ok(oversized.error); assert.equal(calls.length, 0, 'Unbounded bridge state is rejected before transport');
});

await scenario(async ({ browser, $, calls, popups, gesture, ready, complete, setFetcher, messageListeners }) => {
  setFetcher(({ route }) => {
    if (route === '/api/account/status') return response({ user: { id: 'fixture-user', email: 'user@example.test', name: 'User' }, origin });
    if (route === '/api/customize/official-services') return response({ origin, permissions: ['admin.read'], wallet: { available: '1', balance: '100001', frozen: '100000' } });
    if (route === '/api/account/bridge') return response(ticketReply());
    if (route === '/api/account/logout') return response({ error: '模拟退出失败，请重试。' }, 503);
    assert.fail('Unexpected menu route ' + route);
  });
  await import('../web/account-menu.js?account-center-ui=' + ++serial);
  assert.equal(popups.length, 0); $('account-menu').click(); await until(() => browser.document.querySelector('a[href$="/admin"]')?.hidden === false, 'Admin visibility still follows local account permissions');
  assert(browser.document.body.textContent.includes('余额 ¥0.000001 · 冻结 ¥0.10'), 'The local account menu preserves a single micro-yuan as exact yuan');
  const center = browser.document.querySelector('a[href$="/account"]'), admin = browser.document.querySelector('a[href$="/admin"]');
  assert.equal(center.href, origin + '/account'); assert.equal(admin.href, origin + '/admin');
  const centerClick = new browser.MouseEvent('click', { ctrlKey: true, bubbles: true, cancelable: true }); gesture(() => center.dispatchEvent(centerClick));
  assert.equal(centerClick.defaultPrevented, true); assert.equal(popups.at(-1).inGesture, true); ready(popups.at(-1)); await until(() => popups.at(-1).sent.length, 'Account menu center establishes the bridge'); complete(popups.at(-1));
  const adminClick = new browser.MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }); gesture(() => admin.dispatchEvent(adminClick));
  assert.equal(adminClick.defaultPrevented, true); assert.equal(new URL(popups.at(-1).url).searchParams.get('target'), '/admin'); ready(popups.at(-1)); await until(() => popups.at(-1).sent.length, 'Middle-click admin also establishes the bridge'); complete(popups.at(-1));
  assert.equal(calls.filter(call => call.route === '/api/account/bridge').length, 2);
  const logout = [...browser.document.querySelectorAll('button')].find(item => item.textContent === '退出登录 / 切换账户');
  browser.ccagentBeforeAccountChange = async () => false;
  gesture(() => center.click()); const guarded = popups.at(-1); logout.click(); await until(() => browser.document.querySelector('[role="status"]').textContent.includes('画布尚未保存'), 'Canvas preservation can stop account switching');
  assert.equal(calls.some(call => call.route === '/api/account/logout'), false); assert.equal(messageListeners.size, 1, 'A cancelled account switch leaves its valid bridge intact');
  ready(guarded); await until(() => guarded.sent.length, 'Bridge still works when canvas guards prevent logout'); complete(guarded); await tick();
  browser.ccagentBeforeAccountChange = async () => true;
  gesture(() => center.click()); const cancelled = popups.at(-1); logout.click(); await until(() => calls.some(call => call.route === '/api/account/logout'), 'An approved account switch begins logout');
  ready(cancelled); await tick(); assert.equal(cancelled.sent.length, 0); assert.equal(messageListeners.size, 0, 'Actual account changes cancel pending bridge listeners');
}, { html: '<button id="account-menu">U</button><textarea id="draft">未保存画布说明</textarea>' });

console.log('Offline account-center DOM checks passed: explicit synchronous popup, exact origin/source/channel, isolated concurrent windows, POST-only short-lived tickets, expiry/failure/close/timeout/account-change cleanup, safe errors, static hrefs, account/admin gestures and canvas logout guards. No cloud login or paid service was called.');
