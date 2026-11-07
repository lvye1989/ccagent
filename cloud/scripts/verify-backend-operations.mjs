import './load-env.ts';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { databaseUrl } from '../src/core/env.ts';
import { databaseOptions } from '../src/core/db/options.ts';

const target = process.env.CCAGENT_PREVIEW_URL, token = process.env.VERCEL_OIDC_TOKEN;
assert(/^https:\/\/ccagent-cloud-[a-z0-9]+-lvye-1989s-projects\.vercel\.app$/.test(target || '')); assert(token);
const fixture = JSON.parse(await readFile(process.env.CCAGENT_FIXTURE_FILE, 'utf8'));
assert(/^ccagent_test_[a-f0-9]{16}$/.test(fixture.schema)); assert.equal(fixture.users.length, 2);
assert.deepEqual(fixture.users.map(user => user.email).sort(), ['ui-admin@ccagent.example.invalid', 'ui-user@ccagent.example.invalid']);
const { chromium } = createRequire(process.env.CCAGENT_PLAYWRIGHT_PACKAGE)('playwright');
const run = fixture.schema + '-' + randomUUID().slice(0, 8), output = path.resolve('../output/checks/backend-operations-' + run), screenshots = path.resolve('../output/playwright/backend-operations-' + run);
await mkdir(output, { recursive: true }); await mkdir(screenshots, { recursive: true });
const checks = [], errors = [], contexts = [], headers = { 'x-vercel-trusted-oidc-idp-token': token, origin: target };
let browser, stage = 'protection';
const owner = postgres(databaseUrl(true), databaseOptions(1));
const pass = name => { checks.push({ name, passed: true }); console.log(JSON.stringify({ passed: name })); };
async function context() {
  const current = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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
  const external = await fetch(target + '/login', { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  assert([401, 403].includes(external.status) || (external.status === 302 && new URL(external.headers.get('location'), target).hostname === 'vercel.com')); await external.body?.cancel(); pass('Preview protection remains enabled');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  stage = 'permissions';
  const ordinary = await context(), ordinaryPage = await login(ordinary, fixture.users[0]);
  for (const name of ['overview', 'settings']) assert.equal((await ordinary.request.get(target + '/api/admin/' + name, { headers })).status(), 403);
  for (const name of ['data', 'settings']) assert.equal((await ordinaryPage.goto(target + '/admin/' + name, { waitUntil: 'networkidle' })).status(), 404);
  pass('Ordinary user denied new overview settings API and pages');
  const admin = await context(), page = await login(admin, fixture.users[1]);
  stage = 'business-data';
  const stateResponse = await admin.request.get(target + '/api/admin/overview', { headers }); assert.equal(stateResponse.status(), 200); const state = await stateResponse.json();
  assert.equal(state.schema, fixture.schema); assert.equal(state.structure.ready, true); assert.equal(state.structure.migrations.applied, 4); assert.equal(state.structure.tables.actual, 22);
  assert.equal(state.counts.users, '2'); assert.equal(state.counts.calls, '9'); assert.equal(state.counts.pending_orders, '1'); assert.equal(state.counts.pending_refunds, '1'); assert.equal(state.counts.overdue_calls, '1'); assert.equal(state.lastMaintenance.result, 'partial');
  await page.goto(target + '/admin/data', { waitUntil: 'networkidle' });
  assert.equal(await page.locator('.backend-count[href="/admin/users"] strong').textContent(), '2'); assert.equal(await page.locator('.backend-count[href="/admin/usage"] strong').textContent(), '9');
  const pendingCall = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: /到期待处理调用/ }) });
  assert.equal(await pendingCall.locator('tbody tr').count(), 1); assert((await pendingCall.textContent()).includes(state.pending.usage[0].id));
  assert((await page.getByRole('heading', { name: '维护与资金状态' }).locator('..').textContent()).includes('部分任务失败'));
  const pendingOrder = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: /待完成充值订单/ }) });
  assert((await pendingOrder.textContent()).includes('2026/11/7 12:00:00'));
  await page.screenshot({ path: path.join(screenshots, 'data-desktop.png'), fullPage: true });
  await pendingCall.getByRole('link', { name: '查看全部 →', exact: true }).click(); await page.waitForURL(url => url.searchParams.get('overdue') === 'true'); await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('form.admin-filters [name="overdue"]').inputValue(), 'true'); assert.equal(await page.locator('tbody tr').count(), 1);
  pass('Real quantities migration digests pending records maintenance status and overdue navigation rendered');
  stage = 'grouped-settings';
  await page.goto(target + '/admin/settings', { waitUntil: 'networkidle' });
  for (const title of ['通用', '认证', '支付', '邮箱', '存储', 'AI 服务', '后端数据', '余额与计费']) assert.equal(await page.getByRole('heading', { name: title, exact: true }).count(), 1);
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  const fields = await page.locator('form [name]').evaluateAll(elements => elements.map(element => element.getAttribute('name')).sort());
  assert.deepEqual(fields, ['payment_enabled', 'recharge_max_fen', 'recharge_min_fen', 'settlement_usd_cny', 'support_email']); assert(await page.locator('[name="payment_enabled"]').isDisabled());
  const settingsResponse = await admin.request.get(target + '/api/admin/settings', { headers }); assert.equal(settingsResponse.status(), 200); const configuration = await settingsResponse.json();
  assert.equal(configuration.credentials.authentication.emailPasswordRequired, true); assert.equal(configuration.credentials.payment.notifyUrl, target + '/api/payments/zpay/notify'); assert.equal(configuration.credentials.payment.returnUrl, target + '/payment/return');
  assert.equal(configuration.credentials.email, false); assert.equal(configuration.credentials.payment.keyConfigured, false); assert(!JSON.stringify(configuration).includes(fixture.password));
  await page.locator('[name="support_email"]').fill('operations-check@ccagent.example.invalid'); await page.locator('[name="settlement_usd_cny"]').fill('7.250000');
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await page.locator('.notice[role="status"]').filter({ hasText: '设置已保存' }).waitFor();
  await page.reload({ waitUntil: 'networkidle' }); assert.equal(await page.locator('[name="support_email"]').inputValue(), 'operations-check@ccagent.example.invalid'); assert.equal(await page.locator('[name="settlement_usd_cny"]').inputValue(), '7.250000');
  await page.locator('#settings-payment').screenshot({ path: path.join(screenshots, 'payment-readonly.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(screenshots, 'settings-mobile.png'), fullPage: true }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  pass('Eight settings groups five field whitelist mandatory auth safe callbacks exact FX persistence and narrow layout');
  stage = 'cost-metrics';
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(target + '/admin/prices', { waitUntil: 'networkidle' });
  const metric = page.locator('select').filter({ has: page.locator('option[value="audio_output_tokens"]') }).first();
  assert.equal(await metric.locator('option').count(), 10);
  for (const value of ['image_input_tokens', 'audio_input_tokens', 'video_input_tokens', 'audio_output_tokens']) { await metric.selectOption(value); assert.equal(await metric.inputValue(), value); }
  pass('All ten existing canonical cost metrics available including image audio video and audio output');
  // Negative DDL is confined to this verified disposable fixture. Never mutate the development schema.
  stage = 'migration-conflict';
  const proof = await owner.unsafe(`select id,email from "${fixture.schema}"."user" order by id`); assert.equal(proof.length, 2); assert.deepEqual(proof.map(user => user.id).sort(), fixture.users.map(user => user.id).sort());
  const [journal] = await owner.unsafe(`select id,hash from "${fixture.schema}".__drizzle_migrations order by created_at desc limit 1`);
  await owner.unsafe(`update "${fixture.schema}".__drizzle_migrations set hash=$1 where id=$2`, ['f'.repeat(64), journal.id]);
  try { await page.goto(target + '/admin/data', { waitUntil: 'networkidle' }); await page.locator('.notice.error[role="alert"]').filter({ hasText: '需核对' }).waitFor();
    const conflict = await (await admin.request.get(target + '/api/admin/overview', { headers })).json(); assert.equal(conflict.structure.migrations.state, 'conflict'); assert.equal(conflict.structure.ready, false);
  } finally { await owner.unsafe(`update "${fixture.schema}".__drizzle_migrations set hash=$1 where id=$2`, [journal.hash, journal.id]); }
  pass('Changed journal digest becomes visible conflict without automatic repair or migration');
  stage = 'missing-table';
  await owner.unsafe(`drop table "${fixture.schema}".prices`);
  await page.reload({ waitUntil: 'networkidle' }); await page.locator('.notice.error[role="alert"]').filter({ hasText: 'prices' }).waitFor();
  const missing = await (await admin.request.get(target + '/api/admin/overview', { headers })).json(); assert.equal(missing.counts, null); assert.deepEqual(missing.pending, {}); assert.equal(missing.structure.ready, false);
  assert((await page.locator('.backend-count[href="/admin/users"] strong').textContent()).includes('暂不可读取'));
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(screenshots, 'missing-table-mobile.png'), fullPage: true }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  pass('Missing required table suppresses counts and queues with safe diagnosis on desktop and mobile');
  assert.equal(errors.length, 0);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, target, schema: fixture.schema, at: new Date().toISOString(), checks, errors, realEmails: false, realPayments: false, upstreamCalls: false, negativeDdlFixtureOnly: true }, null, 2));
  console.log(JSON.stringify({ passed: true, report: path.relative(path.resolve('..'), path.join(output, 'report.json')), checks: checks.length }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, stage, code: error.name, locator: error.message.match(/(?:locator|getByLabel|getByRole)\([^)]{0,120}\)/)?.[0] }));
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, target, schema: fixture.schema, at: new Date().toISOString(), stage, checks, errors }, null, 2)); process.exitCode = 1;
} finally { for (const current of contexts) await current.close(); await browser?.close(); await owner.end({ timeout: 5 }); }
