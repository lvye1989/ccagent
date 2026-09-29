import { createHash } from "node:crypto";

const EMAIL_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
// A no-prompt send needs a direct imperative at the start of the human turn.
// A send instruction found later in quoted mail or an analysis request is data.
// Less common but legitimate phrasing falls back to a foreground confirmation.
const DIRECT_SEND_INTENT = /^(?:(?:请帮我|请你|麻烦你|麻烦|帮我|请|现在|立即|直接|我要|我想|please|could you|would you)\s*){0,3}(?:(?:从|用|通过|以)\s*(?:我的)?\s*(?:QQ|腾讯|163)\s*邮箱\s*)?(?:发(?:送)?(?:一封)?(?:电?子)?邮件|寄(?:出)?(?:电?子)?邮件|send\s+(?:an?\s+)?(?:email|mail)\b)/i;
const NEGATED_SEND = /(?:不要|不用|别|勿|禁止|不准|暂不|先不)\s*(?:发|发送|寄|send|email)|\b(?:do\s+not|don't|never)\s+(?:send|email)\b/i;
const NON_SEND_CONTEXT = /(?:不要|不用|别|勿|禁止|不准|暂不|先不).{0,16}(?:执行|照做|发送|发信)|(?:仅|只)(?:供|需|要)?(?:阅读|查看|总结|分析|翻译|解释|引用)|(?:引用|引述|原文|转述|示例|例子)(?:的|中|内容|邮件|文字)?|\b(?:quoted?|summari[sz]e|analy[sz]e|translate|do\s+not\s+follow|don't\s+follow|for\s+analysis)\b/i;
const ATTEMPT_RETENTION_MS = 10 * 60_000;
const attemptedSends = new Map<string, number>();

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** A single unquoted address; separators cannot add hidden recipients. */
export function isSingleMailAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 254 || !EMAIL_ADDRESS.test(value)) return false;
  const local = value.slice(0, value.indexOf("@"));
  return local.length <= 64 && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..");
}

function includesExactAddress(text: string, address: string): boolean {
  const lower = text.toLowerCase();
  const needle = address.toLowerCase();
  let at = lower.indexOf(needle);
  while (at >= 0) {
    const before = at > 0 ? lower[at - 1] : "";
    const after = lower[at + needle.length] ?? "";
    if (!/[a-z0-9._%+-]/.test(before ?? "") && !/[a-z0-9.-]/.test(after)) return true;
    at = lower.indexOf(needle, at + 1);
  }
  return false;
}

function namesSenderAccount(request: string, account: "qq" | "163"): boolean {
  const configured = (["qq", "163"] as const).filter((candidate) => {
    const prefix = candidate === "qq" ? "CCAGENT_QQ_MAIL" : "CCAGENT_163_MAIL";
    return Boolean(process.env[`${prefix}_ADDRESS`]?.trim() && process.env[`${prefix}_AUTH_CODE`]?.trim());
  });
  if (configured.length <= 1) return true;

  const prefix = account === "qq" ? "CCAGENT_QQ_MAIL" : "CCAGENT_163_MAIL";
  const configuredAddress = process.env[`${prefix}_ADDRESS`]?.trim();
  if (configuredAddress && includesExactAddress(request, configuredAddress)) {
    const escaped = configuredAddress.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:从|用|通过|以|发件人(?:为|是|：|:))\\s*(?:我的)?\\s*${escaped}`, "i").test(request)) return true;
  }
  const senderPhrase = account === "qq"
    ? /(?:从|用|通过|以)\s*(?:我的)?\s*(?:QQ|腾讯)\s*邮箱/i
    : /(?:从|用|通过|以)\s*(?:我的)?\s*163\s*邮箱/i;
  return senderPhrase.test(request);
}

/** Only a runtime copy of the current human turn may grant a no-prompt send. */
export function hasDirectMailSendGrant(
  directUserTurnText: string | undefined,
  input: Record<string, unknown>,
): boolean {
  if (typeof directUserTurnText !== "string" || directUserTurnText.length === 0) return false;
  if (input.operation !== "send" || (input.account !== "qq" && input.account !== "163")) return false;
  if (!Array.isArray(input.to) || input.to.length === 0 || !input.to.every(isSingleMailAddress)) return false;
  if (input.cc !== undefined && (!Array.isArray(input.cc) || !input.cc.every(isSingleMailAddress))) return false;
  if (input.subject !== undefined && typeof input.subject !== "string") return false;
  if (typeof input.body !== "string") return false;
  const body = normalizeText(input.body);
  if (body.length === 0) return false;

  const request = normalizeText(directUserTurnText);
  if (!request.includes(body)) return false;
  // Quoted message text is data. Only the user's surrounding instruction can
  // authorize the action, recipients, subject, and sender account.
  const instruction = request.replaceAll(body, " ");
  if (!DIRECT_SEND_INTENT.test(instruction) || NEGATED_SEND.test(instruction) || NON_SEND_CONTEXT.test(instruction)) return false;
  if (!namesSenderAccount(instruction, input.account)) return false;
  if (![...input.to, ...(input.cc ?? [])].every((address) => includesExactAddress(instruction, address))) return false;
  const subject = normalizeText((input.subject as string | undefined) ?? "");
  if (subject && !instruction.includes(subject)) return false;
  return true;
}

/** Reserve before SMTP dispatch, including calls whose result may be uncertain. */
export function reserveMailSendAttempt(
  sessionId: string | undefined,
  messageId: string | undefined,
  input: Record<string, unknown>,
  now = Date.now(),
): boolean {
  for (const [key, timestamp] of attemptedSends) {
    if (now - timestamp > ATTEMPT_RETENTION_MS) attemptedSends.delete(key);
  }
  const payload = JSON.stringify({
    sessionId: sessionId ?? "",
    messageId: messageId ?? "",
    account: input.account,
    to: input.to,
    cc: input.cc ?? [],
    subject: input.subject,
    body: input.body,
  });
  const key = createHash("sha256").update(payload).digest("hex");
  if (attemptedSends.has(key)) return false;
  attemptedSends.set(key, now);
  return true;
}
