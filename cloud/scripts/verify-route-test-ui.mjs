import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const bytes = await readFile(process.env.CCAGENT_ROUTE_TEST_FIXTURE_LOG || '../output/checks/route-tests-ui-private.log'), text = bytes[0] === 255 && bytes[1] === 254 ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8');
const fixture = JSON.parse(text.split(/\r?\n/).find(line => line.startsWith('{') && line.includes('fixtureOnly')));
assert.equal(fixture.fixtureOnly, true); assert(/^ccagent_test_[a-f0-9]{16}$/.test(fixture.schema)); assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(fixture.origin));
assert.equal(path.basename(fixture.modeFile), 'provider-mode');
const [actual, expected] = await Promise.all([stat(path.dirname(path.dirname(fixture.modeFile)), { bigint: true }), stat(os.tmpdir(), { bigint: true })]);
assert(actual.ino > 0n && actual.ino === expected.ino && actual.dev === expected.dev); assert(path.basename(path.dirname(fixture.modeFile)).startsWith('ccagent-route-test-ui-'));
const { chromium } = createRequire(process.env.CCAGENT_PLAYWRIGHT_PACKAGE)('playwright'), run = fixture.schema + '-' + randomUUID().slice(0, 8);
const output = path.resolve('../output/checks/route-test-ui-' + run), screenshots = path.resolve('../output/playwright/route-test-ui-' + run);
await mkdir(output, { recursive: true }); await mkdir(screenshots, { recursive: true });
let browser, stage = 'login'; const checks = [], errors = [], contexts = [];
const pass = name => { checks.push({ name, passed: true }); console.log(JSON.stringify({ passed: name })); };
async function until(read, accepted, code) { const deadline = Date.now() + 45000; while (Date.now() < deadline) { try { const value = await read(); if (accepted(value)) return value; } catch {} await delay(150); } throw new Error(code); }
const metrics = async () => JSON.parse(await readFile(fixture.metricsFile, 'utf8'));
async function login(user) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); contexts.push(context); const page = await context.newPage();
  page.on('pageerror', () => errors.push({ stage, type: 'pageerror' }));
  await page.goto(fixture.origin + '/login', { waitUntil: 'networkidle' }); await page.getByLabel('邮箱地址').fill(user.email); await page.getByLabel('密码', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: '登录账户 →', exact: true }).click(); await page.waitForURL(fixture.origin + '/account'); return { page, context };
}
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const { page, context } = await login(fixture.users[0]); await page.goto(fixture.origin + '/admin/routes', { waitUntil: 'networkidle' });
  const gateway = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '编辑服务网关', exact: true }) }), region = page.getByRole('region', { name: '真实连接检测', exact: true });
  const load = async () => { await gateway.getByLabel('已有路由编号', { exact: true }).fill('probe-ui-chat'); await gateway.getByRole('button', { name: '载入配置', exact: true }).click(); await gateway.getByRole('status').filter({ hasText: '已载入路由' }).waitFor(); };
  const prepare = async () => {
    await region.getByRole('button', { name: '准备连接检测', exact: true }).click(); await until(() => region.getByRole('checkbox').isEnabled(), Boolean, 'PREPARATION_NOT_FINISHED');
    assert.equal(await region.getByRole('checkbox').isChecked(), false); assert.equal(await region.getByRole('button', { name: '发起真实检测', exact: true }).isDisabled(), true);
  };
  const readQuote = async () => { const response = await context.request.get(fixture.origin + '/api/admin/routes/test?routeId=probe-ui-chat'); assert.equal(response.status(), 200); return (await response.json()).quote; };
  const post = body => context.request.post(fixture.origin + '/api/admin/routes/test', { headers: { origin: fixture.origin }, data: body });
  const readTest = async id => { const response = await context.request.get(fixture.origin + '/api/admin/routes/test?' + new URLSearchParams({ routeId: 'probe-ui-chat', testId: id })); assert.equal(response.status(), 200); return (await response.json()).test; };
  const runTest = async (mode, statusName, double = false) => {
    await writeFile(fixture.modeFile, mode); await prepare();
    const previousId = (await region.getByText(/^检测编号：/).allTextContents()).join('').match(/[a-f0-9-]{36}/)?.[0];
    await region.getByRole('checkbox').check();
    if (double) await region.getByRole('button', { name: '发起真实检测', exact: true }).dblclick(); else await region.getByRole('button', { name: '发起真实检测', exact: true }).click();
    const id = await until(async () => (await region.getByText(/^检测编号：/).textContent()).match(/[a-f0-9-]{36}/)?.[0], value => Boolean(value) && value !== previousId, 'NO_TEST_IDENTIFIER');
    await region.getByRole('status').getByText(statusName, { exact: true }).waitFor({ timeout: 45000 });
    const result = await readTest(id); assert.equal(result.id, id); assert.equal(result.userChargeMicro, '0'); assert.equal(JSON.stringify(result).includes(fixture.secret), false); return result;
  };
  await load(); stage = 'free-quote'; await prepare(); const initialQuote = await readQuote();
  assert((await region.textContent()).includes('暂停中的路由')); assert((await region.textContent()).includes('预计公开成本上界')); assert.equal((await metrics()).postRequests, 0);
  assert.equal((await post({ routeId: 'probe-ui-chat', testId: randomUUID(), confirmationFingerprint: initialQuote.confirmationFingerprint, confirmPlatformCost: false })).status(), 400); assert.equal((await metrics()).postRequests, 0);
  pass('Real Next login and saved paused-route quote require a fresh explicit cost confirmation without contacting the TLS provider');
  stage = 'success'; const succeeded = await runTest('success', '检测通过', true);
  assert.equal(succeeded.status, 'succeeded'); assert.equal(succeeded.publicCostMicro, '9'); assert.equal(succeeded.usageVerified, true); assert.equal((await metrics()).postRequests, 1);
  await region.screenshot({ path: path.join(screenshots, 'success-desktop.png') });
  pass('Real browser double-click sends exactly one TLS request and Next after persists one verified platform-paid result');
  stage = 'changed-config';
  await gateway.getByLabel('输出上限（Token）', { exact: true }).fill('127'); await gateway.getByRole('button', { name: '保存路由', exact: true }).click(); await gateway.getByRole('status').filter({ hasText: '路由已保存' }).waitFor();
  const replay = await post({ routeId: 'probe-ui-chat', testId: succeeded.id, confirmationFingerprint: succeeded.confirmationFingerprint, confirmPlatformCost: true }); assert.equal(replay.status(), 200); assert.equal((await replay.json()).replay, true);
  assert.equal((await post({ routeId: 'probe-ui-chat', testId: randomUUID(), confirmationFingerprint: succeeded.confirmationFingerprint, confirmPlatformCost: true })).status(), 409);
  await prepare(); assert((await region.textContent()).includes('较早的已保存配置')); assert.equal((await metrics()).postRequests, 1);
  pass('Changed saved limits reject old approval while historical replay remains free and the UI marks the older configuration');
  stage = 'supplier-denied'; const denied = await runTest('denied', '检测失败');
  assert.equal(denied.status, 'failed'); assert.equal(denied.upstreamStatus, 403); assert.equal(denied.publicCostMicro, null); assert.equal((await metrics()).postRequests, 2); assert.equal((await page.textContent('body')).includes(fixture.secret), false);
  pass('A real TLS 403 becomes a safe failure without echoing supplier secrets or retrying the saved two-retry route');
  stage = 'unmeasured'; const unmeasured = await runTest('missing', '结果待确认');
  assert.equal(unmeasured.status, 'unknown'); assert.equal(unmeasured.code, 'TEST_USAGE_UNVERIFIED'); assert.equal(unmeasured.responseValidated, true); assert.equal(unmeasured.publicCostMicro, null); assert.equal((await metrics()).postRequests, 3);
  pass('A successful transport without supplier usage stays unconfirmed rather than showing a measured bill');
  stage = 'timeout'; const timed = await runTest('slow', '结果待确认');
  assert.equal(timed.status, 'unknown'); assert.equal(timed.code, 'TEST_TIMEOUT'); assert.equal((await metrics()).postRequests, 4);
  await region.getByRole('button', { name: '查询原检测状态', exact: true }).click(); assert.equal((await readTest(timed.id)).code, 'TEST_TIMEOUT'); assert.equal((await metrics()).postRequests, 4);
  pass('A one-second real TLS timeout preserves the original unconfirmed result and status queries never repeat it');
  stage = 'permissions-reload-mobile';
  const ordinary = await login(fixture.users[1]); assert.equal((await ordinary.context.request.get(fixture.origin + '/api/admin/routes/test?routeId=probe-ui-chat')).status(), 403);
  assert.equal((await ordinary.context.request.post(fixture.origin + '/api/admin/routes/test', { headers: { origin: fixture.origin }, data: {} })).status(), 403);
  assert.equal((await ordinary.page.goto(fixture.origin + '/admin/routes', { waitUntil: 'networkidle' })).status(), 404);
  await page.reload({ waitUntil: 'networkidle' }); await load(); await prepare(); await region.getByRole('status').getByText('结果待确认', { exact: true }).waitFor(); assert.equal(await region.getByRole('checkbox').isChecked(), false);
  assert((await region.getByText(/^检测编号：/).textContent()).includes(timed.id)); await region.getByRole('button', { name: '查询原检测状态', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 }); await region.scrollIntoViewIfNeeded(); await region.screenshot({ path: path.join(screenshots, 'unknown-mobile.png') }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal((await metrics()).postRequests, 4); assert.equal((await metrics()).correctAuthorization, true); assert.equal((await metrics()).fixedModelAndBudget, true); assert.equal(errors.length, 0);
  pass('Ordinary users stay blocked and real reload narrow layout and unchecked consent preserve the audited result');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, at: new Date().toISOString(), target: fixture.origin, schema: fixture.schema, checks, errors, actualChrome: true, actualNext: true,
    realDatabase: true, actualTlsProviderRequests: 4, syntheticProvider: true, remoteSupplierRequests: false, systemCertificateStoreChanged: false, realEmails: false, realPayments: false }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, report: path.relative(path.resolve('..'), path.join(output, 'report.json')) }));
} catch (error) {
  const sourceLine = String(error.stack).match(/verify-route-test-ui\.mjs:(\d+):\d+/)?.[1];
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, at: new Date().toISOString(), schema: fixture.schema, stage, code: error.name, sourceLine, checks, errors }, null, 2));
  console.error(JSON.stringify({ passed: false, stage, code: error.name, sourceLine, report: path.relative(path.resolve('..'), path.join(output, 'report.json')) })); process.exitCode = 1;
} finally { for (const context of contexts) await context.close(); await browser?.close(); }
