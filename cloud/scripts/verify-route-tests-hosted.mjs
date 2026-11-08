import './load-env.ts';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const target = process.env.CCAGENT_PREVIEW_URL, token = process.env.VERCEL_OIDC_TOKEN;
assert(/^https:\/\/ccagent-cloud-[a-z0-9]+-lvye-1989s-projects\.vercel\.app$/.test(target || '')); assert(token);
const fixture = JSON.parse(await readFile(process.env.CCAGENT_FIXTURE_FILE, 'utf8')); assert(/^ccagent_test_[a-f0-9]{16}$/.test(fixture.schema));
assert.deepEqual(fixture.users.map(user => user.email).sort(), ['ui-admin@ccagent.example.invalid', 'ui-user@ccagent.example.invalid']);
const { chromium } = createRequire(process.env.CCAGENT_PLAYWRIGHT_PACKAGE)('playwright'), run = fixture.schema + '-' + randomUUID().slice(0, 8);
const output = path.resolve('../output/checks/route-tests-hosted-' + run), screenshots = path.resolve('../output/playwright/route-tests-hosted-' + run);
await mkdir(output, { recursive: true }); await mkdir(screenshots, { recursive: true });
const checks = [], errors = [], contexts = [], headers = { 'x-vercel-trusted-oidc-idp-token': token, origin: target }; let browser, stage = 'protection';
const pass = name => { checks.push({ name, passed: true }); console.log(JSON.stringify({ passed: name })); };
async function login(user) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); contexts.push(context);
  await context.route('**/*', route => new URL(route.request().url()).origin === target ? route.continue({ headers: { ...route.request().headers(), 'x-vercel-trusted-oidc-idp-token': token } }) : route.continue());
  const page = await context.newPage(); page.on('pageerror', () => errors.push({ stage, type: 'pageerror' }));
  page.on('response', response => { if (new URL(response.url()).origin === target && response.status() >= 500) errors.push({ stage, status: response.status(), path: new URL(response.url()).pathname }); });
  await page.goto(target + '/login', { waitUntil: 'networkidle' }); await page.getByLabel('邮箱地址').fill(user.email); await page.getByLabel('密码', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: '登录账户 →', exact: true }).click(); await page.waitForURL(target + '/account'); return { page, context };
}
try {
  const response = await fetch(target + '/login', { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  assert([401, 403].includes(response.status) || response.status === 302 && new URL(response.headers.get('location'), target).hostname === 'vercel.com'); await response.body?.cancel();
  pass('Exact Preview retains Vercel authentication protection'); browser = await chromium.launch({ channel: 'chrome', headless: true });
  stage = 'permissions'; const ordinary = await login(fixture.users[0]);
  assert.equal((await ordinary.context.request.get(target + '/api/admin/routes/test?routeId=default-chat-a', { headers })).status(), 403);
  assert.equal((await ordinary.context.request.post(target + '/api/admin/routes/test', { headers, data: {} })).status(), 403);
  assert.equal((await ordinary.page.goto(target + '/admin/routes', { waitUntil: 'networkidle' })).status(), 404);
  pass('Ordinary users cannot quote launch or view administrator connection tests');
  const { page, context } = await login(fixture.users[1]);
  const getQuote = async routeId => { const response = await context.request.get(target + '/api/admin/routes/test?' + new URLSearchParams({ routeId }), { headers }); assert.equal(response.status(), 200); return (await response.json()).quote; };
  const post = data => context.request.post(target + '/api/admin/routes/test', { headers, data });
  stage = 'service-quotes';
  for (const id of ['default-chat-a', 'default-vision', 'default-decision', 'default-search', 'default-voice']) {
    const quote = await getQuote(id); assert.equal(quote.routeId, id); assert.equal(quote.timeoutMs, 30000); assert.equal(quote.singleAttempt, true); assert.equal(quote.fallback, false); assert.equal(quote.platformPaid, true); assert.equal(quote.userChargeMicro, '0'); assert(BigInt(quote.estimatedPublicCostMicro) >= 0n);
    assert.match(quote.confirmationFingerprint, /^[a-f0-9]{64}$/); assert.equal(JSON.stringify(quote).includes('CCAGENT_PROVIDER_DEFAULT_FIXTURE'), false); assert.equal(JSON.stringify(quote).includes('synthetic-defaults-only-no-supplier-requests'), false);
  }
  pass('Five saved service adapters expose bounded cost estimates and confirmation fingerprints without credentials');
  await page.goto(target + '/admin/routes', { waitUntil: 'networkidle' });
  const gateway = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '编辑服务网关', exact: true }) }), panel = page.getByRole('region', { name: '真实连接检测', exact: true });
  const load = async id => { await gateway.getByLabel('已有路由编号', { exact: true }).fill(id); await gateway.getByRole('button', { name: '载入配置', exact: true }).click(); await gateway.getByRole('status').filter({ hasText: '路由已开放' }).waitFor(); };
  const prepare = async () => { await panel.getByRole('button', { name: '准备连接检测', exact: true }).click(); await panel.getByRole('checkbox').waitFor(); await page.waitForFunction(() => { const field = document.querySelector('[aria-labelledby="route-test-heading"] input[type="checkbox"]'); return field && !field.disabled; }); assert.equal(await panel.getByRole('checkbox').isChecked(), false); assert.equal(await panel.getByRole('button', { name: '发起真实检测', exact: true }).isDisabled(), true); };
  stage = 'real-ui'; await load('default-chat-a'); await prepare(); assert((await panel.textContent()).includes('预计公开成本上界')); await panel.getByRole('checkbox').check(); assert.equal(await panel.getByRole('button', { name: '发起真实检测', exact: true }).isEnabled(), true); await panel.getByRole('checkbox').uncheck();
  await panel.screenshot({ path: path.join(screenshots, 'quote-desktop.png') });
  pass('Real deployed administrator UI separates free preparation from explicitly confirmed supplier dispatch');
  stage = 'adapter-copy';
  for (const [id, expected] of [['default-vision', '64×64'], ['default-decision', '类型化选择'], ['default-search', '最多一条'], ['default-voice', 'WAV']]) { await load(id); await prepare(); assert((await panel.textContent()).includes(expected)); }
  pass('Real route switching displays the correct fixed image decision search and voice test descriptions');
  stage = 'stale-and-unconfirmed'; await load('default-chat-a'); await prepare(); const old = await getQuote('default-chat-a');
  await gateway.getByLabel('输出上限（Token）', { exact: true }).fill('8191'); await gateway.getByRole('button', { name: '保存路由', exact: true }).click(); await gateway.getByRole('status').filter({ hasText: '路由已保存' }).waitFor();
  const base = { routeId: old.routeId, testId: randomUUID(), confirmationFingerprint: old.confirmationFingerprint, confirmPlatformCost: true };
  assert.equal((await post(base)).status(), 409);
  const fresh = await getQuote(old.routeId); assert.notEqual(fresh.confirmationFingerprint, old.confirmationFingerprint);
  assert.equal((await post({ ...base, testId: randomUUID(), confirmationFingerprint: fresh.confirmationFingerprint, confirmPlatformCost: false })).status(), 400);
  assert.equal((await post({ ...base, testId: randomUUID(), confirmationFingerprint: fresh.confirmationFingerprint, prompt: 'forbidden' })).status(), 400);
  pass('Changed limits stale confirmation missing cost consent and client-defined prompts are rejected before dispatch');
  stage = 'audit-mobile';
  const auditResponse = await context.request.get(target + '/api/admin/data/audit?q=routes.test.start', { headers }); assert.equal(auditResponse.status(), 200); assert.equal((await auditResponse.json()).total, 0);
  await prepare(); await page.setViewportSize({ width: 390, height: 844 }); await panel.scrollIntoViewIfNeeded(); await panel.screenshot({ path: path.join(screenshots, 'quote-mobile.png') }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(errors.length, 0); pass('Preview preparation creates no paid-start audit events and keeps the narrow UI usable');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, target, schema: fixture.schema, at: new Date().toISOString(), checks, errors, actualChrome: true, realDatabase: true,
    syntheticAccountsRoutesAndPrices: true, paidStartEvents: 0, upstreamCalls: false, realEmails: false, realPayments: false }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, report: path.relative(path.resolve('..'), path.join(output, 'report.json')) }));
} catch (error) {
  const sourceLine = String(error.stack).match(/verify-route-tests-hosted\.mjs:(\d+):\d+/)?.[1];
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, target, schema: fixture.schema, at: new Date().toISOString(), stage, code: error.name, sourceLine, checks, errors }, null, 2));
  console.error(JSON.stringify({ passed: false, stage, code: error.name, sourceLine, report: path.relative(path.resolve('..'), path.join(output, 'report.json')) })); process.exitCode = 1;
} finally { for (const context of contexts) await context.close(); await browser?.close(); }
