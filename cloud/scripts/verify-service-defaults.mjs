import './load-env.ts';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const target = process.env.CCAGENT_PREVIEW_URL, token = process.env.VERCEL_OIDC_TOKEN;
assert(/^https:\/\/ccagent-cloud-[a-z0-9]+-lvye-1989s-projects\.vercel\.app$/.test(target || '')); assert(token);
const fixture = JSON.parse(await readFile(process.env.CCAGENT_FIXTURE_FILE, 'utf8'));
assert(/^ccagent_test_[a-f0-9]{16}$/.test(fixture.schema)); assert.equal(fixture.users.length, 2);
assert.deepEqual(fixture.users.map(user => user.email).sort(), ['ui-admin@ccagent.example.invalid', 'ui-user@ccagent.example.invalid']);
const { chromium } = createRequire(process.env.CCAGENT_PLAYWRIGHT_PACKAGE)('playwright');
const run = fixture.schema + '-' + randomUUID().slice(0, 8), output = path.resolve('../output/checks/service-defaults-' + run), screenshots = path.resolve('../output/playwright/service-defaults-' + run);
await mkdir(output, { recursive: true }); await mkdir(screenshots, { recursive: true });
const checks = [], errors = [], contexts = [], headers = { 'x-vercel-trusted-oidc-idp-token': token, origin: target };
let browser, stage = 'protection';
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
const empty = { chat: null, vision: null, decision: null, search: null, voice: null };
const selection = { chat: 'default-chat-a', vision: 'default-vision', decision: 'default-decision', search: 'default-search', voice: 'default-voice' };
try {
  const external = await fetch(target + '/login', { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  assert([401, 403].includes(external.status) || (external.status === 302 && new URL(external.headers.get('location'), target).hostname === 'vercel.com')); await external.body?.cancel(); pass('Preview protection remains enabled');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  stage = 'permissions';
  const ordinary = await context(), ordinaryPage = await login(ordinary, fixture.users[0]);
  assert.equal((await ordinary.request.get(target + '/api/admin/routes/defaults', { headers })).status(), 403);
  assert.equal((await ordinary.request.put(target + '/api/admin/routes/defaults', { headers, data: { version: 0, routes: empty } })).status(), 403);
  assert.equal((await ordinaryPage.goto(target + '/admin/routes', { waitUntil: 'networkidle' })).status(), 404);
  pass('Ordinary users cannot read or modify route defaults through API or page');
  const keyResponse = await ordinary.request.post(target + '/api/account/keys', { headers, data: { name: 'Synthetic default discovery' } }); assert.equal(keyResponse.status(), 201);
  const key = await keyResponse.json(); assert.equal(typeof key.secret, 'string');
  const catalog = async () => { const response = await ordinary.request.get(target + '/v1/models', { headers: { ...headers, authorization: 'Bearer ' + key.secret } }); assert.equal(response.status(), 200); return response.json(); };
  const admin = await context(), page = await login(admin, fixture.users[1]);
  const otherAdmin = await context(), stale = await login(otherAdmin, fixture.users[1]);
  for (const current of [page, stale]) await current.goto(target + '/admin/routes', { waitUntil: 'networkidle' });
  const panel = current => current.locator('section.panel').filter({ has: current.getByRole('heading', { name: '平台默认服务', exact: true }) });
  stage = 'choices';
  const initial = await (await admin.request.get(target + '/api/admin/routes/defaults', { headers })).json();
  assert.equal(initial.version, 0); assert.deepEqual(initial.routes, empty); assert.equal(initial.choices.filter(route => route.ready).length, 6);
  assert.equal(await panel(page).getByRole('combobox').count(), 5);
  assert.equal(await panel(page).getByRole('combobox', { name: '主模型默认路由', exact: true }).locator('option[value="default-disabled"]').isDisabled(), true);
  assert(!JSON.stringify(initial).includes('CCAGENT_PROVIDER_DEFAULT_FIXTURE')); assert.deepEqual((await catalog()).defaults, empty);
  pass('Five service-specific selectors show readiness and disabled choices without exposing credentials');
  stage = 'save';
  for (const [label, id] of [['主模型默认路由', selection.chat], ['视觉读图默认路由', selection.vision], ['Jev 决策默认路由', selection.decision], ['联网搜索默认路由', selection.search], ['语音合成默认路由', selection.voice]]) await panel(page).getByRole('combobox', { name: label, exact: true }).selectOption(id);
  await panel(page).getByRole('button', { name: '保存默认服务', exact: true }).click(); await panel(page).getByRole('status').filter({ hasText: '默认服务已保存' }).waitFor();
  const saved = await (await admin.request.get(target + '/api/admin/routes/defaults', { headers })).json(); assert.equal(saved.version, 1); assert.deepEqual(saved.routes, selection); assert.deepEqual((await catalog()).defaults, selection);
  await page.reload({ waitUntil: 'networkidle' }); assert.equal(await panel(page).getByRole('combobox', { name: '主模型默认路由', exact: true }).inputValue(), selection.chat);
  await page.screenshot({ path: path.join(screenshots, 'defaults-desktop.png'), fullPage: true }); pass('All five defaults persist through real UI save reload and authenticated model discovery');
  stage = 'conflict';
  await panel(stale).getByRole('combobox', { name: '主模型默认路由', exact: true }).selectOption('default-chat-b'); await panel(stale).getByRole('button', { name: '保存默认服务', exact: true }).click();
  await panel(stale).getByRole('alert').filter({ hasText: '其他管理员' }).waitFor(); assert.equal((await catalog()).defaults.chat, selection.chat);
  await panel(stale).getByRole('button', { name: '重新载入', exact: true }).click(); await panel(stale).getByRole('status').filter({ hasText: '重新载入' }).waitFor();
  assert.equal(await panel(stale).getByRole('combobox', { name: '主模型默认路由', exact: true }).inputValue(), selection.chat);
  await panel(stale).getByRole('combobox', { name: '主模型默认路由', exact: true }).selectOption('default-chat-b'); await panel(stale).getByRole('button', { name: '保存默认服务', exact: true }).click();
  await panel(stale).getByRole('status').filter({ hasText: '默认服务已保存' }).waitFor(); assert.equal((await catalog()).defaults.chat, 'default-chat-b');
  pass('Stale administrator save is rejected and explicit reload permits the next version');
  stage = 'validation';
  for (const routes of [{ ...selection, vision: 'default-chat-a' }, { ...selection, chat: 'default-disabled' }]) {
    assert.equal((await admin.request.put(target + '/api/admin/routes/defaults', { headers, data: { version: 2, routes } })).status(), 409);
  }
  assert.equal((await admin.request.put(target + '/api/admin/routes/defaults', { headers, data: { version: 2, routes: { ...selection, apiKey: 'synthetic' } } })).status(), 400);
  pass('Forged mismatched unready and unknown fields cannot bypass default validation');
  stage = 'withdrawn';
  const loaded = await (await admin.request.get(target + '/api/admin/routes?id=default-chat-b', { headers })).json();
  const { createdAt, updatedAt, ...route } = loaded.route;
  assert.equal((await admin.request.put(target + '/api/admin/routes', { headers, data: { ...route, enabled: false } })).status(), 200);
  const unavailable = await catalog(); assert.equal(unavailable.defaults.chat, null); assert(unavailable.data.some(route => route.id === 'default-chat-a'));
  await page.reload({ waitUntil: 'networkidle' }); await panel(page).locator('small.error').filter({ hasText: '当前不可用' }).waitFor();
  assert.equal(await panel(page).getByRole('combobox', { name: '主模型默认路由', exact: true }).getAttribute('aria-describedby'), 'default-chat-warning');
  assert.equal(await panel(page).getByRole('combobox', { name: '主模型默认路由', exact: true }).inputValue(), 'default-chat-b');
  await panel(page).getByRole('combobox', { name: '主模型默认路由', exact: true }).selectOption(''); await panel(page).getByRole('button', { name: '保存默认服务', exact: true }).click(); await panel(page).getByRole('status').filter({ hasText: '默认服务已保存' }).waitFor();
  const cleared = await (await admin.request.get(target + '/api/admin/routes/defaults', { headers })).json(); assert.equal(cleared.version, 3); assert.equal(cleared.routes.chat, null); assert.equal(cleared.routes.voice, selection.voice);
  pass('Withdrawn recommendation remains visible until explicitly cleared and never selects an alternative');
  stage = 'audit-mobile';
  const audit = await (await admin.request.get(target + '/api/admin/data/audit?q=routes.defaults.update', { headers })).json(); assert.equal(audit.total, 3);
  assert(audit.rows.every(row => row.actor_id === fixture.users[1].id));
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(screenshots, 'defaults-mobile.png'), fullPage: true }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  pass('Default changes are audited and the narrow layout remains usable');
  assert.equal(errors.length, 0);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, target, schema: fixture.schema, at: new Date().toISOString(), checks, errors, realEmails: false, realPayments: false, upstreamCalls: false }, null, 2));
  console.log(JSON.stringify({ passed: true, report: path.relative(path.resolve('..'), path.join(output, 'report.json')), checks: checks.length }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, stage, code: error.name, locator: error.message.match(/(?:locator|getByLabel|getByRole)\([^)]{0,120}\)/)?.[0] }));
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, target, schema: fixture.schema, at: new Date().toISOString(), stage, checks, errors }, null, 2)); process.exitCode = 1;
} finally { for (const current of contexts) await current.close(); await browser?.close(); }
