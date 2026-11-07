const CLOUDTV_URL = "https://cjai.pro/";

export function createCloudTVUI({ onBack }) {
  const view = document.createElement("section");
  view.id = "cloudtv-view";
  view.className = "cloudtv-view hidden";
  view.setAttribute("aria-label", "cloudTV 网页");
  view.innerHTML = `
    <header class="cloudtv-toolbar">
      <div class="cloudtv-brand"><span class="cloudtv-mark" aria-hidden="true">TV</span><div><h1>cloudTV</h1><span>cjai.pro</span></div></div>
      <div class="cloudtv-actions">
        <button id="cloudtv-back" type="button">返回对话</button>
        <button id="cloudtv-refresh" type="button" aria-label="刷新 cloudTV 网页">刷新</button>
        <a href="https://cjai.pro/" target="_blank" rel="noopener noreferrer">在浏览器中打开 <span aria-hidden="true">↗</span></a>
      </div>
    </header>
    <div class="cloudtv-page">
      <iframe id="cloudtv-frame" title="cloudTV — cjai.pro" referrerpolicy="no-referrer" sandbox="allow-scripts allow-forms allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox allow-modals" allow="clipboard-write; fullscreen"></iframe>
      <div class="cloudtv-loading" id="cloudtv-loading" role="status">正在打开 cloudTV…</div>
    </div>
    <p class="cloudtv-notice hidden" id="cloudtv-notice" role="status">网页加载较慢或暂时无法显示，请尝试刷新，或点击“在浏览器中打开”。</p>`;
  document.getElementById("content").append(view);
  const frame = view.querySelector("iframe");
  const loading = view.querySelector("#cloudtv-loading");
  const notice = view.querySelector("#cloudtv-notice");
  let started = false, timer;

  function refresh() {
    started = true;
    clearTimeout(timer);
    loading.classList.remove("hidden");
    notice.classList.add("hidden");
    frame.setAttribute("aria-busy", "true");
    // Use the site's own origin and login. Local account cookies and API keys stay local.
    frame.src = CLOUDTV_URL;
    timer = setTimeout(() => {
      loading.classList.add("hidden");
      notice.classList.remove("hidden");
      frame.setAttribute("aria-busy", "false");
    }, 15000);
  }

  frame.addEventListener("load", () => {
    if (!started) return;
    clearTimeout(timer);
    loading.classList.add("hidden");
    notice.classList.add("hidden");
    frame.setAttribute("aria-busy", "false");
  });
  frame.addEventListener("error", () => {
    clearTimeout(timer);
    loading.classList.add("hidden");
    notice.classList.remove("hidden");
    frame.setAttribute("aria-busy", "false");
  });
  view.querySelector("#cloudtv-back").addEventListener("click", onBack);
  view.querySelector("#cloudtv-refresh").addEventListener("click", refresh);
  return { open() { if (!started) refresh(); }, refresh };
}
