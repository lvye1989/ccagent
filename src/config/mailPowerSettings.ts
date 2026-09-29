/**
 * User-owned switches for the built-in QQ and 163 mail tool.
 *
 * This loader deliberately reads only ~/.ccagent/settings.json. Project,
 * local, flag, and plugin settings cannot turn on access to a mailbox.
 */
import { getUserSettingsPath } from "../utils/paths.js";
import { readJsonSettingsFile, updateUserSettings } from "../utils/settings.js";
import * as fs from "node:fs/promises";

export type MailAccount = "qq" | "163";
export type MailPower = "read" | "write" | "delete" | "search" | "send";
export type MailPowerSettings = Record<MailAccount, Record<MailPower, boolean>>;

export const MAIL_ACCOUNTS: readonly MailAccount[] = ["qq", "163"];
export const MAIL_POWERS: readonly MailPower[] = ["read", "write", "delete", "search", "send"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMailAccount(value: unknown): value is MailAccount {
  return value === "qq" || value === "163";
}

function isMailPower(value: unknown): value is MailPower {
  return value === "read" || value === "write" || value === "delete" ||
    value === "search" || value === "send";
}

function disabledPowers(): MailPowerSettings {
  return {
    qq: { read: false, write: false, delete: false, search: false, send: false },
    "163": { read: false, write: false, delete: false, search: false, send: false },
  };
}

function parsePowers(value: unknown): MailPowerSettings {
  const result = disabledPowers();
  if (!isRecord(value)) return result;
  for (const account of MAIL_ACCOUNTS) {
    const accountValue = value[account];
    if (!isRecord(accountValue)) continue;
    for (const power of MAIL_POWERS) {
      result[account][power] = accountValue[power] === true;
    }
  }
  return result;
}

/** Missing, unreadable, and malformed settings all fail closed. */
export async function loadMailPowerSettings(): Promise<MailPowerSettings> {
  const { raw, parseError } = await readJsonSettingsFile<Record<string, unknown>>(getUserSettingsPath());
  return parseError || !isRecord(raw) ? disabledPowers() : parsePowers(raw.mailPowers);
}

/** Map a Mail operation to its independent permission switch. */
export function mailPowerForOperation(operation: unknown): MailPower | null {
  switch (operation) {
    case "list":
    case "read":
      return "read";
    case "draft":
      return "write";
    case "delete":
      return "delete";
    case "search":
      return "search";
    case "send":
      return "send";
    default:
      return null;
  }
}

/** Permission gate helper; unknown inputs cannot gain mailbox access. */
export async function isMailPowerEnabled(account: unknown, operation: unknown): Promise<boolean> {
  const power = mailPowerForOperation(operation);
  if (!isMailAccount(account) || !power) return false;
  const settings = await loadMailPowerSettings();
  return settings[account][power];
}

// Serialize this module's writes so two rapid menu changes do not lose one
// another's account/power update. The next call still runs after a failure.
let writeTail: Promise<void> = Promise.resolve();

export function setMailPower(
  account: MailAccount,
  power: MailPower,
  enabled: boolean,
): Promise<MailPowerSettings> {
  if (!isMailAccount(account) || !isMailPower(power) || typeof enabled !== "boolean") {
    return Promise.reject(new Error("Invalid mail account, permission, or switch value."));
  }
  const action = async (): Promise<MailPowerSettings> => {
    const settingsPath = getUserSettingsPath();
    const { raw, parseError } = await readJsonSettingsFile<Record<string, unknown>>(settingsPath);
    if (parseError) throw new Error(`${parseError}; settings left unchanged.`);
    if (raw === null) {
      // The reader uses null for both an absent file and a literal JSON null.
      // Keep an existing malformed root untouched instead of silently fixing it.
      try {
        await fs.stat(settingsPath);
        throw new Error("User settings must be a JSON object; settings left unchanged.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (raw !== null && !isRecord(raw)) {
      throw new Error("User settings must be a JSON object; settings left unchanged.");
    }
    const previous = isRecord(raw?.mailPowers) ? raw.mailPowers : {};
    const accountPrevious = isRecord(previous[account]) ? previous[account] : {};
    const mailPowers = {
      ...previous,
      [account]: { ...accountPrevious, [power]: enabled },
    };
    await updateUserSettings({ mailPowers });
    return parsePowers(mailPowers);
  };
  const result = writeTail.then(action);
  writeTail = result.then(() => undefined, () => undefined);
  return result;
}
