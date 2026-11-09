/** Offline file-panel resizing tests. No workspace content or live service is accessed. */
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createWorkspaceFiles } from '../web/workspace-files.js';

const storageKey = 'ccagent.workspaceFiles.width.v1';
async function fixture({ stored, blockedStorage = false } = {}) {
  const window = new Window({ url: 'http://offline-files.test/' });
  window.document.write('<div class="topbar-tools"></div><main id="content"></main>');
  globalThis.window = window; globalThis.document = window.document;
  let viewport = 1440, available = 1120, observerCallback;
  Object.defineProperty(window, 'innerWidth', { get: () => viewport, configurable: true });
  window.ResizeObserver = class { constructor(callback) { observerCallback = callback; } observe() {} };
  if (stored !== undefined) window.localStorage.setItem(storageKey, stored);
  if (blockedStorage) Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage is blocked'); }, configurable: true });
  const requests = [];
  const files = createWorkspaceFiles({
    getWorkspace: () => 'C:\\fixture', reference() {}, toast() {},
    api: async route => { requests.push(route); assert(route.startsWith('/api/files?')); return { path: '', entries: [], nextOffset: null, total: 0 }; },
  });
  const $ = id => window.document.getElementById(id), body = window.document.querySelector('.workbench-body'), resizer = $('workspace-files-resizer');
  body.getBoundingClientRect = () => ({ width: available });
  const captures = new Set();
  resizer.setPointerCapture = id => captures.add(id);
  resizer.hasPointerCapture = id => captures.has(id);
  resizer.releasePointerCapture = id => { captures.delete(id); pointer('lostpointercapture', id, 0); };
  function pointer(type, id, clientX, extra = {}) {
    resizer.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, clientX, button: 0, isPrimary: true, pointerType: 'mouse', ...extra }));
  }
  function key(value, shiftKey = false) { resizer.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true })); }
  function resize(width, container) { viewport = width; available = container; window.dispatchEvent(new window.Event('resize')); }
  const width = () => Number.parseInt(body.style.getPropertyValue('--workspace-files-width'), 10);
  const clean = () => { assert(!body.classList.contains('files-resizing')); assert(!window.document.documentElement.classList.contains('workspace-files-resizing')); assert.equal(captures.size, 0); };
  await files.workspaceChanged('C:\\fixture');
  return { window, files, $, body, resizer, captures, pointer, key, resize, width, clean, requests, observe: () => observerCallback() };
}

let current;
try {
  current = await fixture();
  const { window, files, $, body, resizer, captures, pointer, key, resize, width, clean, requests, observe } = current;
  assert.equal(resizer.getAttribute('role'), 'separator'); assert.equal(resizer.getAttribute('aria-orientation'), 'vertical');
  assert.equal(resizer.getAttribute('aria-controls'), 'workspace-files'); assert.equal(resizer.tabIndex, 0);
  assert.equal(width(), 432); assert.equal(resizer.getAttribute('aria-valuemax'), '752');
  pointer('pointerdown', 20, 1000, { button: 2 }); pointer('pointermove', 20, 500); clean(); assert.equal(width(), 432);
  pointer('pointerdown', 21, 1000, { isPrimary: false }); clean();
  pointer('pointerdown', 1, 1000); assert(captures.has(1)); assert.equal(document.activeElement, resizer);
  pointer('pointermove', 2, 500); assert.equal(width(), 432, 'Other pointers cannot move the active separator');
  pointer('pointermove', 1, 800); assert.equal(width(), 632, 'Moving the left edge left expands the right panel');
  assert.equal(resizer.getAttribute('aria-valuenow'), '632'); assert.equal(resizer.getAttribute('aria-valuetext'), '632 像素');
  pointer('pointerup', 1, 800); clean(); assert.equal(window.localStorage.getItem(storageKey), '632');
  key('ArrowRight'); assert.equal(width(), 612); key('ArrowLeft', true); assert.equal(width(), 692);
  key('Home'); assert.equal(width(), 300); key('End'); assert.equal(width(), 752);
  pointer('pointerdown', 3, 800); pointer('pointermove', 3, 900); assert.equal(width(), 652);
  pointer('pointercancel', 3, 900); clean(); assert.equal(width(), 752); assert.equal(window.localStorage.getItem(storageKey), '752');
  pointer('pointerdown', 4, 800); pointer('pointermove', 4, 900); key('Escape'); clean(); assert.equal(width(), 752);
  pointer('pointerdown', 5, 800); pointer('pointermove', 5, -5000); assert.equal(width(), 752, 'Maximum leaves the main conversation readable');
  pointer('pointermove', 5, 5000); assert.equal(width(), 300); pointer('pointerup', 5, 5000); clean();
  key('End'); resize(900, 600); assert.equal(width(), 576, 'Overlay width stays within its actual container');
  assert.equal(window.localStorage.getItem(storageKey), '752', 'Viewport clamping does not erase the preferred desktop width');
  resize(375, 375); assert.equal(width(), 375); assert(resizer.classList.contains('hidden')); assert.equal(resizer.tabIndex, -1);
  assert.equal(resizer.getAttribute('aria-disabled'), 'true'); key('Home'); assert.equal(width(), 375);
  resize(1440, 1120); assert.equal(width(), 752); observe(); assert.equal(width(), 752);
  pointer('pointerdown', 6, 800); pointer('pointermove', 6, 900); window.dispatchEvent(new window.Event('blur')); clean(); assert.equal(width(), 652);
  pointer('pointerdown', 7, 800); pointer('pointermove', 7, 850); files.close(); clean();
  assert($('workspace-files').classList.contains('hidden')); assert(resizer.classList.contains('hidden')); assert.equal(document.activeElement, $('workspace-files-toggle'));
  await files.open(); assert.equal(width(), 602);
  pointer('pointerdown', 8, 800); pointer('pointermove', 8, 850); files.setView('agents'); clean(); assert(resizer.classList.contains('hidden'));
  files.setView('tasks'); assert.equal(width(), 552); assert(!resizer.classList.contains('hidden'));
  pointer('pointerdown', 9, 800); pointer('pointermove', 9, 850); captures.delete(9); pointer('lostpointercapture', 9, 850); clean(); assert.equal(width(), 502);
  pointer('pointerdown', 10, 800); window.dispatchEvent(new window.Event('pagehide')); clean();
  pointer('pointerdown', 11, 800); window.dispatchEvent(new window.Event('ccagent:account-changing')); clean();
  pointer('pointerdown', 12, 800, { pointerType: 'touch' });
  Object.defineProperty(window.document, 'hidden', { value: true, configurable: true });
  window.document.dispatchEvent(new window.Event('visibilitychange')); clean();
  assert.equal(requests.length, 2, 'Resizing never reads files again or invokes an agent');
  const saved = window.localStorage.getItem(storageKey); await window.happyDOM.close();
  current = await fixture({ stored: saved }); assert.equal(current.width(), 502, 'Saved width is restored by a fresh panel');
  await current.window.happyDOM.close();
  current = await fixture({ stored: '99999999' }); assert.equal(current.width(), 432, 'Invalid stored widths are ignored');
  await current.window.happyDOM.close();
  current = await fixture({ blockedStorage: true }); current.key('ArrowLeft'); assert.equal(current.width(), 452, 'Blocked storage does not prevent keyboard resizing'); current.clean();
  console.log('Workspace files DOM: pointer capture, direction/bounds, keyboard/ARIA, exact width persistence, viewport restoration, mobile limits, cancel/Escape/blur/close/view/account cleanup and blocked storage passed. No files, models or live APIs accessed.');
} finally { if (current) await current.window.happyDOM.close(); }
