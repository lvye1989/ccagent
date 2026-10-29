const $ = (id) => document.getElementById(id);

function speakable(text) {
  return text
    .replace(/```[\s\S]*?```/g, "已省略代码块。")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*_>]/g, "")
    .trim()
    .slice(0, 4000);
}

export function createVoiceUI({ submit, getBusy, getMode }) {
  const overlay = $("voice-overlay");
  const dialog = overlay.querySelector(".voice-dialog");
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const speech = window.speechSynthesis;
  let active = false;
  let recognition = null;
  let restartTimer = null;
  let awaitingReply = false;
  let reply = "";

  function show(state, status, caption) {
    dialog.dataset.state = state;
    $("voice-status").textContent = status;
    if (caption !== undefined) $("voice-caption").textContent = caption;
  }

  function clearRecognition() {
    clearTimeout(restartTimer);
    restartTimer = null;
    if (recognition) {
      const current = recognition;
      recognition = null;
      current.onend = null;
      current.onerror = null;
      current.onresult = null;
      try { current.abort(); } catch { /* Already stopped. */ }
    }
  }

  function stop() {
    active = false;
    awaitingReply = false;
    reply = "";
    clearRecognition();
    speech?.cancel();
    overlay.classList.add("hidden");
  }

  function listen() {
    if (!active || awaitingReply || recognition) return;
    if (getBusy()) {
      show("waiting", "任务运行中，完成后继续聆听…");
      restartTimer = setTimeout(listen, 500);
      return;
    }
    const current = new Recognition();
    recognition = current;
    current.lang = navigator.language || "zh-CN";
    current.continuous = false;
    current.interimResults = true;
    current.maxAlternatives = 1;
    show("listening", "正在聆听…", "说出你的问题，CCAGENT 会回答并朗读。");
    current.onresult = (event) => {
      let partial = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result?.[0]?.transcript || "";
        if (result?.isFinal) final += transcript;
        else partial += transcript;
      }
      if (partial) $("voice-caption").textContent = partial;
      if (!final.trim() || !active || awaitingReply) return;
      const prompt = final.trim();
      awaitingReply = true;
      reply = "";
      clearRecognition();
      show("waiting", "正在发送并等待回复…", `你：${prompt}`);
      void Promise.resolve(submit(prompt, getMode())).then((accepted) => {
        if (accepted || !active) return;
        awaitingReply = false;
        show("error", "发送失败，稍后可再说一次", prompt);
        restartTimer = setTimeout(listen, 1200);
      }).catch((error) => {
        awaitingReply = false;
        show("error", error.message || "发送失败", prompt);
        if (active) restartTimer = setTimeout(listen, 1200);
      });
    };
    current.onerror = (event) => {
      if (recognition !== current || !active) return;
      recognition = null;
      const code = event.error;
      if (["not-allowed", "service-not-allowed", "audio-capture"].includes(code)) {
        active = false;
        show("error", code === "audio-capture" ? "未检测到可用麦克风" : "请允许浏览器使用麦克风", "关闭后可重新点击语音按钮尝试。");
      } else if (code !== "aborted" && code !== "no-speech") {
        active = false;
        show("error", `语音识别失败：${code}`, "请检查浏览器的语音识别服务。");
      }
      if (active && (code === "no-speech" || code === "aborted")) restartTimer = setTimeout(listen, 500);
    };
    current.onend = () => {
      if (recognition !== current) return;
      recognition = null;
      if (active && !awaitingReply) restartTimer = setTimeout(listen, 500);
    };
    try { current.start(); }
    catch (error) {
      recognition = null;
      active = false;
      show("error", "无法启动语音识别", error.message || "请检查浏览器权限。");
    }
  }

  function readReply(text) {
    if (!active) return;
    const spoken = speakable(text);
    if (!spoken) {
      show("listening", "继续说话…");
      listen();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(spoken);
    utterance.lang = /[\u3400-\u9fff]/.test(spoken) ? "zh-CN" : (navigator.language || "en-US");
    utterance.rate = 1;
    utterance.onend = () => { if (active) listen(); };
    utterance.onerror = () => { if (active) { show("error", "朗读失败，可以继续说话"); listen(); } };
    show("speaking", "正在朗读回复…", text.slice(0, 1000));
    try {
      speech.cancel();
      speech.speak(utterance);
    } catch (error) {
      show("error", "朗读未能启动", error.message || "可以继续说话。");
      listen();
    }
  }

  function start() {
    stop();
    overlay.classList.remove("hidden");
    if (!Recognition || !speech || !window.SpeechSynthesisUtterance) {
      show("error", "此浏览器不支持语音对话", "请使用支持语音识别和朗读的浏览器。");
      return;
    }
    active = true;
    listen();
  }

  for (const id of ["home-voice", "thread-voice"]) $(id).addEventListener("click", start);
  for (const id of ["voice-close", "voice-stop"]) $(id).addEventListener("click", stop);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) stop(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !overlay.classList.contains("hidden")) stop(); });

  return {
    stop,
    handleEvent(event) {
      if (!active || !awaitingReply) return;
      if (event.type === "assistant") {
        const content = event.message?.content;
        reply += typeof content === "string" ? content : Array.isArray(content)
          ? content.filter((block) => block.type === "text").map((block) => block.text).join("\n") : "";
      }
      if (event.type === "interaction") show("waiting", "请在主界面处理确认，再继续语音对话");
      if (event.type === "turn_complete") {
        awaitingReply = false;
        if (event.reason && event.reason !== "completed") {
          show("error", `任务结束：${event.reason}`, "请结束语音对话或继续说话。");
          listen();
        } else readReply(reply);
        reply = "";
      }
    },
  };
}
