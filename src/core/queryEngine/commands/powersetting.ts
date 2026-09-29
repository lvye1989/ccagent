import {
  MAIL_ACCOUNTS,
  MAIL_POWERS,
  loadMailPowerSettings,
  setMailPower,
  type MailAccount,
  type MailPower,
  type MailPowerSettings,
} from "../../../config/mailPowerSettings.js";
import { getUserSettingsPath } from "../../../utils/paths.js";
import type { ToolContext } from "../../../tools/Tool.js";
import type { QueryEngineEvent } from "../types.js";

const usage = "/powersetting [list | qq|163 read|write|delete|search|send on|off]";
type Ask = NonNullable<ToolContext["requestUserQuestion"]>;

const accountLabels: Record<MailAccount, string> = { qq: "QQ 邮箱", "163": "163 邮箱" };
const powerLabels: Record<MailPower, string> = {
  read: "读信（列信、读信）",
  write: "写信（保存草稿）",
  delete: "删信",
  search: "查信",
  send: "发送邮件",
};
const powerShortLabels: Record<MailPower, string> = {
  read: "读", write: "写", delete: "删", search: "查", send: "发送",
};

function parseState(value: string | undefined): boolean | null {
  if (value === "on" || value === "open" || value === "开") return true;
  if (value === "off" || value === "close" || value === "关") return false;
  return null;
}

function formatSettings(settings: MailPowerSettings): string {
  const lines = ["邮箱权限（仅当前用户设置）"];
  for (const account of MAIL_ACCOUNTS) {
    lines.push(`${accountLabels[account]}:`);
    for (const power of MAIL_POWERS) {
      lines.push(`  ${power} ${settings[account][power] ? "On" : "Off"} — ${powerLabels[power]}`);
    }
  }
  lines.push("", usage, `保存位置：${getUserSettingsPath()}`);
  return lines.join("\n");
}

async function chooseAccount(ask: Ask): Promise<MailAccount | null> {
  const question = "选择要设置权限的邮箱（Esc 取消）：";
  const response = await ask({ questions: [{
    header: "邮箱",
    question,
    options: MAIL_ACCOUNTS.map((account) => ({
      label: accountLabels[account],
      description: account === "qq" ? "单独设置 QQ 邮箱权限" : "单独设置 163 邮箱权限",
    })),
  }] });
  const answer = response?.answers[question]?.trim().toLowerCase();
  return answer === "qq" || answer === "qq 邮箱" ? "qq"
    : answer === "163" || answer === "163 邮箱" ? "163" : null;
}

async function choosePower(ask: Ask, account: MailAccount, settings: MailPowerSettings): Promise<MailPower | null> {
  let page = 0;
  const pages: readonly (readonly MailPower[])[] = [["read", "write", "delete"], ["search", "send"]];
  for (;;) {
    const question = `${accountLabels[account]}：选择权限（${page + 1}/${pages.length}，Esc 取消）：`;
    const options = pages[page].map((power) => ({
      label: powerShortLabels[power],
      description: `${powerLabels[power]} (${power}) · 当前 ${settings[account][power] ? "On" : "Off"}`,
    }));
    options.push({ label: page === 0 ? "下一页" : "上一页", description: "查看其他权限" });
    const response = await ask({ questions: [{ header: "权限", question, options }] });
    const answer = response?.answers[question]?.trim().toLowerCase();
    if (answer === "下一页" || answer === "上一页") {
      page = page === 0 ? 1 : 0;
      continue;
    }
    return pages[page].find((power) => power === answer || powerShortLabels[power] === answer) ?? null;
  }
}

async function chooseState(ask: Ask, account: MailAccount, power: MailPower, enabled: boolean): Promise<boolean | null> {
  const question = `${accountLabels[account]} · ${powerLabels[power]} 当前为 ${enabled ? "On" : "Off"}，请选择：`;
  const response = await ask({ questions: [{
    header: "开关",
    question,
    options: [
      { label: "开", description: "On：开启该邮箱的这项权限" },
      { label: "关", description: "Off：关闭该邮箱的这项权限" },
    ],
  }] });
  const answer = response?.answers[question]?.trim().toLowerCase();
  return parseState(answer);
}

/** Deterministic user-facing mailbox permission switch; never invokes a model. */
export async function* handlePowerSettingCommand(
  args: string[],
  ask?: ToolContext["requestUserQuestion"],
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  const normalized = args.map((arg) => arg.toLowerCase());
  if ((normalized.length === 0 && !ask) || (normalized.length === 1 && normalized[0] === "list")) {
    yield { type: "command", kind: "info", message: formatSettings(await loadMailPowerSettings()) };
    return { handled: true };
  }

  let account: MailAccount;
  let power: MailPower;
  let enabled: boolean;
  if (normalized.length === 0 && ask) {
    const settings = await loadMailPowerSettings();
    const selectedAccount = await chooseAccount(ask);
    const selectedPower = selectedAccount ? await choosePower(ask, selectedAccount, settings) : null;
    const selectedState = selectedAccount && selectedPower
      ? await chooseState(ask, selectedAccount, selectedPower, settings[selectedAccount][selectedPower])
      : null;
    if (!selectedAccount || !selectedPower || selectedState === null) {
      yield { type: "command", kind: "info", message: "邮箱权限设置已取消；没有更改设置。" };
      return { handled: true };
    }
    account = selectedAccount;
    power = selectedPower;
    enabled = selectedState;
  } else if (
    normalized.length === 3 &&
    MAIL_ACCOUNTS.includes(normalized[0] as MailAccount) &&
    MAIL_POWERS.includes(normalized[1] as MailPower) &&
    parseState(normalized[2]) !== null
  ) {
    account = normalized[0] as MailAccount;
    power = normalized[1] as MailPower;
    enabled = parseState(normalized[2]) === true;
  } else {
    yield { type: "command", kind: "error", message: `用法：${usage}\n例如：/powersetting qq read on` };
    return { handled: true };
  }

  try {
    const updated = await setMailPower(account, power, enabled);
    yield {
      type: "command",
      kind: "info",
      message: `${accountLabels[account]} · ${powerLabels[power]}：${enabled ? "On" : "Off"}，立即生效。\n\n${formatSettings(updated)}`,
    };
  } catch (error) {
    yield {
      type: "command", kind: "error",
      message: `邮箱权限未更改：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { handled: true };
}
