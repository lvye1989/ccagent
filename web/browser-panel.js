export function createBrowserPanel({ api, toast, getSessionId }) {
  const panel = document.createElement("aside");
  panel.id = "browser-panel";
  panel.className = "browser-panel hidden";
  panel.setAttribute("aria-label", "网页侧栏");
  panel.innerHTML = `
    <div class="browser-panel-head">
      <div><strong>网页预览</strong><small id="browser-host">在当前对话旁打开</small></div>
      <button type="button" id="browser-close" class="browser-icon-button" aria-label="关闭网页侧栏">×</button>
    </div>
    <form id="browser-form" class="browser-address">
      <label class="sr-only" for="browser-url">网页地址</label>
      <input id="browser-url" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://example.com" aria-label="网页地址">
      <button type="submit" aria-label="访问网页">前往</button>
    </form>
    <div class="browser-controls">
      <button type="button" id="browser-refresh" class="browser-icon-button" title="刷新网页" aria-label="刷新网页">↻</button>
      <button type="button" id="browser-copy" class="browser-icon-button" title="复制地址" aria-label="复制地址">▤</button>
      <span id="browser-status" role="status">等待打开网页</span>
    </div>
    <div class="browser-frame-wrap">
      <div id="browser-empty" class="browser-empty">输入网址，或点击对话中的网页链接</div>
      <iframe id="browser-frame" class="hidden" title="网页预览" referrerpolicy="no-referrer" sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"></iframe>
    </div>
    <p class="browser-hint">部分网站禁止嵌入。若内容空白，可复制地址。</p>`;
  document.getElementById("thread-view").append(panel);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.id = "browser-toggle";
  toggle.className = "thread-browser-button";
  toggle.textContent = "▣ 网页";
  toggle.title = "在侧栏打开网页";
  toggle.setAttribute("aria-label", "在侧栏打开网页");
  document.querySelector(".thread-head").append(toggle);

  const $ = (id) => document.getElementById(id);
  const frame = $("browser-frame");
  let currentUrl = "";

  function showPanel() {
    panel.classList.remove("hidden");
    $("thread-view").classList.add("browser-open");
    toggle.setAttribute("aria-expanded", "true");
  }

  function show(url) {
    showPanel();
    if (!url) { $("browser-url").focus(); return; }
    if (currentUrl === url && !frame.classList.contains("hidden")) return;
    currentUrl = url;
    $("browser-url").value = url;
    $("browser-host").textContent = new URL(url).host;
    $("browser-status").textContent = "正在导航…";
    $("browser-empty").classList.add("hidden");
    frame.classList.remove("hidden");
    frame.src = url;
  }

  function hideLocal() {
    panel.classList.add("hidden");
    $("thread-view").classList.remove("browser-open");
    toggle.setAttribute("aria-expanded", "false");
    frame.src = "about:blank";
    frame.classList.add("hidden");
    $("browser-empty").classList.remove("hidden");
    $("browser-status").textContent = "等待打开网页";
    $("browser-host").textContent = "在当前对话旁打开";
    $("browser-url").value = "";
    currentUrl = "";
  }

  async function open(url) {
    const id = getSessionId();
    if (!id) { toast("请先打开一个对话"); return false; }
    const raw = url.trim();
    if (!raw) { showPanel(); $("browser-url").focus(); return false; }
    const normalized = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    try {
      const response = await api(`/api/sessions/${id}/browser`, {
        method: "POST", body: JSON.stringify({ url: normalized }),
      });
      show(response.url);
      return true;
    } catch (error) { toast(`无法打开网页：${error.message}`); return false; }
  }

  async function close() {
    const id = getSessionId();
    hideLocal();
    if (!id) return;
    try { await api(`/api/sessions/${id}/browser`, { method: "DELETE" }); }
    catch (error) { toast(error.message); }
  }

  toggle.addEventListener("click", () => { if (panel.classList.contains("hidden")) show(currentUrl); else void close(); });
  $("browser-close").addEventListener("click", () => void close());
  $("browser-form").addEventListener("submit", (event) => { event.preventDefault(); void open($("browser-url").value); });
  $("browser-refresh").addEventListener("click", () => {
    if (!currentUrl) return;
    $("browser-status").textContent = "正在刷新…";
    frame.src = currentUrl;
  });
  $("browser-copy").addEventListener("click", async () => {
    if (!currentUrl) return;
    try { await navigator.clipboard.writeText(currentUrl); toast("网址已复制"); }
    catch { toast("复制失败，请从地址栏复制"); }
  });
  frame.addEventListener("load", () => {
    if (currentUrl) $("browser-status").textContent = "已发送导航请求";
  });

  return {
    open,
    restore(url) { hideLocal(); if (url) show(url); },
    handleEvent(event) {
      if (event.type === "browser_open") show(event.url);
      if (event.type === "browser_close") hideLocal();
    },
  };
}
