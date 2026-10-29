export function createSchedulesUI({ api, toast, openSession }) {
  const $ = (id) => document.getElementById(id);
  let tasks = [];
  let loading = false;

  function button(label, onClick, danger = false) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    if (danger) element.className = "danger";
    element.addEventListener("click", onClick);
    return element;
  }

  function render() {
    const list = $("schedule-list");
    list.replaceChildren();
    if (!tasks.length) {
      const empty = document.createElement("p");
      empty.className = "schedule-empty";
      empty.textContent = "还没有定时任务。填写右侧表单来创建。";
      list.append(empty);
      return;
    }
    for (const task of tasks) {
      const card = document.createElement("article"); card.className = "schedule-card";
      const title = document.createElement("strong"); title.textContent = task.title;
      const detail = document.createElement("p"); detail.textContent = task.prompt;
      const status = document.createElement("small");
      const stateLabel = ({ active: "等待执行", running: "执行中", paused: "已暂停", completed: "已完成" })[task.status] || task.status;
      const recurrence = ({ none: "仅一次", daily: "每天", weekly: "每周" })[task.repeat] || task.repeat;
      status.textContent = `${stateLabel} · ${recurrence} · ${new Date(task.nextRunAt).toLocaleString("zh-CN")}`;
      card.append(title, detail, status);
      if (task.lastError) {
        const error = document.createElement("p"); error.className = "schedule-error"; error.textContent = task.lastError; card.append(error);
      }
      const actions = document.createElement("div"); actions.className = "schedule-actions";
      if (task.status === "active") actions.append(button("暂停", () => void change(task.id, "pause")));
      else if (task.status !== "running") actions.append(button("继续", () => void change(task.id, "resume")));
      if (task.status !== "running") actions.append(button("立即运行", () => void change(task.id, "run-now")));
      if (task.lastSessionId) actions.append(button("查看对话", () => openSession(task.lastSessionId)));
      if (task.status !== "running") actions.append(button("删除", () => { if (window.confirm("删除这个定时任务？")) void change(task.id, "delete"); }, true));
      card.append(actions);
      list.append(card);
    }
  }

  async function refresh() {
    try { tasks = (await api("/api/schedules")).tasks; render(); }
    catch (error) { toast(`定时任务读取失败：${error.message}`); }
  }

  async function change(id, action) {
    try {
      await api(`/api/schedules/${id}`, { method: "POST", body: JSON.stringify({ action }) });
      await refresh();
    } catch (error) { toast(error.message); }
  }

  async function refreshModels() {
    try {
      const result = await api("/api/models");
      const select = $("schedule-model");
      const previous = select.value;
      select.replaceChildren();
      for (const item of result.models.filter((model) => model.available)) {
        const option = document.createElement("option"); option.value = item.id; option.textContent = item.label;
        select.append(option);
      }
      select.value = previous || result.defaultModel;
    } catch (error) { toast(error.message); }
  }

  $("schedule-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (loading) return;
    const selected = $("schedule-time").value;
    const time = new Date(selected);
    if (!Number.isFinite(time.getTime())) return toast("请选择有效的运行时间。");
    loading = true;
    try {
      await api("/api/schedules", { method: "POST", body: JSON.stringify({
        title: $("schedule-title").value.trim(), prompt: $("schedule-prompt").value.trim(),
        nextRunAt: time.toISOString(), repeat: $("schedule-repeat").value,
        model: $("schedule-model").value, mode: $("schedule-mode").value,
      }) });
      $("schedule-form").reset();
      setDefaultTime();
      await refresh();
      toast("定时任务已创建");
    } catch (error) { toast(error.message); }
    finally { loading = false; }
  });

  function setDefaultTime() {
    const date = new Date(Date.now() + 60 * 60 * 1000);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
    $("schedule-time").value = local.toISOString().slice(0, 16);
  }
  setDefaultTime();
  $("schedule-refresh").addEventListener("click", () => void refresh());
  document.querySelectorAll("[data-schedule-suggestion]").forEach((item) => item.addEventListener("click", () => {
    $("schedule-prompt").value = item.dataset.scheduleSuggestion;
    $("schedule-title").value = item.textContent;
    $("schedule-prompt").focus();
  }));
  setInterval(() => { if (!$("schedules-view").classList.contains("hidden") && !document.hidden) void refresh(); }, 10000);
  return { open: async () => { await Promise.all([refresh(), refreshModels()]); }, refresh };
}
