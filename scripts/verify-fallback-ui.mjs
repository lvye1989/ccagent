import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

async function fixture(file) {
  const bytes = await readFile(file), text = bytes[0] === 255 && bytes[1] === 254 ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8');
  try { return JSON.parse(text.split(/\r?\n/).find(line => line.startsWith('{') && line.includes('fixtureOnly'))); }
  catch { throw new Error('INVALID_PRIVATE_FIXTURE_STATE'); }
}
async function control(file, name, prefix) {
  assert.equal(path.basename(file), name); const parent = await realpath(path.dirname(file)), temporary = await realpath(os.tmpdir());
  const [actual, expected] = await Promise.all([stat(path.dirname(parent), { bigint: true }), stat(temporary, { bigint: true })]);
  assert(actual.ino > 0n && actual.ino === expected.ino && actual.dev === expected.dev); assert(path.basename(parent).startsWith(prefix));
  await writeFile(path.join(parent, name), '2');
}
async function until(read, accepted, code, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { const value = await read(); if (accepted(value)) return value; } catch {} await delay(150); }
  throw new Error(code);
}
const { chromium } = createRequire(process.env.CCAGENT_PLAYWRIGHT_PACKAGE)('playwright');
const web = await fixture('output/checks/gateway-fallback-web-private.json'), desktop = await fixture('output/checks/gateway-fallback-desktop-private.json');
const run = randomUUID().slice(0, 8), output = path.resolve('output/checks/fallback-local-ui-' + run), screenshots = path.resolve('output/playwright/fallback-local-ui-' + run);
await mkdir(output, { recursive: true }); await mkdir(screenshots, { recursive: true });
const checks = [], errors = []; let stage = 'web-login', chrome, electron;
const pass = name => { checks.push({ name, passed: true }); console.log(JSON.stringify({ passed: name })); };
const observe = page => page.on('pageerror', () => errors.push({ stage, type: 'pageerror' }));
async function login(page, state) {
  await page.locator('[data-mode="login"]').click();
  assert.equal(await page.locator('#password').getAttribute('type'), 'password', 'LOGIN_PASSWORD_VISIBILITY');
  await page.locator('#email').fill(state.email); await page.locator('#password').fill(state.testPassword); await page.locator('#submit').click();
  await page.waitForURL(url => url.pathname !== '/login');
}
async function welcome(browser) {
  return until(() => Promise.resolve(browser.contexts()[0].pages().find(page => new URL(page.url()).pathname.endsWith('/desktop/welcome.html'))), Boolean, 'WELCOME_PAGE_NOT_READY');
}
async function modelStep(page) {
  await page.locator('#next').waitFor({ state: 'visible' });
  for (let index = 0; index < 2; index++) { await until(() => page.locator('#next').isEnabled(), Boolean, 'WELCOME_NEXT_NOT_READY'); await page.locator('#next').click(); }
  await page.locator('#connection-official').click(); await page.locator('#official-key').waitFor({ state: 'visible' });
}
try {
  chrome = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await chrome.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage(); observe(page);
  await page.goto(web.origin + '/login', { waitUntil: 'networkidle' }); await login(page, web);
  await page.getByRole('button', { name: '设置', exact: true }).first().click(); await page.locator('#settings-nav [data-setting="official"]').click();
  assert.equal(await page.locator('#official-fallback').isDisabled(), true);
  await page.locator('#official-api-key').fill(web.fixtureKey); await page.locator('#settings-content form .settings-primary').click();
  const readWeb = async () => { const response = await context.request.get(web.origin + '/api/customize/official-services'); assert.equal(response.status(), 200); return response.json(); };
  await until(readWeb, value => value.configured, 'WEB_KEY_NOT_VERIFIED'); await page.locator('#official-role-main').waitFor();
  assert.equal(await page.locator('#official-role-main').inputValue(), 'fixture-main'); assert.equal(await page.locator('#official-fallback').isChecked(), false);
  assert((await page.locator('#settings-content').textContent()).includes('备用主模型')); pass('Real Chrome first verification loads defaults and backup prices without enabling fallback');
  stage = 'web-consent';
  await page.locator('#official-role-image').selectOption(''); await page.locator('#official-fallback').check(); await page.locator('#settings-content form .settings-primary').click();
  await until(readWeb, value => value.fallbackEnabled && !value.roles.image, 'WEB_CONSENT_NOT_SAVED');
  await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('button', { name: '设置', exact: true }).first().click(); await page.locator('#settings-nav [data-setting="official"]').click();
  assert.equal(await page.locator('#official-fallback').isChecked(), true); assert.equal(await page.locator('#official-role-image').inputValue(), '');
  await page.screenshot({ path: path.join(screenshots, 'web-consent.png'), fullPage: true }); pass('Real Chrome persists explicit consent and preserves an empty auxiliary choice after reload');
  stage = 'web-reprice';
  await control(web.priceChangeFile, 'change-fallback-price', 'ccagent-login-ui-');
  await page.getByRole('button', { name: '刷新服务目录', exact: true }).click(); await until(readWeb, value => !value.fallbackEnabled && value.routes.some(route => route.id === 'fixture-backup' && route.pricing.version === 2), 'WEB_REPRICE_NOT_REVIEWED');
  await until(() => page.locator('#official-fallback').isChecked(), value => !value, 'WEB_REPRICE_RENDER_NOT_FINISHED');
  assert.equal(await page.locator('#official-fallback').isChecked(), false); assert.equal(await page.locator('#official-role-image').inputValue(), '');
  await page.locator('#official-fallback').check(); await page.locator('#settings-content form .settings-primary').click(); await until(readWeb, value => value.fallbackEnabled, 'WEB_NEW_CONSENT_NOT_SAVED');
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(screenshots, 'web-mobile.png'), fullPage: true }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  pass('Real Chrome price refresh revokes old approval and requires a new explicit confirmation on the narrow layout');
  stage = 'desktop-login';
  electron = await chromium.connectOverCDP(desktop.cdp);
  const loginPage = await until(() => Promise.resolve(electron.contexts()[0].pages().find(page => new URL(page.url()).pathname === '/login')), Boolean, 'DESKTOP_LOGIN_PAGE_NOT_READY', 45000);
  observe(loginPage); await login(loginPage, desktop);
  const setup = await welcome(electron); observe(setup); await modelStep(setup);
  await setup.locator('#official-key').fill(desktop.fixtureKey); await setup.locator('#verify-official').click();
  const readDesktop = () => setup.evaluate(() => window.ccagentSetup.officialServices());
  await until(readDesktop, value => value.configured, 'DESKTOP_KEY_NOT_VERIFIED'); await setup.locator('#official-selection').waitFor({ state: 'visible' });
  assert.equal(await setup.locator('#official-fallback').isChecked(), false); assert.equal(await setup.locator('#setup-official-main').inputValue(), 'fixture-main');
  await setup.locator('#official-prices summary').click(); assert((await setup.locator('#official-price-list').textContent()).includes('备用主模型'));
  pass('Real Electron validates the platform Key and displays primary plus backup rates before opt-in');
  stage = 'desktop-consent';
  await setup.locator('#setup-official-image').selectOption(''); await setup.locator('#official-fallback').check(); await setup.locator('#save-official').click();
  const saved = await until(readDesktop, value => value.fallbackEnabled && !value.roles.image, 'DESKTOP_CONSENT_NOT_SAVED');
  await until(() => setup.locator('#official-result').textContent(), text => text.includes('已保存'), 'DESKTOP_SAVE_NOT_FINISHED');
  assert.equal(await setup.locator('#setup-official-image').inputValue(), '');
  await setup.locator('#save-official').click(); await until(readDesktop, value => value.catalogRevision !== saved.catalogRevision && value.fallbackEnabled, 'DESKTOP_SECOND_SAVE_USED_STALE_REVISION');
  await until(() => setup.locator('#official-result').textContent(), text => text.includes('已保存'), 'DESKTOP_SECOND_SAVE_NOT_FINISHED');
  await setup.screenshot({ path: path.join(screenshots, 'desktop-consent.png'), fullPage: true });
  pass('Real Electron saves consent and an empty auxiliary choice then saves again using the refreshed revision');
  stage = 'desktop-reprice';
  await control(desktop.priceChangeFile, 'change-fallback-price', 'ccagent-electron-ui-');
  await setup.locator('#verify-official').click(); await until(readDesktop, value => !value.fallbackEnabled && value.routes.some(route => route.id === 'fixture-backup' && route.pricing.version === 2), 'DESKTOP_REPRICE_NOT_REVIEWED');
  await until(() => setup.locator('#official-fallback').isChecked(), value => !value, 'DESKTOP_REPRICE_RENDER_NOT_FINISHED');
  assert.equal(await setup.locator('#setup-official-image').inputValue(), ''); await setup.locator('#official-fallback').check(); await setup.locator('#save-official').click();
  await until(readDesktop, value => value.fallbackEnabled, 'DESKTOP_NEW_CONSENT_NOT_SAVED'); pass('Real Electron revokes old approval on repricing and accepts only a fresh review');
  stage = 'desktop-restart';
  const old = await (await fetch(desktop.cdp + '/json/version')).json();
  await control(desktop.restartFile, 'restart-fixture', 'ccagent-electron-ui-');
  await until(async () => (await (await fetch(desktop.cdp + '/json/version')).json()).webSocketDebuggerUrl, value => value !== old.webSocketDebuggerUrl, 'DESKTOP_RESTART_NOT_OBSERVED', 45000);
  electron = await chromium.connectOverCDP(desktop.cdp); const restarted = await welcome(electron); observe(restarted); await modelStep(restarted);
  await until(() => restarted.evaluate(() => window.ccagentSetup.officialServices()), value => value.fallbackEnabled && !value.roles.image, 'DESKTOP_PREFERENCES_DID_NOT_SURVIVE_RESTART');
  assert.equal(await restarted.locator('#official-fallback').isChecked(), true); assert.equal(await restarted.locator('#setup-official-image').inputValue(), '');
  await restarted.screenshot({ path: path.join(screenshots, 'desktop-restart.png'), fullPage: true }); pass('Real Electron process restart preserves the reviewed consent and intentionally empty choice');
  assert.equal(errors.length, 0);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, at: new Date().toISOString(), checks, errors, actualChrome: true, actualElectron: true,
    fixtureAccountsAndPrices: true, paidEndpointsSupported: false, realDatabase: false, realEmails: false, realPayments: false, upstreamCalls: false }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, report: path.relative(process.cwd(), path.join(output, 'report.json')) }));
} catch (error) {
  const sourceLine = String(error.stack).match(/verify-fallback-ui\.mjs:(\d+):\d+/)?.[1];
  const reason = /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : undefined;
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, at: new Date().toISOString(), stage, code: error.name, sourceLine, reason, checks, errors }, null, 2));
  console.error(JSON.stringify({ passed: false, stage, code: error.name, report: path.relative(process.cwd(), path.join(output, 'report.json')) })); process.exitCode = 1;
} finally { await chrome?.close(); }
// Disconnect the test CDP socket; the fixture retains ownership of Electron and its cleanup.
process.exit(process.exitCode || 0);
