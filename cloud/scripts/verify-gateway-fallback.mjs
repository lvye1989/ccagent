import './load-env.ts';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const target = process.env.CCAGENT_PREVIEW_URL, token = process.env.VERCEL_OIDC_TOKEN;
assert(/^https:\/\/ccagent-cloud-[a-z0-9]+-lvye-1989s-projects\.vercel\.app$/.test(target || '')); assert(token);
const fixture = JSON.parse(await readFile(process.env.CCAGENT_FIXTURE_FILE, 'utf8'));
assert(/^ccagent_test_[a-f0-9]{16}$/.test(fixture.schema));
assert.deepEqual(fixture.users.map(user => user.email).sort(), ['ui-admin@ccagent.example.invalid', 'ui-user@ccagent.example.invalid']);
const { chromium } = createRequire(process.env.CCAGENT_PLAYWRIGHT_PACKAGE)('playwright');
const run = fixture.schema + '-' + randomUUID().slice(0, 8), output = path.resolve('../output/checks/gateway-fallback-' + run), screenshots = path.resolve('../output/playwright/gateway-fallback-' + run);
await mkdir(output, { recursive: true }); await mkdir(screenshots, { recursive: true });
const checks = [], errors = [], contexts = [], headers = { 'x-vercel-trusted-oidc-idp-token': token, origin: target };
let browser, stage = 'protection';
const pass = name => { checks.push({ name, passed: true }); console.log(JSON.stringify({ passed: name })); };
async function context() {
  const current = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await current.route('**/*', route => new URL(route.request().url()).origin === target ? route.continue({ headers: { ...route.request().headers(), 'x-vercel-trusted-oidc-idp-token': token } }) : route.continue());
  current.on('page', page => {
    page.on('pageerror', () => errors.push({ stage, type: 'pageerror' }));
    page.on('response', response => { if (new URL(response.url()).origin === target && response.status() >= 500) errors.push({ stage, path: new URL(response.url()).pathname, status: response.status() }); });
  }); contexts.push(current); return current;
}
async function login(current, user) {
  const page = await current.newPage(); await page.goto(target + '/login', { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱地址').fill(user.email); await page.getByLabel('密码', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: '登录账户 →', exact: true }).click(); await page.waitForURL(target + '/account'); return page;
}
async function loaded(current, id) {
  const response = await current.request.get(target + '/api/admin/routes?id=' + encodeURIComponent(id), { headers }); assert.equal(response.status(), 200);
  const data = await response.json(), { createdAt, updatedAt, ...route } = data.route; return route;
}
const put = (current, route) => current.request.put(target + '/api/admin/routes', { headers, data: route });
try {
  const external = await fetch(target + '/login', { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  assert([401, 403].includes(external.status) || (external.status === 302 && new URL(external.headers.get('location'), target).hostname === 'vercel.com')); await external.body?.cancel();
  pass('Preview access protection remains enabled');
  browser = await chromium.launch({ channel: 'chrome', headless: true }); stage = 'permissions';
  const ordinary = await context(), ordinaryPage = await login(ordinary, fixture.users[0]);
  assert.equal((await ordinary.request.get(target + '/api/admin/routes?id=default-chat-a', { headers })).status(), 403);
  assert.equal((await ordinary.request.put(target + '/api/admin/routes', { headers, data: {} })).status(), 403);
  assert.equal((await ordinaryPage.goto(target + '/admin/routes', { waitUntil: 'networkidle' })).status(), 404);
  pass('Ordinary users cannot view or modify administrator fallback mappings');
  const createdKey = await ordinary.request.post(target + '/api/account/keys', { headers, data: { name: 'Synthetic fallback catalog verification' } }); assert.equal(createdKey.status(), 201);
  const key = await createdKey.json(); assert.equal(typeof key.secret, 'string');
  const catalog = async () => {
    const response = await ordinary.request.get(target + '/v1/models', { headers: { ...headers, authorization: 'Bearer ' + key.secret } }); assert.equal(response.status(), 200); return response.json();
  };
  const admin = await context(), page = await login(admin, fixture.users[1]); await page.goto(target + '/admin/routes', { waitUntil: 'networkidle' });
  const panel = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '编辑服务网关', exact: true }) });
  const load = async () => {
    await panel.getByLabel('已有路由编号', { exact: true }).fill('default-chat-a'); await panel.getByRole('button', { name: '载入配置', exact: true }).click();
    await panel.getByRole('status').waitFor(); await panel.getByRole('button', { name: '保存路由', exact: true }).waitFor({ state: 'visible' });
  };
  stage = 'initial'; await load();
  assert.equal(await panel.getByRole('combobox', { name: '管理员备用开关', exact: true }).inputValue(), 'false');
  assert.equal(await panel.getByRole('combobox', { name: '管理员备用开关', exact: true }).getAttribute('aria-describedby'), 'gateway-fallback-help');
  assert((await catalog()).data.every(route => /^[a-f0-9]{64}$/.test(route.pricing.fingerprint)));
  pass('Fallback is initially off and authenticated discovery exposes exact price fingerprints');
  stage = 'enable';
  await panel.getByRole('combobox', { name: '管理员备用开关', exact: true }).selectOption('true'); await panel.getByLabel('备用路由编号', { exact: true }).fill('default-chat-b');
  await panel.getByRole('button', { name: '保存路由', exact: true }).click(); await panel.getByRole('status').filter({ hasText: '路由已保存' }).waitFor();
  let primary = await loaded(admin, 'default-chat-a'); assert.equal(primary.options.fallbackEnabled, true); assert.equal(primary.options.fallbackRouteId, 'default-chat-b');
  let published = (await catalog()).data.find(route => route.id === primary.id); assert.equal(published.limits.fallbackEnabled, true); assert.equal(published.limits.fallbackRouteId, 'default-chat-b');
  await page.reload({ waitUntil: 'networkidle' }); await load(); assert.equal(await panel.getByRole('combobox', { name: '管理员备用开关', exact: true }).inputValue(), 'true');
  await page.screenshot({ path: path.join(screenshots, 'fallback-desktop.png'), fullPage: true });
  pass('Real administrator UI persists the compatible backup and publishes its mapping after reload');
  stage = 'invalid-mappings';
  for (const [id, status] of [['default-vision', 409], ['default-disabled', 409], ['default-chat-a', 400], [null, 400]]) {
    assert.equal((await put(admin, { ...primary, options: { ...primary.options, fallbackRouteId: id } })).status(), status);
  }
  const backup = await loaded(admin, 'default-chat-b');
  const differentProtocol = { ...backup, id: 'fallback-protocol-fixture', protocol: 'openai-chat', enabled: false };
  assert.equal((await put(admin, differentProtocol)).status(), 200);
  assert.equal((await put(admin, { ...primary, options: { ...primary.options, fallbackRouteId: differentProtocol.id } })).status(), 409);
  assert.equal((await put(admin, { ...backup, options: { ...backup.options, fallbackEnabled: true, fallbackRouteId: primary.id } })).status(), 409);
  assert.equal((await loaded(admin, primary.id)).options.fallbackRouteId, backup.id);
  pass('Server rejects incompatible services or protocols unready backups self references missing targets and cycles');
  stage = 'readiness-and-pricing';
  assert.equal((await put(admin, { ...backup, enabled: false })).status(), 200);
  assert.equal((await put(admin, primary)).status(), 409); assert(!(await catalog()).data.some(route => route.id === backup.id));
  assert.equal((await put(admin, backup)).status(), 200);
  const previous = (await catalog()).data.find(route => route.id === primary.id).pricing;
  assert.equal((await put(admin, { ...primary, options: { ...primary.options, maxOutputTokens: primary.options.maxOutputTokens - 1 } })).status(), 200);
  const changed = (await catalog()).data.find(route => route.id === primary.id).pricing;
  assert.equal(changed.version, previous.version); assert.notEqual(changed.fingerprint, previous.fingerprint);
  assert.equal((await put(admin, primary)).status(), 200);
  pass('Withdrawn backups block enabled saves and limit changes invalidate approval without changing the cost version');
  stage = 'disable-audit-mobile';
  await page.reload({ waitUntil: 'networkidle' }); await load();
  await panel.getByRole('combobox', { name: '管理员备用开关', exact: true }).selectOption('false'); await panel.getByRole('button', { name: '保存路由', exact: true }).click();
  await panel.getByRole('status').filter({ hasText: '路由已保存' }).waitFor(); assert.equal((await catalog()).data.find(route => route.id === primary.id).limits.fallbackEnabled, false);
  const auditResponse = await admin.request.get(target + '/api/admin/data/audit?q=routes.save&pageSize=100', { headers }); assert.equal(auditResponse.status(), 200);
  const audit = await auditResponse.json(); assert(audit.rows.some(row => row.actor_id === fixture.users[1].id && row.metadata?.fallbackEnabled === true && row.metadata?.fallbackRouteId === backup.id));
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(screenshots, 'fallback-mobile.png'), fullPage: true }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  pass('Explicitly disabling fallback persists with administrator audit and a usable narrow layout');
  assert.equal(errors.length, 0);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, target, schema: fixture.schema, at: new Date().toISOString(), checks, errors,
    actualChrome: true, realDatabase: true, syntheticAccountsRoutesAndPrices: true, realEmails: false, realPayments: false, upstreamCalls: false }, null, 2));
  console.log(JSON.stringify({ passed: true, report: path.relative(path.resolve('..'), path.join(output, 'report.json')), checks: checks.length }));
} catch (error) {
  const sourceLine = String(error.stack).match(/verify-gateway-fallback\.mjs:(\d+):\d+/)?.[1];
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, target, schema: fixture.schema, at: new Date().toISOString(), stage, code: error.name, sourceLine, checks, errors }, null, 2));
  console.error(JSON.stringify({ passed: false, stage, code: error.name, sourceLine, report: path.relative(path.resolve('..'), path.join(output, 'report.json')) })); process.exitCode = 1;
} finally { for (const current of contexts) await current.close(); await browser?.close(); }
