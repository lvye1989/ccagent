import { randomUUID } from "node:crypto";
import { QueryEngine } from "../core/queryEngine.js";
import { requirePlatformScope } from "../platform/account.js";
import { loadPermissionSettings } from "../permissions/permissions.js";
import { configureFileHistory } from "../session/fileHistory.js";
import type { Tool, ToolContext, ToolResult } from "../tools/Tool.js";
import type { Usage } from "../types/message.js";
import { handleWhiteboard, type Whiteboard } from "./webWhiteboards.js";
import { compileWhiteboardDrawing, WHITEBOARD_DRAWING_SCHEMA, WHITEBOARD_DRAWING_GUIDE, summarizeWhiteboardElements, type CompiledWhiteboardDrawing } from "./whiteboardDrawing.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RUNS = 64, MAX_CONVERSATIONS = 24, RETENTION_MS = 30 * 60_000, MAX_TEXT = 64_000;
type RunStatus = "running" | "completed" | "failed" | "stopped";
export type WhiteboardAIRun = {
  runId: string; conversationId: string; workspace: string; id: string; revision: number; model: string;
  status: RunStatus; text: string; drawings: CompiledWhiteboardDrawing[]; error?: string; usage?: Usage;
};
export class WhiteboardAIError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "invalid_ai_request") { super(message); this.name = "WhiteboardAIError"; }
}
export type WhiteboardAIManagerOptions = {
  getWorkspace: () => string;
  getDefaultModel: () => string;
  validateModel: (id: string) => Promise<boolean>;
  isBusy: () => boolean;
  onBusy: (runId: string) => void;
  onIdle: (runId: string) => void;
  /** Runtime/test bound only; no request can change the agent timeout. */
  timeoutMs?: number;
};
type Run = WhiteboardAIRun & { owner: string; controller: AbortController; startedAt: number; finishedAt?: number; conversation: Conversation };
type Conversation = {
  id: string; owner: string; workspace: string; boardId: string; model: string;
  engine: QueryEngine; context: ToolContext; snapshot: Whiteboard; current?: Run; lastUsed: number;
};
const receipt = (value: unknown, isError = false): ToolResult => ({ content: JSON.stringify(value), ...(isError ? { isError: true } : {}) });
const instructions = `You are CCAGENT's whiteboard drawing agent. The user can ask questions or ask you to create/edit diagrams.
Only WhiteboardRead and WhiteboardDraw are available. You cannot execute code, use a shell, access files, browse, call other agents, or change settings.
WhiteboardRead returns the CURRENT SAVED canvas for this run. Never assume a previous turn's draft was applied; read again for edits.
For requested drawings, call WhiteboardDraw with the bounded declarative drawing format. You may repair invalid tool input and retry.
Combine the complete change into ONE successful WhiteboardDraw call per run. The frontend converts this draft into editable Excalidraw elements.
A successful tool receipt means only that a draft was prepared. It does NOT mean the canvas was applied or saved. Do not claim it was saved.
Do not put executable JavaScript, HTML, SVG, URLs, or raw Excalidraw JSON in tool calls. Do not emit a pretend tool call as text.
Answer briefly in the user's language. If no drawing is needed, reply normally without a tool.
${WHITEBOARD_DRAWING_GUIDE}`;

