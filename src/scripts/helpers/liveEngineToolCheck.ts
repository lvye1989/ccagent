import assert from 'node:assert/strict';
import { QueryEngine } from '../../core/queryEngine.js';
import { fileReadTool } from '../../tools/fileReadTool.js';

/** Local engine side of the opt-in hosted acceptance; typechecked with the CLI/Web application. */
export async function runLiveEngineToolCheck(options: { model: string; workspace: string; taskId: string; proofName: string; proof: string; onLocalSettingsApplied: () => void }) {
  let readCalls = 0;
  const restrictedRead = { ...fileReadTool, description: 'Read only stream-proof.txt once. Return its exact contents.', decisionPolicy: 'local' as const,
    inputSchema: { type: 'object' as const, properties: { file_path: { type: 'string', enum: [options.proofName] } }, required: ['file_path'], additionalProperties: false },
    async call(input: Record<string, unknown>, context: Parameters<typeof fileReadTool.call>[1]) {
      assert.equal(context.cwd, options.workspace); assert.equal(input.file_path, options.proofName); assert.ok(readCalls < 1, 'EXTRA_READ_REJECTED'); readCalls++;
      return fileReadTool.call({ file_path: options.proofName }, context);
    },
  };
  const engine = new QueryEngine({ model: options.model, maxTurns: 2, permissionMode: 'default', sessionPermissionRules: { allow: ['Read'], deny: [] },
    onPermissionRequest: async () => 'deny', toolContext: { cwd: options.workspace, sessionId: options.taskId, temporaryChat: true, agentTeamsAllowed: false,
      scopedTools: [restrictedRead], abortSignal: AbortSignal.timeout(180000), sessionInstructions: 'Only Read is available. Read the requested fixed fixture once, then answer with its exact verification token. Do not delegate or change files.' } });
  for await (const _event of engine.submitMessage('/think off')) { /* Ordinary local setting; no request rewriting. */ }
  options.onLocalSettingsApplied();
  const eventCounts: Record<string, number> = {}, toolExecutions: string[] = [];
  const modelErrors: { code?: string; status?: number }[] = [];
  let text = '', completedReason: unknown, modelErrorCount = 0, failedToolResults = 0;
  const iterator = engine.submitMessage(`Use Read exactly once on ${options.proofName}. After the tool result arrives, reply only with the exact verification token found in that file. Do not guess the token.`);
  while (true) {
    const item = await iterator.next();
    if (item.done) { completedReason = item.value.reason; break; }
    const event = item.value; eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
    if (event.type === 'text') text += event.text;
    if (event.type === 'tool_use_done') { toolExecutions.push(event.name); if (event.result.isError) failedToolResults++; }
    if (event.type === 'error') {
      modelErrorCount++;
      const error = event.error as { code?: unknown; status?: unknown };
      modelErrors.push({ ...(typeof error.code === 'string' && /^[A-Za-z0-9_]+$/.test(error.code) ? { code: error.code } : {}),
        ...(typeof error.status === 'number' ? { status: error.status } : {}) });
    }
  }
  return { eventCounts, completedReason, toolExecutions, readCalls, finalAnswerMatchesProof: text.trim() === options.proof, modelErrorCount, modelErrors, failedToolResults };
}
