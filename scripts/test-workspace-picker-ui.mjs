/** Offline folder-picker interaction tests; all filesystem/native calls are fixtures. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = path.resolve(import.meta.dirname, "..");
const { Window } = await import(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : "happy-dom");
const window = new Window({ url: "http://offline-picker.test/", settings: { disableJavaScriptFileLoading: true, enableJavaScriptEvaluation: false, enableCSSFileLoading: false, enableImageFileLoading: false } });
window.document.write(await fs.readFile(path.join(root, "web/index.html"), "utf8"));
globalThis.document = window.document;
const { createWorkspacePicker } = await import(pathToFileURL(path.join(root, "web/workspace-picker.js")).href);
const $ = (id) => document.getElementById(id);
const home = "C:\\Projects", child = home + "\\中文 项目", empty = home + "\\empty";
let current = home, picked = null, failNative = false, deferredSwitch;
const selections = [], requests = [];
const api = async (route) => {
  requests.push(route);
  if (route === "/api/workspaces") return { current, recent: [home, child], locations: [{ name: "项目磁盘", path: home }], nativePickerAvailable: true };
  if (route === "/api/workspaces/pick") { if (failNative) throw new Error("Native picker unavailable"); return { path: picked }; }
  const url = new URL(route, "http://offline-picker.test");
  const dir = url.searchParams.get("path");
  if (![home, child, empty].includes(dir)) throw new Error("文件夹不存在或不可访问");
  const query = url.searchParams.get("query");
  const folders = dir === home ? [{ name: "中文 项目", path: child }, { name: "empty", path: empty }] : [];
  return { path: dir, parent: dir === home ? null : home, breadcrumbs: [{ name: "Projects", path: home }, ...(dir !== home ? [{ name: dir === child ? "中文 项目" : "empty", path: dir }] : [])], folders: query ? folders.filter((f) => f.name.includes(query)) : folders, total: folders.length, truncated: false };
};
const picker = createWorkspacePicker({ api, getWorkspace: () => current, onSelect: async (folder) => { selections.push(folder); if (deferredSwitch) await deferredSwitch; current = folder; } });
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const click = async (node) => { assert(node); node.click(); await settle(); };
try {
  $("context-workspace").focus(); await picker.open();
  assert(!$("workspace-overlay").classList.contains("hidden"));
  assert.equal($("workspace-folders").querySelectorAll("[data-folder]").length, 2);
  assert.equal(document.activeElement.id, "workspace-search");
  await click($("workspace-folders").querySelector("[data-folder]"));
  assert.equal($("workspace-selection-path").textContent, child);
  assert.deepEqual(selections, [], "Browsing and highlighting never change the running workspace");
  await click($("workspace-use"));
  assert.equal(current, child); assert($("workspace-overlay").classList.contains("hidden"));
  assert.equal(document.activeElement.id, "context-workspace", "Closing restores keyboard focus");

  await picker.open(); assert.match($("workspace-folders").textContent, /没有子文件夹/);
  await click($("workspace-up")); assert.equal($("workspace-input").value, home);
  const emptyRow = [...$("workspace-folders").querySelectorAll("[data-folder]")].find((r) => r.dataset.folder === empty);
  emptyRow.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })); await settle();
  assert.equal($("workspace-input").value, empty); assert.equal($("workspace-use").disabled, false, "Empty folders can be used");
  $("workspace-input").value = "not-an-existing-folder";
  $("workspace-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); await settle();
  assert.match($("workspace-message").textContent, /不存在/); assert.equal($("workspace-use").disabled, true);
  await click($("workspace-reload")); assert.equal($("workspace-use").disabled, false, "A valid refresh recovers from a bad path");
  await click($("workspace-cancel")); assert.equal(current, child, "Cancel preserves the current workspace");

  await picker.open(); $("workspace-input").value = home;
  await click($("workspace-use")); assert.equal(current, home, "Pasted paths can be confirmed directly without selecting the old directory");

  await picker.open(); const before = selections.length;
  await click($("workspace-native")); assert.match($("workspace-message").textContent, /取消/); assert.equal(selections.length, before);
  failNative = true; await click($("workspace-native")); assert.match($("workspace-message").textContent, /unavailable/);
  failNative = false; picked = home; await click($("workspace-native")); assert.equal(current, home, "Native selection starts work in the chosen folder");

  await picker.open(); $("workspace-search").value = "中文"; $("workspace-search").dispatchEvent(new window.Event("input")); await new Promise((r) => setTimeout(r, 220)); await settle();
  assert.equal($("workspace-folders").querySelectorAll("[data-folder]").length, 1);
  assert(requests.some((r) => r.includes("query=%E4%B8%AD%E6%96%87")));
  $("workspace-show-hidden").checked = true; $("workspace-show-hidden").dispatchEvent(new window.Event("change")); await settle();
  assert(requests.at(-1).includes("hidden=1"));
  let finishSwitch; deferredSwitch = new Promise((r) => { finishSwitch = r; });
  await click($("workspace-use")); assert.equal($("workspace-close").disabled, true);
  picker.close(); assert(!$("workspace-overlay").classList.contains("hidden"), "Switching cannot be dismissed halfway through");
  finishSwitch(); await settle(); assert($("workspace-overlay").classList.contains("hidden"));
  console.log("Workspace picker DOM: directory navigation, Unicode paths, selection/confirmation, empty folders, bad-path recovery, cancel, native cancel/error/result, search, hidden folders, busy guards and focus passed.");
} finally { await window.happyDOM.close(); }