/** Uses the real shared engine/provider/auth/billing path; drafts never write the board store. */
export function createWhiteboardAIManager(options: WhiteboardAIManagerOptions) {
  const runs = new Map<string, Run>();
  const conversations = new Map<string, Conversation>();
  let disposed = false;
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new Error("Invalid whiteboard AI timeout");

  function prune(): void {
    const cutoff = Date.now() - RETENTION_MS;
    for (const [id, run] of runs) if (run.status !== "running" && (run.finishedAt ?? run.startedAt) < cutoff) runs.delete(id);
    for (const [id, conversation] of conversations) if (conversation.current?.status !== "running" && conversation.lastUsed < cutoff) conversations.delete(id);
    while (runs.size >= MAX_RUNS) {
      const oldest = [...runs.values()].filter((run) => run.status !== "running").sort((left, right) => left.startedAt - right.startedAt)[0];
      if (!oldest) throw new WhiteboardAIError("AI 绘图任务已满，请稍后重试。", 409, "busy");
      runs.delete(oldest.runId);
    }
    while (conversations.size >= MAX_CONVERSATIONS) {
      const oldest = [...conversations.values()].filter((conversation) => conversation.current?.status !== "running").sort((left, right) => left.lastUsed - right.lastUsed)[0];
      if (!oldest) throw new WhiteboardAIError("AI 对话已满，请稍后重试。", 409, "busy");
      conversations.delete(oldest.id);
    }
  }
  function active(conversation: Conversation): boolean {
    const run = conversation.current;
    return !!run && run.status === "running" && !run.controller.signal.aborted && options.getWorkspace() === run.workspace && Date.now() - run.startedAt < timeoutMs;
  }
  function stopRun(run: Run, timeout = false): void {
    if (run.status !== "running") return;
    run.status = timeout ? "failed" : "stopped";
    if (timeout) run.error = "AI 绘图已超时，请缩小本次任务后重试。";
    run.drawings = [];
    run.finishedAt = Date.now();
    run.controller.abort();
    run.conversation.engine.interrupt();
  }
  function view(run: Run): WhiteboardAIRun {
    return { runId: run.runId, conversationId: run.conversationId, workspace: run.workspace, id: run.id, revision: run.revision, model: run.model,
      status: run.status, text: run.text, drawings: structuredClone(run.drawings), ...(run.error ? { error: run.error } : {}), usage: { ...run.conversation.engine.getState().totalUsage } };
  }
  async function checkedRun(runId: string, workspace: string): Promise<Run> {
    const account = await requirePlatformScope();
    if (workspace !== options.getWorkspace()) throw new WhiteboardAIError("工作文件夹已切换，请重新打开 AI 对话。", 409, "workspace_changed");
    const run = runs.get(runId);
    if (!UUID.test(runId) || !run || run.owner !== account.user.id || run.workspace !== workspace) throw new WhiteboardAIError("AI 绘图任务不存在或已过期。", 404, "not_found");
    return run;
  }
  async function newConversation(owner: string, workspace: string, model: string, snapshot: Whiteboard): Promise<Conversation> {
    const id = randomUUID();
    let conversation!: Conversation;
    const tools: Tool[] = [
      {
        name: "WhiteboardRead", description: "Read a bounded inventory of the current SAVED canvas for this run. No image file bytes or machine paths are returned.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }, decisionPolicy: "local", isReadOnly: () => true,
        isEnabled: () => active(conversation), isConcurrencySafe: () => true,
        async call(input, context) {
          if (context.abortSignal?.aborted || !active(conversation) || Object.keys(input).length) return receipt({ error: "当前画布读取已取消或参数无效。" }, true);
          const current = conversation.snapshot;
          return receipt({ id: current.id, revision: current.revision, inventory: summarizeWhiteboardElements(current.scene.elements) });
        },
      },
      {
        name: "WhiteboardDraw", description: "Compile ONE complete bounded drawing draft. This prepares a draft only; it does not apply or save the canvas. Invalid input may be repaired and retried.",
        inputSchema: WHITEBOARD_DRAWING_SCHEMA as Tool["inputSchema"], decisionPolicy: "local", isReadOnly: () => false,
        isEnabled: () => active(conversation),
        async call(input, context) {
          if (context.abortSignal?.aborted || !active(conversation)) return receipt({ error: "当前绘图任务已取消。" }, true);
          const run = conversation.current!;
          if (run.drawings.length) return receipt({ error: "本轮已有完整草稿。每轮仅接受一次成功绘图；请结束回复，下一轮读取已保存画布后继续。" }, true);
          try {
            const draft = compileWhiteboardDrawing(input, { requestId: randomUUID(), elements: conversation.snapshot.scene.elements });
            if (context.abortSignal?.aborted || !active(conversation)) return receipt({ error: "绘图任务已取消，草稿未提交。" }, true);
            run.drawings.push(draft);
            return receipt({ ok: true, status: "draft_prepared", applied: false, saved: false, requestId: draft.requestId, summary: draft.summary, aliases: draft.aliases });
          } catch (error) {
            const message = error instanceof Error && error.name === "WhiteboardDrawingError" ? error.message : "绘图数据无效，请按 schema 修正后重试。";
            return receipt({ error: message, status: "invalid_drawing", applied: false, saved: false }, true);
          }
        },
      },
    ];
    const settings = await loadPermissionSettings(workspace);
    const context: ToolContext = { cwd: workspace, sessionId: id, temporaryChat: true, agentTeamsAllowed: false, scopedTools: Object.freeze(tools), sessionInstructions: instructions };
    const engine = new QueryEngine({ model, toolContext: context, permissionMode: settings.mode, permissionSettings: settings,
      sessionPermissionRules: { allow: ["WhiteboardRead", "WhiteboardDraw"], deny: [] }, onPermissionRequest: async () => "deny", maxTurns: 10 });
    conversation = { id, owner, workspace, boardId: snapshot.id, model, engine, context, snapshot, lastUsed: Date.now() };
    return conversation;
  }
  async function drive(run: Run, prompt: string): Promise<void> {
    const conversation = run.conversation;
    const timer = setTimeout(() => stopRun(run, true), timeoutMs); timer.unref();
    let iterator: ReturnType<QueryEngine["submitMessage"]> | undefined;
    let sawError = false;
    try {
      if (!active(conversation)) return;
      await configureFileHistory(run.workspace, conversation.id, true);
      if (!active(conversation)) return;
      conversation.engine.beginUserTurn();
      iterator = conversation.engine.submitMessage(`[Whiteboard request]\n${prompt}\n\nCurrent saved canvas revision: ${run.revision}. Earlier drafts may not have been applied. Read the current saved canvas before editing existing elements.`);
      while (run.status === "running") {
        const item = await iterator.next();
        if (run.status !== "running") break;
        if (item.done) {
          if (item.value.reason === "aborted") { stopRun(run); break; }
          if (item.value.reason && item.value.reason !== "completed") throw new Error("agent-not-completed");
          const account = await requirePlatformScope(0);
          if (account.user.id !== run.owner || options.getWorkspace() !== run.workspace) throw new Error("scope-changed");
          if (sawError) throw new Error("provider-error");
          run.status = "completed"; break;
        }
        const event = item.value;
        if (event.type === "text") run.text = (run.text + event.text).slice(0, MAX_TEXT);
        if (event.type === "error" || (event.type === "command" && event.kind === "error")) sawError = true;
      }
    } catch {
      if (run.status === "running") { run.status = "failed"; run.error = "AI 绘图未完成，请检查当前模型服务后重试。"; }
    } finally {
      clearTimeout(timer);
      if (run.status === "running") { run.status = "failed"; run.error = "AI 绘图未完成，请重试。"; }
      if (run.status !== "completed") run.drawings = [];
      run.finishedAt = Date.now(); conversation.lastUsed = run.finishedAt;
      if (iterator) await iterator.return({ handled: true, reason: "aborted" }).catch(() => {});
      options.onIdle(run.runId);
    }
  }

  return {
    async start(input: Record<string, unknown>): Promise<{ runId: string; conversationId: string }> {
      if (disposed) throw new WhiteboardAIError("AI 绘图服务正在退出，请重新打开应用。", 503, "unavailable");
      const workspace = input.workspace;
      if (typeof workspace !== "string" || workspace !== options.getWorkspace()) throw new WhiteboardAIError("工作文件夹已切换，请重新打开 AI 对话。", 409, "workspace_changed");
      if (typeof input.id !== "string" || !UUID.test(input.id) || !Number.isSafeInteger(input.revision) || (input.revision as number) < 1) throw new WhiteboardAIError("请先保存有效的画布和版本，再开始 AI 绘图。");
      if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 12_000 || input.prompt.trim().startsWith("/")) throw new WhiteboardAIError("请输入 12000 字以内的绘图要求；白板对话不执行斜杠命令。");
      if (input.model !== undefined && (typeof input.model !== "string" || !input.model.trim() || input.model.length > 200)) throw new WhiteboardAIError("请选择有效模型。");
      if (input.conversationId !== undefined && (typeof input.conversationId !== "string" || !UUID.test(input.conversationId))) throw new WhiteboardAIError("AI 对话编号无效。");
      const runId = randomUUID();
      if (options.isBusy()) throw new WhiteboardAIError("请先结束当前任务，再开始 AI 绘图。", 409, "busy");
      // Reserve synchronously before ANY await: workspace changes and ordinary
      // agent turns use the same worker-owned busy guard.
      options.onBusy(runId);
      let launched = false;
      try {
        prune();
        const account = await requirePlatformScope(0);
        const existing = typeof input.conversationId === "string" ? conversations.get(input.conversationId) : undefined;
        if (input.conversationId && (!existing || existing.owner !== account.user.id)) throw new WhiteboardAIError("AI 对话不存在或已过期，请开始新对话。", 404, "not_found");
        if (existing && (existing.workspace !== workspace || existing.boardId !== input.id || existing.current?.status === "running")) throw new WhiteboardAIError("当前 AI 对话不属于这张画布，请开始新对话。", 409, "conversation_mismatch");
        const selectedModel = typeof input.model === "string" ? input.model : existing?.model ?? options.getDefaultModel();
        if (existing && selectedModel !== existing.model) throw new WhiteboardAIError("切换模型后请开始新的白板 AI 对话。", 409, "conversation_mismatch");
        if (!(await options.validateModel(selectedModel))) throw new WhiteboardAIError("所选模型尚未配置或暂不可用。", 400, "model_unavailable");
        const response = await handleWhiteboard("open", { id: input.id }, workspace);
        if (!("board" in response) || !("scene" in response.board)) throw new WhiteboardAIError("画布暂时无法读取。");
        const snapshot = response.board;
        if (snapshot.revision !== input.revision) throw new WhiteboardAIError("画布已被其他窗口更新，请重新打开后再发送。", 409, "conflict");
        if (options.getWorkspace() !== workspace) throw new WhiteboardAIError("工作文件夹已切换，请重新打开 AI 对话。", 409, "workspace_changed");
        if (existing && existing.engine.getState().messages.length > 80) throw new WhiteboardAIError("这段对话已较长，请开始新对话继续绘图。", 409, "conversation_limit");
        if (existing) await existing.engine.reloadPermissionSettings();
        const conversation = existing ?? await newConversation(account.user.id, workspace, selectedModel, snapshot);
        const controller = new AbortController();
        const run: Run = { runId, conversationId: conversation.id, workspace, id: snapshot.id, revision: snapshot.revision, model: selectedModel,
          status: "running", text: "", drawings: [], owner: account.user.id, controller, startedAt: Date.now(), conversation };
        conversation.snapshot = snapshot; conversation.current = run; conversation.context.abortSignal = controller.signal; conversation.lastUsed = Date.now();
        conversations.set(conversation.id, conversation); runs.set(runId, run);
        launched = true;
        void drive(run, input.prompt.trim());
        return { runId, conversationId: conversation.id };
      } finally { if (!launched) options.onIdle(runId); }
    },
    async status(runId: string, workspace: string): Promise<WhiteboardAIRun> { return view(await checkedRun(runId, workspace)); },
    async stop(runId: string, workspace: string): Promise<WhiteboardAIRun> { const run = await checkedRun(runId, workspace); stopRun(run); return view(run); },
    dispose(): void { disposed = true; for (const run of runs.values()) stopRun(run); },
  };
}
