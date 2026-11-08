// Edit this campaign to replace the temporary creative or disable automatic display.
export const HOME_PROMOTION = Object.freeze({
  id: "cscec-northwest-2026-11", enabled: true,
  name: "中国建筑西北设计研究院有限公司",
  description: "走近中建西北院，了解企业动态、建筑设计与工程实践。",
  url: "https://nwin.cscec.com/", button: "访问官网",
});

export function createHomePromotion({ api, isIdle, campaign = HOME_PROMOTION, storage, now = () => new Date() }) {
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch { storage = null; } }
  let userId = "", timer, disposed = false, lastActivity = 0, previousFocus;
  const shown = new Set();
  const dialog = document.createElement("dialog");
  dialog.className = "home-promotion"; dialog.id = "home-promotion";
  dialog.setAttribute("aria-labelledby", "home-promotion-title");
  dialog.setAttribute("aria-describedby", "home-promotion-description");
  const add = (tag, className, text) => { const element = document.createElement(tag); element.className = className; element.textContent = text; return element; };
  const close = add("button", "home-promotion-close", "×"); close.type = "button"; close.setAttribute("aria-label", "关闭广告");
  const art = add("div", "home-promotion-art", ""); art.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 5; i++) art.append(add("span", "", ""));
  const content = add("div", "home-promotion-content", "");
  const title = add("h2", "", campaign.name); title.id = "home-promotion-title";
  const description = add("p", "", campaign.description); description.id = "home-promotion-description";
  const link = add("a", "home-promotion-link", `${campaign.button} ↗`);
  // Only a normal external HTTPS destination is supported for campaigns.
  let valid = false;
  try { const url = new URL(campaign.url); valid = url.protocol === "https:" && !url.username && !url.password; if (valid) link.href = url.href; } catch { /* Disabled invalid creative. */ }
  link.target = "_blank"; link.rel = "noopener noreferrer"; link.referrerPolicy = "no-referrer";
  content.append(add("span", "home-promotion-label", "广告 · 企业资讯"), title, description, link, add("small", "", "每日最多展示一次，可随时关闭"));
  dialog.append(close, art, content); document.body.append(dialog);
  const date = () => { const value = now(); return `${value.getFullYear()}-${value.getMonth() + 1}-${value.getDate()}`; };
  const key = () => `ccagent:promotion:${userId}:${campaign.id}`;
  function hasShown() {
    if (shown.has(`${key()}:${date()}`)) return true;
    try { return storage?.getItem(key()) === date(); } catch { return false; }
  }
  function dismiss() { if (dialog.open) dialog.close(); }
  close.addEventListener("click", dismiss); link.addEventListener("click", dismiss);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dismiss(); } });
  dialog.addEventListener("close", () => { if (previousFocus?.isConnected) previousFocus.focus(); });
  // Escape is handled by the native modal dialog, which also traps keyboard focus.
  function activity() { lastActivity = now().getTime(); if (dialog.open && !isIdle()) dismiss(); }
  document.addEventListener("input", activity);
  async function tryShow() {
    if (disposed || !valid || !campaign.enabled || !userId || document.hidden || dialog.open || hasShown() || !isIdle() || now().getTime() - lastActivity < 3500) return false;
    if (document.querySelector('.modal-backdrop:not(.hidden), .voice-backdrop:not(.hidden), dialog[open]')) return false;
    previousFocus = document.activeElement;
    if (typeof dialog.showModal !== "function") return false;
    dialog.showModal(); close.focus();
    shown.add(`${key()}:${date()}`);
    try { storage?.setItem(key(), date()); } catch { /* In-memory frequency cap still applies. */ }
    return true;
  }
  async function start() {
    if (disposed || !valid || !campaign.enabled || timer) return;
    try { const account = await api("/api/account/status"); userId = typeof account.user?.id === "string" ? account.user.id : ""; } catch { return; }
    if (!userId || disposed) return;
    timer = setInterval(() => { if (dialog.open && !isIdle()) dismiss(); void tryShow(); }, 4000);
  }
  return { start, tryShow, dismiss, destroy() { disposed = true; clearInterval(timer); document.removeEventListener("input", activity); dismiss(); dialog.remove(); } };
}
