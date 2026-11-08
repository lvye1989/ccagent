const destinations = new Set(['/account', '/account/billing', '/account/keys', '/account/usage', '/admin']);
const bounded = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum && /^[A-Za-z0-9._~-]+$/.test(value);

function officialOrigin(value) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
  return url.origin;
}
function channelId() {
  const bytes = window.crypto.getRandomValues(new Uint8Array(32));
  return window.btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function responseError(status, code) {
  if (['bridge_expired', 'state_expired', 'ticket_expired', 'bridge_state_expired'].includes(code)) return new Error('账户连接已过期，请重新点击打开。');
  if (status === 401) return new Error('本地登录已失效，请重新登录后再打开用户中心。');
  if (status === 403) return new Error('当前账户无法建立连接，请确认登录状态或联系管理员。');
  if (status === 429) return new Error('操作过于频繁，请稍后重新点击打开。');
  return new Error('账户连接暂时不可用，请稍后重新点击打开。');
}

/** Call directly from a user gesture: the popup is created synchronously, before any request. */
export function openAccountCenter({ origin, target = '/account' } = {}) {
  return new Promise((resolve, reject) => {
    let destination, channel;
    try {
      if (!destinations.has(target)) throw new Error();
      origin = officialOrigin(origin); channel = channelId();
      destination = new URL('/account/bridge', origin);
      destination.search = new URLSearchParams({ clientOrigin: window.location.origin, target, channel }).toString();
    } catch { reject(new Error('账户服务地址或页面无效，请刷新账户信息后重试。')); return; }
    let popup, phase = 'waiting', settled = false, timeout, closePoll;
    const controller = new AbortController();
    function finish(error) {
      if (settled) return;
      settled = true; phase = 'done';
      window.removeEventListener('message', receive);
      window.removeEventListener('pagehide', cancel); window.removeEventListener('ccagent:account-changing', cancel);
      window.clearTimeout(timeout); window.clearInterval(closePoll); controller.abort();
      if (error) reject(error); else resolve();
    }
    function cancel() { finish(new Error('当前账户状态已改变，本次连接已取消，请重新点击打开。')); }
    async function receive(event) {
      if (settled || event.origin !== origin || event.source !== popup || !event.data || typeof event.data !== 'object' || Array.isArray(event.data) || event.data.channel !== channel) return;
      if (event.data.type === 'ccagent:account-bridge-complete') { if (phase === 'sent') finish(); return; }
      if (event.data.type !== 'ccagent:account-bridge-ready' || phase !== 'waiting') return;
      const state = event.data.state;
      if (!bounded(state, 8192)) { finish(new Error('账户连接信息无效，请重新点击打开。')); return; }
      phase = 'issuing';
      try {
        const response = await fetch('/api/account/bridge', { method: 'POST', credentials: 'same-origin', headers: { 'x-ccagent-web': '1', 'content-type': 'application/json' }, body: JSON.stringify({ state }), signal: controller.signal });
        let value; try { value = await response.json(); } catch { throw new Error(); }
        if (settled) return;
        if (!response.ok) { finish(responseError(response.status, value?.code)); return; }
        const expiry = typeof value?.expiresAt === 'string' && value.expiresAt.length <= 128 ? Date.parse(value.expiresAt) : NaN;
        if (typeof value?.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.ticket) || typeof value.userId !== 'string' || !value.userId || value.userId.length > 200 || (value.origin !== undefined && value.origin !== origin)) throw new Error();
        const now = Date.now();
        if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 120000) { finish(new Error('账户连接已过期或无效，请重新点击打开。')); return; }
        if (popup.closed) { finish(new Error('账户窗口已关闭，请重新点击打开。')); return; }
        phase = 'sent';
        popup.postMessage({ type: 'ccagent:account-bridge-ticket', channel, state, ticket: value.ticket }, origin);
      } catch { if (!settled) finish(new Error('账户连接未能完成，请重新点击打开。')); }
    }
    window.addEventListener('message', receive);
    window.addEventListener('pagehide', cancel); window.addEventListener('ccagent:account-changing', cancel);
    try { popup = window.open(destination.href, 'ccagent-account-' + channel, 'popup,width=1100,height=820'); }
    catch { finish(new Error('浏览器未能打开账户窗口，请允许弹出窗口后重试。')); return; }
    if (!popup) { finish(new Error('账户窗口被浏览器拦截，请允许弹出窗口后重新点击。')); return; }
    timeout = window.setTimeout(() => finish(new Error('账户连接超时，请重新点击打开。')), 120000);
    closePoll = window.setInterval(() => { if (popup.closed) finish(new Error('账户窗口已关闭，请重新点击打开。')); }, 500);
  });
}
