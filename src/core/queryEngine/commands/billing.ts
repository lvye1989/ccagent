import { getPlatformGatewayClient, type PlatformCallReceipt } from "../../../platform/gatewayClient.js";
import { formatMicroYuan } from "../../../platform/money.js";
import { recordExecution } from "../../../session/execution.js";
import { findSessionBillingEvent, isSessionPersistenceEnabled } from "../../../session/storage.js";
import type { ToolContext } from "../../../tools/Tool.js";

/** Reconcile an owned platform receipt using a read-only account request. */
export async function reconcileSessionBilling(context: ToolContext, args: string[], lookup = async (logicalId: string, actualId: string) =>
  (await getPlatformGatewayClient()).reconcileReceipt(logicalId, actualId)): Promise<string> {
  if (args.length > 1 || (args.length && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(args[0]!))) {
    return "Usage: /billing [request UUID]";
  }
  if (!context.sessionId || context.temporaryChat || !context.recordExecutionEvent || !isSessionPersistenceEnabled()) {
    return "本会话未保存执行记录，无法按会话查询账单。";
  }
  const source = await findSessionBillingEvent(context.cwd, context.sessionId, args[0]?.toLowerCase());
  if (!source?.platformReceipt) return "本会话未找到匹配的官方服务调用记录。";
  const { logicalRequestId, actualRequestId } = source.platformReceipt;
  const receipt: PlatformCallReceipt = await lookup(logicalRequestId, actualRequestId);
  const { agentSessionId, turnId, requestId, step } = source;
  await recordExecution({ recordExecutionEvent: context.recordExecutionEvent, executionScope: { agentSessionId, turnId, requestId, step } },
    { phase: "billing_receipt", status: "reconciled", platformReceipt: receipt });
  const labels = { held: "已预授权", pending: "待核验", settled: "已结算", released: "已释放", unverified: "尚无权威回执" };
  const amount = receipt.authoritative && receipt.chargedMicro !== undefined
    ? " · 当前已扣 ¥" + formatMicroYuan(BigInt(receipt.chargedMicro)) : "";
  return [
    "平台账单 " + labels[receipt.status] + amount,
    "请求编号 " + logicalRequestId,
    ...(actualRequestId !== logicalRequestId ? ["原始幂等编号 " + actualRequestId] : []),
    ...(receipt.serverCallId ? ["平台调用编号 " + receipt.serverCallId] : []),
  ].join("\n");
}
