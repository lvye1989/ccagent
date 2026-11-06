const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(temp, file);
}
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}
function serviceRequest(origin, token, route, body, timeout = 10000) {
  if (!/^\/api\/[a-z0-9/?=&._%-]+$/i.test(route)) return Promise.reject(new Error('Invalid service route'));
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = http.request(origin + route, {
      method: bytes ? 'POST' : 'GET',
      headers: { 'x-ccagent-desktop-token': token, 'x-ccagent-web': '1',
        ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) },
    }, (response) => {
      let data = '';
      response.on('data', chunk => {
        data += chunk;
        if (data.length > 4 * 1024 * 1024) response.destroy(new Error('Response too large'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const value = JSON.parse(data);
          if (response.statusCode >= 400) reject(new Error(value.error || `Service error ${response.statusCode}`));
          else resolve(value);
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(timeout, () => request.destroy(new Error('连接超时，请检查服务地址与网络后重试。')));
    request.on('error', reject);
    request.end(bytes);
  });
}
function backendEnvironment(parent, runtime, token) {
  const env = { ...parent, CCAGENT_DESKTOP_TOKEN: token };
  for (const name of Object.keys(env)) {
    if (['PATH', 'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'NODE_TLS_REJECT_UNAUTHORIZED'].includes(name.toUpperCase())) delete env[name];
  }
  env.PATH = runtime + path.delimiter + (parent.PATH || parent.Path || '');
  env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
  env.NODE_USE_SYSTEM_CA = '1';
  return env;
}
function startBackend({ backendRoot, workspace, port, token, env, log }) {
  const runtime = path.join(backendRoot, 'runtime');
  const child = spawn(path.join(runtime, 'node.exe'), [path.join(backendRoot, 'dist', 'ccagent.js'), 'web', '--workspace', workspace, '--port', String(port)], {
    cwd: workspace, env: backendEnvironment(env || process.env, runtime, token),
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', chunk => log?.(chunk.toString()));
  child.stderr.on('data', chunk => log?.(chunk.toString()));
  return child;
}
async function waitForBackend(child, origin, token, milliseconds = 45000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('本地服务已退出，请重启应用或查看诊断日志。');
    try { if ((await serviceRequest(origin, token, '/api/health', undefined, 1000)).ok) return; } catch { /* Retry during startup. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('本地服务启动超时，请重试；也可在帮助菜单打开诊断日志。');
}
async function stopBackend(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  if (child.connected) {
    const ended = new Promise(resolve => child.once('exit', () => resolve(true)));
    child.send('ccagent:shutdown', () => {});
    if (await Promise.race([ended, new Promise(resolve => setTimeout(() => resolve(false), 5000))])) return;
  }
  return new Promise(resolve => {
    // Only terminate the process tree created and owned by this desktop app.
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve());
  });
}
function sameOrigin(url, origin) {
  try { return new URL(url).origin === origin; } catch { return false; }
}
function externalUrl(url) {
  try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; }
}
module.exports = { readState, writeState, freePort, serviceRequest, backendEnvironment, startBackend, waitForBackend, stopBackend, sameOrigin, externalUrl };
