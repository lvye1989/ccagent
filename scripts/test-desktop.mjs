import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { startAccountFixture } from '../src/scripts/helpers/accountFixture.ts';
import { accountHome } from '../src/platform/account.ts';
const require = createRequire(import.meta.url);
const { freePort, startBackend, stopBackend, waitForBackend, serviceRequest, backendEnvironment, onboardingFinished, completeOnboarding } = require('../desktop/runtime.cjs');
const root = path.resolve(import.meta.dirname, '..');
const backendRoot = path.resolve(process.env.CCAGENT_TEST_BACKEND || path.join(root, 'output/desktop/backend'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ccagent-desktop-test-'));
const platformBase = path.join(temp, 'home'), workspace = path.join(temp, '中文 工作区'), second = path.join(temp, '另一个 项目');
const accountFixture = await startAccountFixture(platformBase);
const identityA = { origin: accountFixture.origin, user: accountFixture.users[0] }, identityB = { origin: accountFixture.origin, user: accountFixture.users[1] };
const legacyState = { onboardingComplete: true, workspace: 'retained workspace' };
assert(!onboardingFinished(legacyState, identityA), 'Machine-level legacy flags never skip a new account guide');
const accountState = completeOnboarding(legacyState, identityA);
assert(onboardingFinished(accountState, identityA)); assert(!onboardingFinished(accountState, identityB));
assert(!onboardingFinished(accountState, { ...identityA, origin: 'https://another.example.invalid' }));
assert(onboardingFinished(completeOnboarding(accountState, identityB), identityA));
assert.equal(accountState.workspace, legacyState.workspace);
assert.throws(() => completeOnboarding(accountState, null), /登录/);
const home = accountHome(platformBase, accountFixture.users[0].id);
for (const dir of [home, workspace, second]) await fs.mkdir(dir, { recursive: true });
const envFile = path.join(home, 'empty.env'); await fs.writeFile(envFile, '');
// User/project model configuration must never replace desktop authorization.
await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ env: { CCAGENT_DESKTOP_TOKEN: 'configuration-must-not-override-desktop-token' } }));
const env = { ...process.env, CCAGENT_HOME: platformBase, CCAGENT_PLATFORM_HOME: platformBase, CCAGENT_ENV_FILE: envFile };
delete env.CCAGENT_ACCOUNT_ID; delete env.CCAGENT_AUTH_SESSION_FILE;
const manifest = JSON.parse(await fs.readFile(path.join(backendRoot, 'desktop-manifest.json'), 'utf8'));
assert.equal(manifest.environmentGuideVersion, 1);
assert.equal(manifest.platform, 'win32'); assert.equal(manifest.architecture, 'x64');
assert.equal(manifest.minimumWindowsMajor, 10);
assert(manifest.desktop.some(file => file.path === 'desktop/prerequisites.cjs'));
for (const file of manifest.desktop) {
  assert.match(file.path, /^desktop\/[a-z.-]+\.(?:cjs|js|html|css)$/);
  const preparedFile = path.join(path.dirname(backendRoot), 'app', file.path);
  assert.equal(createHash('sha256').update(await fs.readFile(preparedFile)).digest('hex'), file.sha256, 'Prepared desktop code matches the release manifest');
}
for (const file of manifest.payload) {
  assert(!/(^|\/)\.(?:ccagent|git)(\/|$)|(^|\/)\.env$|sessions/i.test(file.path));
  assert.equal(createHash('sha256').update(await fs.readFile(path.join(backendRoot, file.path))).digest('hex'), file.sha256);
}
const runtime = path.join(backendRoot, 'runtime');
assert.equal(execFileSync(path.join(runtime, 'node.exe'), ['--version'], { windowsHide: true, encoding: 'utf8' }).trim(), 'v' + manifest.nodeVersion);
assert.match(execFileSync(path.join(runtime, 'node.exe'), [path.join(runtime, 'node_modules/npm/bin/npm-cli.js'), '--version'], { windowsHide: true, encoding: 'utf8' }), /^\d+\./);
const cleaned = backendEnvironment({ Path: 'original-path', NODE_OPTIONS: '--inspect', NODE_TLS_REJECT_UNAUTHORIZED: '0', ELECTRON_RUN_AS_NODE: '1' }, runtime, 'fixture');
assert.equal(cleaned.NODE_OPTIONS, undefined); assert.equal(cleaned.NODE_TLS_REJECT_UNAUTHORIZED, '1'); assert(cleaned.PATH.startsWith(runtime));

