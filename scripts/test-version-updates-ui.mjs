import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createVersionUpdates, newerVersion } from '../web/version-updates.js';
const window = new Window({ url: 'http://offline-ui.test/' });
for (const name of ['window', 'document', 'localStorage']) globalThis[name] = name === 'window' ? window : window[name];
const originalInterval = globalThis.setInterval, intervals = []; globalThis.setInterval = fn => { intervals.push(fn); return 0; };
const release = { id: '11111111-1111-4111-8111-111111111111', version: '0.1.4', title: '<img src=x>', notes: '更新内容\n<script>literal</script>', downloadUrl: 'https://example.invalid/app.exe', publishedAt: '2026-11-11T12:00:00.000Z' };
let payload = { userId: 'first', origin: 'https://account.example.invalid', currentVersion: '0.1.3', release }, failure = false, requestCount = 0;
globalThis.fetch = async () => { requestCount++; if (failure) throw new Error('offline'); return new Response(JSON.stringify(payload)); };
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
try {
  for (const [a, b, expected] of [['0.1.10', '0.1.9', true], ['0.1.4', '0.1.4', false], ['0.1.3', '0.2.0', false], ['bad', '0.1.0', false]]) assert.equal(newerVersion(a, b), expected);
  const button = document.createElement('button'), menu = document.createElement('dialog'), admin = document.createElement('a'); admin.textContent = '管理后台'; menu.append(admin); document.body.append(button, menu);
  const ui = createVersionUpdates({ accountButton: button, accountMenu: menu, after: admin }); ui.setAccount({ id: 'first' }, payload.origin); await settle();
  const entry = document.querySelector('.version-updates-entry'), page = document.querySelector('.version-updates-dialog');
  assert.equal(admin.nextElementSibling, entry); assert(button.classList.contains('has-version-update')); assert(!page.open);
  menu.showModal(); entry.click(); await settle(); assert(page.open); assert(!button.classList.contains('has-version-update')); assert.equal(menu.open, false);
  assert.equal(page.querySelector('img'), null); assert.equal(page.querySelector('script'), null); assert.match(page.textContent, /<script>literal/); assert.equal(page.querySelector('a').href, release.downloadUrl);
  page.close(); intervals[0](); await settle(); assert(!button.classList.contains('has-version-update'), 'Read acknowledgement persists');
  payload = { ...payload, release: { ...release, id: '22222222-2222-4222-8222-222222222222', version: '0.1.5' } }; intervals[0](); await settle(); assert(button.classList.contains('has-version-update'));
  failure = true; intervals[0](); await settle(); assert(button.classList.contains('has-version-update'), 'Offline check preserves the last known unread notification');
  failure = false; payload = { ...payload, userId: 'second' }; ui.setAccount({ id: 'second' }, payload.origin); await settle(); assert(button.classList.contains('has-version-update'), 'Accounts do not share read markers');
  payload = { ...payload, currentVersion: '0.1.5' }; intervals[0](); await settle(); assert(!button.classList.contains('has-version-update'), 'Installed/current versions do not show an update badge');
  payload = { ...payload, currentVersion: '0.1.3', release: { ...release, downloadUrl: 'javascript:alert(1)' } }; intervals[0](); await settle(); assert(!button.classList.contains('has-version-update'), 'Unsafe releases cannot replace validated data');
  const before = requestCount; window.dispatchEvent(new window.Event('ccagent:account-changing')); intervals[0](); await settle(); assert.equal(requestCount, before); assert(!page.open);
  console.log('Version updates UI passed: menu placement, version comparison, red dot, explicit reading, account isolation, offline preservation, safe text/links and logout cleanup.');
} finally { globalThis.setInterval = originalInterval; await window.happyDOM.close(); }
