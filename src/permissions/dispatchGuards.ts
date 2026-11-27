import type { ToolContext } from "../tools/Tool.js";
import { reserveMailSendAttempt } from "../tools/mailPolicy.js";
import { isMailPowerEnabled, mailPowerForOperation } from "../config/mailPowerSettings.js";

type DispatchGuard = (input: Record<string, unknown>, context: ToolContext) => Promise<string | undefined>;

// Native integration rules run after the approval wait, immediately before dispatch.
const guards: ReadonlyMap<string, DispatchGuard> = new Map([["Mail", async (input, context) => {
  if (!(await isMailPowerEnabled(input.account, input.operation))) {
    const account = typeof input.account === "string" ? input.account : "unknown";
    const power = mailPowerForOperation(input.operation) ?? "unknown";
    return `Mail ${account}.${power} is closed in /powersetting. Nothing was dispatched.`;
  }
  if (input.operation === "send" && !reserveMailSendAttempt(context.sessionId, context.messageId, input)) {
    return "Mail.send was already attempted for this user turn and identical payload. It was not sent again. Check the earlier receipt or mailbox before asking the user for a new send request.";
  }
}]]);

export function checkDispatchGuard(tool: string, input: Record<string, unknown>, context: ToolContext) {
  return guards.get(tool)?.(input, context);
}