let sawRequest = false;
const mock = createServer(async (req, res) => {
  let text = ''; for await (const part of req) text += part;
  const body = JSON.parse(text); assert.equal(body.model, 'desktop-fixture');
  assert.equal(req.headers.authorization, 'Bearer desktop-fixture-key'); sawRequest = true;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'DESKTOP_CONNECTION_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } }) + '\n\ndata: [DONE]\n\n');
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
let child, origin, token;
async function launch(selected) {
  const port = await freePort(); origin = `http://127.0.0.1:${port}`; token = randomBytes(32).toString('hex');
  child = startBackend({ backendRoot, workspace: selected, port, token, env });
  await waitForBackend(child, origin, token);
}
const api = (route, body) => serviceRequest(origin, token, route, body, 15000);
try {
  await launch(workspace);
  assert.equal((await fetch(origin + '/api/health')).status, 403);
  assert.equal((await fetch(origin + '/api/health', { headers: { 'x-ccagent-desktop-token': 'wrong' } })).status, 403);
  assert.equal((await fetch(origin + '/api/health', { headers: { 'x-ccagent-desktop-token': token, origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await api('/api/health')).ok, true);
  await assert.rejects(() => api('/api/bootstrap'), /邮箱和密码登录/);
  await api('/api/account/login', { email: accountFixture.users[0].email, password: accountFixture.password });
  assert.equal(await fs.realpath((await api('/api/workspaces')).current), await fs.realpath(path.join(home, 'workspace')), 'Fresh account uses its own folder instead of machine-level previous workspace');
  await api('/api/workspaces/select', { path: workspace });
  for (const route of ['/', '/app.js', '/charts.js', '/favicon.svg']) {
    const response = await fetch(origin + route, { headers: { 'x-ccagent-desktop-token': token } });
    assert.equal(response.status, 200, route); assert((await response.text()).length > 20);
  }
  await api('/api/customize/models', { id: 'desktop-fixture', protocol: 'openai-chat', baseURL: `http://127.0.0.1:${mock.address().port}/v1`, model: 'desktop-fixture', apiKey: 'desktop-fixture-key', makeDefault: true });
  const models = await api('/api/customize/models');
  assert(models.models.some(model => model.id === 'desktop-fixture' && model.hasKey));
  assert(!JSON.stringify(models).includes('desktop-fixture-key'));
  assert.match((await api('/api/customize/model-test', { id: 'desktop-fixture' })).reply, /DESKTOP_CONNECTION_OK/);
  assert(sawRequest);
  await fs.writeFile(path.join(workspace, '资料.txt'), 'DESKTOP_FILE_EVIDENCE');
  assert(JSON.stringify(await api('/api/files')).includes('资料.txt'));
  const switched = await api('/api/workspaces/select', { path: second });
  assert.equal(await fs.realpath(switched.workspace), await fs.realpath(second));
  const mcpFixture = path.join(second, 'mcp-fixture.cjs');
  await fs.writeFile(mcpFixture, `const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
 const q=JSON.parse(line); if(q.id===undefined)return;
 const result=q.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'desktop-node-fixture',version:'1'}}:q.method==='tools/list'?{tools:[{name:'runtime',description:'BUNDLED_NODE_'+process.version+' '+process.execPath,inputSchema:{type:'object'}}]}:{content:[{type:'text',text:process.execPath}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
});`);
  await api('/api/customize/mcp', { name: 'desktop-node-fixture', config: { command: 'node', args: [mcpFixture] } });
  let mcp;
  for (let attempt = 0; attempt < 50; attempt++) {
    mcp = JSON.stringify(await api('/api/mcp'));
    if (mcp.includes('BUNDLED_NODE_')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(mcp.includes('BUNDLED_NODE_v' + manifest.nodeVersion), 'MCP uses bundled Node runtime');
  await stopBackend(child); assert.notEqual(child.exitCode, null);
  await launch(second);
  assert((await api('/api/customize/models')).models.some(model => model.id === 'desktop-fixture' && model.hasKey));
  assert.equal(await fs.readFile(path.join(workspace, '资料.txt'), 'utf8'), 'DESKTOP_FILE_EVIDENCE');
  console.log('PASS desktop: verified payload, bundled Node/npm, private service authorization, UI assets, model save/test, Chinese workspace switch, bundled-node MCP, graceful shutdown and restart persistence.');
} finally {
  await stopBackend(child);
  await accountFixture.close();
  mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
  // Keep the isolated test directory for diagnosis; never touch user settings.
  console.log(`Isolated test evidence: ${temp}`);
}
