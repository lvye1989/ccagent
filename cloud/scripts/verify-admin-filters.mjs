import './load-env.ts';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';

const target = process.env.CCAGENT_PREVIEW_URL, token = process.env.VERCEL_OIDC_TOKEN;
assert(/^https:\/\/ccagent-cloud-[a-z0-9]+-lvye-1989s-projects\.vercel\.app$/.test(target || '')); assert(token);
const fixture = JSON.parse(await readFile(process.env.CCAGENT_FIXTURE_FILE, 'utf8'));
assert(/^ccagent_test_[a-f0-9]{16}$/.test(fixture.schema));
const { chromium } = createRequire(process.env.CCAGENT_PLAYWRIGHT_PACKAGE)('playwright');
const run = `${fixture.schema}-${randomUUID().slice(0, 8)}`;
const output = path.resolve('../output/checks/admin-filters-' + run), screenshots = path.resolve('../output/playwright/admin-filters-' + run);
await mkdir(output, { recursive: true }); await mkdir(screenshots, { recursive: true });
const checks = [], errors = [], contexts = [];
const resumeMobile = process.argv.includes('--resume-mobile');
let browser, stage = 'protection';
const pass = name => { checks.push({ name, passed: true }); console.log(JSON.stringify({ passed: name })); };
const headers = { 'x-vercel-trusted-oidc-idp-token': token, origin: target };
const query = { user: fixture.users[0].email, from: '2026-11-07', to: '2026-11-07', service: 'chat', status: 'settled', route: 'filter-chat', task: 'task-main' };
const assertFilters = value => { const params = new URL(value, target).searchParams; for (const [key, item] of Object.entries(query)) assert.equal(params.get(key), item); };
async function context() {
  const current = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await current.route('**/*', route => new URL(route.request().url()).origin === target ? route.continue({ headers: { ...route.request().headers(), 'x-vercel-trusted-oidc-idp-token': token } }) : route.continue());
  current.on('page', page => { page.on('pageerror', () => errors.push({ stage, type: 'pageerror' })); page.on('response', response => { if (new URL(response.url()).origin === target && response.status() >= 500) errors.push({ stage, path: new URL(response.url()).pathname, status: response.status() }); }); });
  contexts.push(current); return current;
}
async function login(current, user) {
  const page = await current.newPage(); await page.goto(target + '/login', { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱地址').fill(user.email); await page.getByLabel('密码', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: '登录账户 →', exact: true }).click(); await page.waitForURL(target + '/account'); return page;
}
try {
  let admin, page, csv = '';
  if (!resumeMobile) {
  const external = await fetch(target + '/login', { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  assert([401, 403].includes(external.status) || (external.status === 302 && new URL(external.headers.get('location'), target).hostname === 'vercel.com')); await external.body?.cancel(); pass('Preview protection remains enabled');
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  if (!resumeMobile) {
  stage = 'ordinary-user-and-shared-pager';
  const userContext = await context(), userPage = await login(userContext, fixture.users[0]);
  const denied = await userContext.request.get(target + '/api/admin/data/usage?' + new URLSearchParams(query), { headers }); assert.equal(denied.status(), 403);
  const ordinaryAdmin = await userPage.goto(target + '/admin/usage', { waitUntil: 'networkidle' }); assert.equal(ordinaryAdmin.status(), 404);
  await userPage.goto(target + '/account/usage?pageSize=1&q=task-main', { waitUntil: 'networkidle' });
  const nextUser = await userPage.getByRole('link', { name: '下一页', exact: true }).getAttribute('href'); assert.equal(new URL(nextUser, target).searchParams.get('q'), 'task-main');
  await userPage.getByRole('link', { name: '下一页', exact: true }).click(); await userPage.waitForURL(url => url.searchParams.get('page') === '2');
  assert.equal(new URL(userPage.url()).searchParams.get('q'), 'task-main'); pass('Ordinary user denied admin pages and API shared personal usage pager still keeps keyword');
  stage = 'browser-combined-filters';
  admin = await context(); page = await login(admin, fixture.users[1]);
  const overview = await (await admin.request.get(target + '/api/admin/overview', { headers })).json(); assert.equal(overview.schema, fixture.schema);
  await page.goto(target + '/admin/usage?pageSize=1', { waitUntil: 'networkidle' });
  for (const [name, value] of Object.entries(query)) {
    const field = page.locator(`form.admin-filters [name="${name}"]`);
    if (['status', 'service'].includes(name)) await field.selectOption(value); else await field.fill(value);
  }
  await page.locator('form.admin-filters [name="pageSize"]').selectOption('1');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await page.waitForURL(url => url.searchParams.get('user') === query.user); await page.waitForLoadState('networkidle');
  assertFilters(page.url()); assert.equal(await page.locator('tbody tr').count(), 1);
  assert((await page.locator('.pagination').textContent()).includes('共 2 条'));
  assert((await page.getByRole('region', { name: '筛选结果汇总' }).textContent()).includes('¥0.0003'));
  await page.screenshot({ path: path.join(screenshots, 'filtered-usage-desktop.png'), fullPage: true });
  pass('Browser seven combined filters produce two matching calls all result money total and one row page');
  stage = 'filtered-paging-and-download';
  const next = await page.getByRole('link', { name: '下一页', exact: true }).getAttribute('href'); assertFilters(next);
  await page.getByRole('link', { name: '下一页', exact: true }).click(); await page.waitForURL(url => url.searchParams.get('page') === '2'); await page.waitForLoadState('networkidle');
  assertFilters(page.url()); assert.equal(await page.locator('tbody tr').count(), 1);
  assert((await page.getByRole('region', { name: '筛选结果汇总' }).textContent()).includes('¥0.0003'));
  const exportLink = page.getByRole('link', { name: '导出当前筛选 CSV', exact: true }); assertFilters(await exportLink.getAttribute('href'));
  const waiting = page.waitForEvent('download'); await exportLink.click(); const download = await waiting;
  const chunks = []; for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  csv = Buffer.concat(chunks).toString('utf8'); assert.equal(csv.trim().split('\r\n').length, 3); assert.equal((csv.match(/task-main/g) || []).length, 2); assert(!/password|secret|hash/i.test(csv));
  assert.equal(download.suggestedFilename(), 'ccagent-usage.csv');
  pass('Next page retains every filter browser CSV download contains both selected calls and no credentials');
  stage = 'task-summary-tab';
  const taskLink = page.getByRole('link', { name: '任务汇总', exact: true }); assertFilters(await taskLink.getAttribute('href'));
  await taskLink.click(); await page.waitForURL(url => url.pathname === '/admin/tasks'); await page.waitForLoadState('networkidle'); assertFilters(page.url());
  assert.equal(await page.locator('tbody tr').count(), 1); assert((await page.locator('.pagination').textContent()).includes('共 1 条'));
  const taskTotals = await page.getByRole('region', { name: '筛选结果汇总' }).textContent(); assert(taskTotals.includes('¥0.0003')); assert(taskTotals.includes('调用次数合计2'));
  pass('Task summary tab carries filters and aggregates only matching calls without other user dates or services');
  } else {
    admin = await context(); page = await login(admin, fixture.users[1]);
    await page.goto(target + '/admin/tasks?' + new URLSearchParams({ ...query, pageSize: '1' }), { waitUntil: 'networkidle' });
    assert((await page.getByRole('region', { name: '筛选结果汇总' }).textContent()).includes('¥0.0003'));
  }
  stage = 'mobile-and-invalid-filter';
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(screenshots, 'filtered-tasks-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.goto(target + '/admin/usage?from=2026-02-29', { waitUntil: 'networkidle' }); await page.getByRole('alert').filter({ hasText: '有效日期' }).waitFor();
  assert.equal(await page.getByRole('link', { name: '导出当前筛选 CSV', exact: true }).count(), 0); assert.equal(await page.locator('tbody tr').count(), 0);
  const invalid = await admin.request.get(target + '/api/admin/data/usage?format=csv&from=2026-02-29', { headers }); assert.equal(invalid.status(), 400);
  await page.getByRole('link', { name: '清除筛选', exact: true }).click(); await page.waitForURL(url => !url.search); await page.waitForLoadState('networkidle'); assert.equal(await page.locator('.notice.error[role="alert"]').count(), 0);
  pass('Mobile has no horizontal overflow invalid date shows form error and blocks export clear filters restores list');
  assert.equal(errors.length, 0);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, target, schema: fixture.schema, at: new Date().toISOString(), checks, errors, resumedMobile: resumeMobile, csvSha256: csv ? createHash('sha256').update(csv).digest('hex') : undefined, realEmails: false, realPayments: false, upstreamCalls: false }, null, 2));
  console.log(JSON.stringify({ passed: true, report: path.relative(path.resolve('..'), path.join(output, 'report.json')), checks: checks.length }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, stage, code: error.name, locator: error.message.match(/(?:locator|getByLabel|getByRole)\([^)]{0,120}\)/)?.[0] }));
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, target, schema: fixture.schema, at: new Date().toISOString(), stage, checks, errors }, null, 2));
  process.exitCode = 1;
} finally { for (const current of contexts) await current.close(); await browser?.close(); }
