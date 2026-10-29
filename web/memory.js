export function createMemoryUI({ api, toast, onDelete }) {
  const $ = (id) => document.getElementById(id);
  const state = { sessions: [], memories: [], selected: null };

  function messageText(message) {
    if (typeof message.content === "string") return message.content;
    return (message.content || []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
  }

  function render() {
    const list = $("memory-session-list");
    list.replaceChildren();
    const query = $("memory-query").value.trim().toLocaleLowerCase();
    const filtered = state.sessions.filter((item) => (item.firstPrompt || item.sessionId).toLocaleLowerCase().includes(query));
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "library-empty";
      empty.textContent = query ? "没有匹配的聊天记录。" : "当前项目没有保存的聊天记录。";
      list.append(empty);
    }
    for (const item of filtered) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `memory-session-row${state.selected === item.sessionId ? " selected" : ""}`;
      const title = document.createElement("strong");
      title.textContent = item.firstPrompt?.trim().slice(0, 100) || "新聊天";
      const meta = document.createElement("small");
      meta.textContent = `${item.pinned ? "已保留 · " : ""}${item.messageCount} 条消息 · ${new Date(item.updatedAt).toLocaleString("zh-CN")}`;
      button.append(title, meta);
      button.addEventListener("click", () => void showSession(item));
      list.append(button);
    }
    const memories = $("memory-file-list");
    memories.replaceChildren();
    if (!state.memories.length) {
      const empty = document.createElement("p"); empty.className = "library-empty"; empty.textContent = "当前项目没有长期记忆。"; memories.append(empty);
    }
    for (const item of state.memories) {
      const row = document.createElement("div"); row.className = "memory-file-row";
      const title = document.createElement("strong"); title.textContent = item.name;
      const meta = document.createElement("small"); meta.textContent = `${item.type} · ${item.description}`;
      row.append(title, meta); memories.append(row);
    }
  }

  async function updateSession(id, action) {
    try {
      await api(`/api/memory/sessions/${id}`, { method: "POST", body: JSON.stringify({ action }) });
      if (action === "delete") {
        state.selected = null;
        $("memory-detail").innerHTML = '<div class="library-preview-empty">选择聊天记录查看内容</div>';
        onDelete(id);
      }
      await refresh();
      if (action !== "delete") {
        const item = state.sessions.find((session) => session.sessionId === id);
        if (item) await showSession(item);
      }
    } catch (error) { toast(error.message); }
  }

  async function showSession(item) {
    state.selected = item.sessionId;
    render();
    const pane = $("memory-detail");
    pane.replaceChildren();
    const head = document.createElement("h2"); head.textContent = item.firstPrompt?.trim().slice(0, 100) || "新聊天";
    const meta = document.createElement("p"); meta.textContent = `${item.model} · ${new Date(item.startedAt).toLocaleString("zh-CN")}`;
    const actions = document.createElement("div"); actions.className = "memory-actions";
    const pin = document.createElement("button"); pin.textContent = item.pinned ? "取消保留" : "保留此聊天";
    pin.addEventListener("click", () => void updateSession(item.sessionId, item.pinned ? "unpin" : "pin"));
    const remove = document.createElement("button"); remove.textContent = "删除记录"; remove.className = "danger";
    remove.addEventListener("click", () => {
      if (window.confirm("永久删除这条聊天记录？此操作无法撤销。")) void updateSession(item.sessionId, "delete");
    });
    actions.append(pin, remove);
    const transcript = document.createElement("div"); transcript.className = "memory-transcript";
    transcript.textContent = "正在载入聊天…";
    pane.append(head, meta, actions, transcript);
    try {
      const result = await api(`/api/memory/sessions/${item.sessionId}`);
      if (state.selected !== item.sessionId) return;
      transcript.replaceChildren();
      for (const message of result.messages) {
        const text = messageText(message);
        if (!text.trim()) continue;
        const row = document.createElement("div"); row.className = `memory-message ${message.role}`;
        const label = document.createElement("strong"); label.textContent = message.role === "user" ? "你" : "CCAGENT";
        const body = document.createElement("p"); body.textContent = text;
        row.append(label, body); transcript.append(row);
      }
      if (!transcript.childElementCount) transcript.textContent = "这条聊天尚无消息。";
    } catch (error) { transcript.textContent = error.message; }
  }

  async function refresh() {
    try {
      const data = await api("/api/memory");
      state.sessions = data.sessions;
      state.memories = data.memories;
      render();
    } catch (error) { toast(`记忆管理读取失败：${error.message}`); }
  }

  $("memory-refresh").addEventListener("click", () => void refresh());
  $("memory-query").addEventListener("input", render);
  return { open: refresh, refresh };
}
