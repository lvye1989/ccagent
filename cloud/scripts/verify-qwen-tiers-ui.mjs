import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const bytes = await readFile(process.env.CCAGENT_ROUTE_TEST_FIXTURE_LOG || '../output/checks/qwen-tiers-ui-private.log');
const text = bytes[0] === 255 && bytes[1] === 254 ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8');
const fixture = JSON.parse(text.split(/\r?\n/).find(line => line.startsWith('{') && line.includes('fixtureOnly')));
assert.equal(fixture.fixtureOnly, true); assert(/^ccagent_test_[a-f0-9]{16}$/.test(fixture.schema)); assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(fixture.origin));
assert.equal(path.basename(fixture.modeFile), 'provider-mode');
const [actual, expected] = await Promise.all([stat(path.dirname(path.dirname(fixture.modeFile)), { bigint: true }), stat(os.tmpdir(), { bigint: true })]);
assert(actual.ino > 0n && actual.ino === expected.ino && actual.dev === expected.dev); assert(path.basename(path.dirname(fixture.modeFile)).startsWith('ccagent-route-test-ui-'));
const { chromium } = createRequire(process.env.CCAGENT_PLAYWRIGHT_PACKAGE)('playwright');
const run = fixture.schema + '-' + randomUUID().slice(0, 8), output = path.resolve('../output/checks/qwen-tiers-ui-' + run), screenshots = path.resolve('../output/playwright/qwen-tiers-ui-' + run);
await mkdir(output, { recursive: true }); await mkdir(screenshots, { recursive: true });
let browser, stage = 'login'; const contexts = [], checks = [], errors = [];
const pass = name => { checks.push({ name, passed: true }); console.log(JSON.stringify({ passed: name })); };
async function login(user) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); contexts.push(context);
  const page = await context.newPage(); page.on('pageerror', () => errors.push({ stage, type: 'pageerror' }));
  await page.goto(fixture.origin + '/login', { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱地址').fill(user.email); await page.getByLabel('密码', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: '登录账户 →', exact: true }).click(); await page.waitForURL(fixture.origin + '/account'); return page;
}
async function load(page, heading) {
  const section = page.getByRole('heading', { name: heading, exact: true }).locator('..');
  await section.getByLabel('已有路由编号', { exact: true }).fill('probe-ui-chat');
  await section.getByRole('button', { name: '载入配置', exact: true }).click();
  await section.getByRole('status').filter({ hasText: '已载入路由' }).waitFor(); return section;
}
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await login(fixture.users[0]); let costWrites = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/admin/prices') costWrites++; });
  stage = 'change-provider'; await page.goto(fixture.origin + '/admin/routes', { waitUntil: 'networkidle' });
  const route = await load(page, '编辑服务网关'); await route.getByLabel('供应商编号', { exact: true }).fill('qwen');
  await route.getByRole('button', { name: '保存路由', exact: true }).click();
  await route.getByRole('status').filter({ hasText: '路由已保存并暂停开放' }).waitFor();
  pass('Changing the saved provider pauses the route and requires a new matching cost version');

  stage = 'edit-tiers'; await page.goto(fixture.origin + '/admin/prices', { waitUntil: 'networkidle' });
  let panel = await load(page, '新增成本版本'); await panel.getByLabel('价格策略', { exact: true }).selectOption('qwen-input-tiers');
  await panel.getByLabel('供应商最大思考长度（Token）', { exact: true }).fill('32');
  const values = [['128', '2', '0', '4', '8'], ['256', '6', '0.6', '12', '24'], ['4096', '10', '1', '20', '40']];
  for (const [index, valuesInRow] of values.entries()) {
    if (index) await panel.getByRole('button', { name: '增加输入档位', exact: true }).click();
    const group = panel.getByRole('group', { name: `输入档位 ${index + 1}`, exact: true });
    for (const [position, label] of ['本档输入总 Token 上限（含本数）', '未缓存输入单价（CNY）', '缓存输入单价（CNY）', '非思考输出单价（CNY）', '思考输出单价（CNY）'].entries()) await group.getByLabel(label, { exact: true }).fill(valuesInRow[position]);
  }
  stage = 'reject-invalid-tiers';
  await panel.getByRole('group', { name: '输入档位 2', exact: true }).getByLabel('本档输入总 Token 上限（含本数）', { exact: true }).fill('128');
  await panel.getByRole('button', { name: '追加成本版本', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: '按升序填写整数 Token 边界' }).waitFor(); assert.equal(costWrites, 0);
  pass('Duplicate tier boundaries show an actionable form error before sending a price write');

  stage = 'save-and-reload';
  await panel.getByRole('group', { name: '输入档位 2', exact: true }).getByLabel('本档输入总 Token 上限（含本数）', { exact: true }).fill('256');
  await panel.getByRole('button', { name: '追加成本版本', exact: true }).click();
  await panel.getByRole('status').filter({ hasText: '成本版本 v2 已追加' }).waitFor(); assert.equal(costWrites, 1);
  await page.reload({ waitUntil: 'networkidle' }); panel = await load(page, '新增成本版本');
  assert.equal(await panel.getByLabel('价格策略', { exact: true }).inputValue(), 'qwen-input-tiers');
  assert.equal(await panel.getByLabel('供应商最大思考长度（Token）', { exact: true }).inputValue(), '32');
  assert.equal(await panel.getByRole('group', { name: '输入档位 1', exact: true }).getByLabel('缓存输入单价（CNY）', { exact: true }).inputValue(), '0');
  assert.equal(await panel.getByRole('group', { name: '输入档位 3', exact: true }).getByLabel('思考输出单价（CNY）', { exact: true }).inputValue(), '40');
  assert.equal(await panel.getByRole('group').count(), 3); assert(!(await panel.textContent()).includes('undefined'));
  await panel.screenshot({ path: path.join(screenshots, 'prices-desktop.png') });
  pass('The real price form appends and reloads every input tier, zero cache price and thinking price without flattening');

  stage = 'mode-and-fingerprint';
  const getQuote = async () => { const result = await page.request.get(fixture.origin + '/api/admin/routes/test?routeId=probe-ui-chat'); assert.equal(result.status(), 200); return (await result.json()).quote; };
  const before = await getQuote(); await panel.getByLabel('默认思考模式', { exact: true }).selectOption('true');
  await panel.getByRole('button', { name: '追加成本版本', exact: true }).click();
  await panel.getByRole('status').filter({ hasText: '成本版本 v3 已追加' }).waitFor();
  const after = await getQuote(); assert.notEqual(after.confirmationFingerprint, before.confirmationFingerprint);
  assert.equal(after.pricing.definition.tariff.defaultThinking, true); assert.equal(after.pricing.version, 3);
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await panel.screenshot({ path: path.join(screenshots, 'prices-mobile.png') });
  pass('Changing the default priced mode appends a version, invalidates old consent and remains usable at narrow width');

  stage = 'ordinary-user';
  const ordinary = await login(fixture.users[1]);
  const denied = await ordinary.request.post(fixture.origin + '/api/admin/prices', { headers: { origin: fixture.origin }, data: { routeId: 'probe-ui-chat', currency: 'CNY', definition: after.pricing.definition, sourceUrl: 'https://example.invalid/synthetic-prices', effectiveAt: new Date().toISOString() } });
  assert.equal(denied.status(), 403); assert.equal((await getQuote()).pricing.version, 3);
  const metrics = JSON.parse(await readFile(fixture.metricsFile, 'utf8')); assert.equal(metrics.postRequests, 0); assert.equal(costWrites, 2); assert.equal(errors.length, 0);
  pass('An ordinary real account cannot publish tier prices and all UI checks dispatch zero supplier requests');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, schema: fixture.schema, fixtureOnly: true, actualProviders: false, actualMoney: false, priceWrites: costWrites, supplierRequests: metrics.postRequests, checks, errors, screenshots }, null, 2));
  console.log(JSON.stringify({ passed: true, groups: checks.length, supplierRequests: metrics.postRequests, report: path.join(output, 'report.json') }));
} catch (error) {
  for (const [index, context] of contexts.entries()) for (const page of context.pages()) await page.screenshot({ path: path.join(screenshots, `failure-${index}.png`), fullPage: true }).catch(() => {});
  const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : error instanceof Error ? error.name : 'unknown';
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, schema: fixture.schema, stage, code, checks, errors }, null, 2));
  console.error(JSON.stringify({ failed: true, stage, code, report: path.join(output, 'report.json') })); process.exitCode = 1;
} finally { await Promise.allSettled(contexts.map(context => context.close())); await browser?.close(); }
