import { ImapFlow, type FetchMessageObject, type ImapFlowOptions, type SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { isSingleMailAddress } from "./mailPolicy.js";

export type MailAccount = "qq" | "163";

export interface ListMailInput {
  account: MailAccount;
  folder?: string;
  limit?: number;
}

export interface ReadMailInput {
  account: MailAccount;
  messageId: string;
  folder?: string;
}

export interface SearchMailInput {
  account: MailAccount;
  folder?: string;
  limit?: number;
  subject?: string;
  from?: string;
  text?: string;
  since?: string;
  before?: string;
}

export interface DeleteMailInput {
  account: MailAccount;
  messageId: string;
}

export interface WriteMailInput {
  account: MailAccount;
  to: string[];
  cc?: string[];
  subject?: string;
  body: string;
}

export interface MailSummary {
  messageId: string;
  subject: string;
  from: string[];
  date: string | null;
  size: number | null;
  seen: boolean;
}

export interface ListMailResult {
  account: MailAccount;
  folder: string;
  total: number;
  messages: MailSummary[];
}

export interface SearchMailResult {
  account: MailAccount;
  folder: string;
  /** Search is limited to the newest 2,000 messages in this folder. */
  searchedRecentMessages: number;
  totalMatchesInWindow: number;
  messages: MailSummary[];
}

export interface DeleteMailResult {
  status: "moved_to_trash";
  /** A target UID mapping permits independent verification inside Trash. */
  verification: "trash_uid_verified" | "server_move_and_source_absent";
  account: MailAccount;
  sourceFolder: string;
  trashFolder: string;
  sourceMessageId: string;
  trashMessageId: string | null;
}

export interface ReadMailResult extends MailSummary {
  account: MailAccount;
  folder: string;
  to: string[];
  cc: string[];
  body: string;
  bodyTruncated: boolean;
  attachments: Array<{ filename: string; contentType: string; size: number }>;
}

export interface SaveDraftResult {
  status: "saved";
  account: MailAccount;
  folder: string;
  messageId: string | null;
  recipientCount: number;
}

export interface SendMailResult {
  status: "sent";
  account: MailAccount;
  messageId: string;
  accepted: string[];
  rejected: string[];
  pending: string[];
}

export class MailBackendError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "MailBackendError";
  }
}

const ACCOUNTS = {
  qq: {
    domain: "qq.com",
    imapHost: "imap.qq.com",
    smtpHost: "smtp.qq.com",
    addressEnv: "CCAGENT_QQ_MAIL_ADDRESS",
    authCodeEnv: "CCAGENT_QQ_MAIL_AUTH_CODE",
  },
  "163": {
    domain: "163.com",
    imapHost: "imap.163.com",
    smtpHost: "smtp.163.com",
    addressEnv: "CCAGENT_163_MAIL_ADDRESS",
    authCodeEnv: "CCAGENT_163_MAIL_AUTH_CODE",
  },
} as const;

const MAX_RECIPIENTS = 10;
const MAX_SUBJECT = 200;
const MAX_BODY = 20_000;
const MAX_LIST = 50;
const MAX_SEARCH_WINDOW = 2_000;
const MAX_SEARCH_TERM = 200;
const MAX_MESSAGE_BYTES = 1_000_000;
const MAX_BODY_RETURN = 20_000;
const OPERATION_TIMEOUT_MS = 30_000;

type ImapClient = Pick<
  ImapFlow,
  "on" | "connect" | "close" | "mailbox" | "capabilities" | "enabled" | "getMailboxLock" | "fetchAll" | "fetchOne" | "list" | "append" | "search" | "messageMove"
>;
type SmtpTransport = Pick<ReturnType<typeof nodemailer.createTransport>, "sendMail" | "close">;

export interface MailBackendDependencies {
  getEnv?: (name: string) => string | undefined;
  createImapClient?: (options: ImapFlowOptions) => ImapClient;
  createSmtpTransport?: (options: Parameters<typeof nodemailer.createTransport>[0]) => SmtpTransport;
}

function requireAccount(value: unknown): MailAccount {
  if (value === "qq" || value === "163") return value;
  throw new MailBackendError("MAIL_INVALID_ACCOUNT", "Only personal QQ and 163 mail accounts are supported.");
}

function cleanAddress(value: unknown): string {
  if (!isSingleMailAddress(value)) {
    throw new MailBackendError("MAIL_INVALID_ADDRESS", "A recipient address is invalid.");
  }
  return value;
}

function cleanRecipients(input: WriteMailInput): { to: string[]; cc: string[]; subject: string; body: string } {
  if (!Array.isArray(input.to) || !Array.isArray(input.cc ?? [])) {
    throw new MailBackendError("MAIL_INVALID_RECIPIENTS", "Recipients must be address lists.");
  }
  const to = input.to.map(cleanAddress);
  const cc = (input.cc ?? []).map(cleanAddress);
  if (to.length === 0 || to.length + cc.length > MAX_RECIPIENTS) {
    throw new MailBackendError("MAIL_INVALID_RECIPIENTS", "Specify 1 to 10 total recipients, including at least one To address.");
  }
  if (new Set([...to, ...cc].map((address) => address.toLowerCase())).size !== to.length + cc.length) {
    throw new MailBackendError("MAIL_INVALID_RECIPIENTS", "Recipient addresses must not repeat.");
  }
  const subject = input.subject ?? "";
  if (typeof subject !== "string" || subject.length > MAX_SUBJECT || /[\r\n\x00-\x1f\x7f]/.test(subject)) {
    throw new MailBackendError("MAIL_INVALID_SUBJECT", "Subject must be at most 200 characters on one line.");
  }
  if (typeof input.body !== "string" || input.body.length < 1 || input.body.length > MAX_BODY) {
    throw new MailBackendError("MAIL_INVALID_BODY", "Body must be 1 to 20000 characters.");
  }
  return { to, cc, subject, body: input.body };
}

function cleanFolder(value: unknown): string {
  if (value === undefined) return "INBOX";
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new MailBackendError("MAIL_INVALID_FOLDER", "Folder name is invalid.");
  }
  return value;
}

function cleanLimit(value: unknown): number {
  if (value === undefined) return 10;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1 || value > MAX_LIST) {
    throw new MailBackendError("MAIL_INVALID_LIMIT", "Limit must be an integer from 1 to 50.");
  }
  return value;
}

function parseMessageId(value: unknown): { uidValidity: string; uid: number } {
  if (typeof value !== "string") {
    throw new MailBackendError("MAIL_INVALID_MESSAGE_ID", "Use the messageId returned by Mail.list.");
  }
  const match = /^(\d{1,20}):(\d{1,10})$/.exec(value);
  const uid = match ? Number(match[2]) : NaN;
  if (!match || !Number.isSafeInteger(uid) || uid < 1) {
    throw new MailBackendError("MAIL_INVALID_MESSAGE_ID", "Use the messageId returned by Mail.list.");
  }
  return { uidValidity: match[1], uid };
}

function boundMessageId(account: MailAccount, folder: string, uidValidity: bigint | string, uid: number): string {
  return `m1:${account}:${Buffer.from(folder, "utf8").toString("base64url")}:${uidValidity.toString()}:${uid}`;
}

export function parseBoundMailMessageId(value: unknown): { account: MailAccount; folder: string; uidValidity: string; uid: number } {
  if (typeof value !== "string") {
    throw new MailBackendError("MAIL_INVALID_MESSAGE_ID", "Use a folder-bound messageId returned by Mail.list or Mail.search.");
  }
  const match = /^m1:(qq|163):([A-Za-z0-9_-]{1,684}):(\d{1,20}):(\d{1,10})$/.exec(value);
  const uid = match ? Number(match[4]) : NaN;
  if (!match || !Number.isSafeInteger(uid) || uid < 1 || uid > 0xffffffff) {
    throw new MailBackendError("MAIL_INVALID_MESSAGE_ID", "Use a folder-bound messageId returned by Mail.list or Mail.search.");
  }
  const folder = Buffer.from(match[2], "base64url").toString("utf8");
  if (Buffer.from(folder, "utf8").toString("base64url") !== match[2]) {
    throw new MailBackendError("MAIL_INVALID_MESSAGE_ID", "The folder-bound messageId is malformed.");
  }
  cleanFolder(folder);
  return { account: match[1] as MailAccount, folder, uidValidity: match[3], uid };
}

function parseReadMessageId(account: MailAccount, value: unknown, folderInput: unknown): { folder: string; uidValidity: string; uid: number } {
  if (typeof value === "string" && value.startsWith("m1:")) {
    const requested = parseBoundMailMessageId(value);
    if (requested.account !== account) {
      throw new MailBackendError("MAIL_MESSAGE_ACCOUNT_MISMATCH", "The messageId belongs to another mail account.");
    }
    if (folderInput !== undefined && cleanFolder(folderInput) !== requested.folder) {
      throw new MailBackendError("MAIL_MESSAGE_FOLDER_MISMATCH", "The folder does not match the messageId.");
    }
    return requested;
  }
  return { folder: cleanFolder(folderInput), ...parseMessageId(value) };
}

function cleanSearchTerm(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length < 1 || value.length > MAX_SEARCH_TERM || /[\x00-\x1f\x7f]/.test(value)) {
    throw new MailBackendError("MAIL_INVALID_SEARCH", `${name} must be 1 to 200 characters without control characters.`);
  }
  return value;
}

function cleanSearchDate(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new MailBackendError("MAIL_INVALID_SEARCH", `${name} must be a YYYY-MM-DD date.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new MailBackendError("MAIL_INVALID_SEARCH", `${name} must be a real YYYY-MM-DD date.`);
  }
  return value;
}

function searchCriteria(input: SearchMailInput): SearchObject {
  const subject = cleanSearchTerm(input.subject, "subject");
  const from = cleanSearchTerm(input.from, "from");
  const text = cleanSearchTerm(input.text, "text");
  const since = cleanSearchDate(input.since, "since");
  const before = cleanSearchDate(input.before, "before");
  if (!subject && !from && !text && !since && !before) {
    throw new MailBackendError("MAIL_INVALID_SEARCH", "Specify at least one search criterion.");
  }
  if (since && before && since >= before) {
    throw new MailBackendError("MAIL_INVALID_SEARCH", "since must be earlier than before.");
  }
  return { ...(subject ? { subject } : {}), ...(from ? { from } : {}), ...(text ? { text } : {}), ...(since ? { since } : {}), ...(before ? { before } : {}) };
}

function summarizeMessage(row: FetchMessageObject, account: MailAccount, folder: string, uidValidity: bigint): MailSummary {
  return {
    messageId: boundMessageId(account, folder, uidValidity, row.uid),
    subject: (row.envelope?.subject ?? "").slice(0, 500),
    from: (row.envelope?.from ?? []).slice(0, 10).map(formatAddress),
    date: safeDate(row.internalDate ?? row.envelope?.date),
    size: row.size ?? null,
    seen: row.flags?.has("\\Seen") ?? false,
  };
}

function safeDate(value: Date | string | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatAddress(value: { name?: string; address?: string }): string {
  const address = value.address ?? "";
  const name = value.name ?? "";
  return (name ? `${name} <${address}>` : address).slice(0, 500);
}

function mailError(error: unknown, action: string): MailBackendError {
  if (error instanceof MailBackendError) return error;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const uncertain = action === "Mail.send" ? " Delivery may be uncertain; check Sent mail before retrying."
    : action === "Mail.draft" ? " Draft status may be uncertain; check Drafts before retrying."
      : action === "Mail.delete" ? " Move status may be uncertain; check the source folder and Trash before retrying." : "";
  if (code === "EAUTH" || code === "AUTHENTICATIONFAILED") {
    return new MailBackendError("MAIL_AUTH_FAILED", `${action} failed: check the account authorization code and IMAP/SMTP settings.`);
  }
  if (code === "ETIMEDOUT" || code === "CONNECT_TIMEOUT") {
    return new MailBackendError("MAIL_TIMEOUT", `${action} timed out.${uncertain}`);
  }
  return new MailBackendError("MAIL_PROVIDER_ERROR", `${action} failed; check account settings and provider availability.${uncertain}`);
}

export function createMailBackend(dependencies: MailBackendDependencies = {}) {
  const getEnv = dependencies.getEnv ?? ((name: string) => process.env[name]);
  const createImapClient = dependencies.createImapClient ?? ((options: ImapFlowOptions) => new ImapFlow(options));
  const createSmtpTransport = dependencies.createSmtpTransport ?? ((options: Parameters<typeof nodemailer.createTransport>[0]) => nodemailer.createTransport(options));

  function credentials(account: MailAccount): { address: string; authCode: string; config: (typeof ACCOUNTS)[MailAccount] } {
    const config = ACCOUNTS[account];
    const address = getEnv(config.addressEnv) ?? "";
    const authCode = getEnv(config.authCodeEnv)?.trim() ?? "";
    if (!address || !authCode) {
      throw new MailBackendError("MAIL_NOT_CONFIGURED", `Set ${config.addressEnv} and ${config.authCodeEnv} in the environment.`);
    }
    if (!isSingleMailAddress(address) || address.toLowerCase().split("@")[1] !== config.domain) {
      throw new MailBackendError("MAIL_INVALID_ACCOUNT_ADDRESS", `${config.addressEnv} must be a personal @${config.domain} address.`);
    }
    return { address, authCode, config };
  }

  async function withImap<T>(account: MailAccount, action: string, run: (client: ImapClient) => Promise<T>): Promise<T> {
    const { address, authCode, config } = credentials(account);
    let client: ImapClient;
    try {
      client = createImapClient({
        host: config.imapHost,
        port: 993,
        secure: true,
        auth: { user: address, pass: authCode },
        logger: false,
        disableAutoIdle: true,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
        maxLiteralSize: MAX_MESSAGE_BYTES + 65_536,
        maxResponseSize: 5_000_000,
        tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
      });
    } catch (error) {
      throw mailError(error, action);
    }
    client.on("error", () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => { await client.connect(); return run(client); })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            client.close();
            reject(new MailBackendError("MAIL_TIMEOUT", action === "Mail.draft"
              ? "Mail.draft timed out; draft status may be uncertain. Check Drafts before retrying."
              : action === "Mail.delete"
                ? "Mail.delete timed out; move status may be uncertain. Check the source folder and Trash before retrying."
                : `${action} timed out; no mail was changed.`));
          }, OPERATION_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      throw mailError(error, action);
    } finally {
      if (timer) clearTimeout(timer);
      client.close();
    }
  }

  async function listMail(input: ListMailInput): Promise<ListMailResult> {
    const account = requireAccount(input.account);
    const folder = cleanFolder(input.folder);
    const limit = cleanLimit(input.limit);
    return withImap(account, "Mail.list", async (client) => {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const mailbox = client.mailbox;
        if (!mailbox) throw new MailBackendError("MAIL_FOLDER_UNAVAILABLE", "Selected folder is unavailable.");
        const total = mailbox.exists;
        if (total === 0) return { account, folder: lock.path, total, messages: [] };
        const start = Math.max(1, total - limit + 1);
        const rows = await client.fetchAll(`${start}:${total}`, { envelope: true, flags: true, internalDate: true, size: true });
        const messages = rows.sort((a, b) => b.seq - a.seq).slice(0, limit).map((row) => summarizeMessage(row, account, lock.path, mailbox.uidValidity));
        return { account, folder: lock.path, total, messages };
      } finally {
        lock.release();
      }
    });
  }

  async function searchMail(input: SearchMailInput): Promise<SearchMailResult> {
    const account = requireAccount(input.account);
    const folder = cleanFolder(input.folder);
    const limit = cleanLimit(input.limit);
    const criteria = searchCriteria(input);
    return withImap(account, "Mail.search", async (client) => {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const mailbox = client.mailbox;
        if (!mailbox) throw new MailBackendError("MAIL_FOLDER_UNAVAILABLE", "Selected folder is unavailable.");
        const scanned = Math.min(mailbox.exists, MAX_SEARCH_WINDOW);
        if (scanned === 0) return { account, folder: lock.path, searchedRecentMessages: 0, totalMatchesInWindow: 0, messages: [] };
        const start = Math.max(1, mailbox.exists - MAX_SEARCH_WINDOW + 1);
        const found = await client.search({ ...criteria, seq: `${start}:${mailbox.exists}` }, { uid: true });
        if (!Array.isArray(found)) throw new MailBackendError("MAIL_SEARCH_FAILED", "The server did not return search results.");
        const uids = [...new Set(found.filter((value) => Number.isSafeInteger(value) && value > 0))].sort((a, b) => b - a);
        const selected = uids.slice(0, limit);
        if (selected.length === 0) return { account, folder: lock.path, searchedRecentMessages: scanned, totalMatchesInWindow: uids.length, messages: [] };
        const rows = await client.fetchAll(selected, { envelope: true, flags: true, internalDate: true, size: true }, { uid: true });
        const messages = rows.sort((a, b) => b.uid - a.uid).slice(0, limit).map((row) => summarizeMessage(row, account, lock.path, mailbox.uidValidity));
        return { account, folder: lock.path, searchedRecentMessages: scanned, totalMatchesInWindow: uids.length, messages };
      } finally {
        lock.release();
      }
    });
  }

  async function deleteMail(input: DeleteMailInput): Promise<DeleteMailResult> {
    const account = requireAccount(input.account);
    const requested = parseBoundMailMessageId(input.messageId);
    if (requested.account !== account) {
      throw new MailBackendError("MAIL_MESSAGE_ACCOUNT_MISMATCH", "The messageId belongs to another mail account; no mail was changed.");
    }
    const folder = requested.folder;
    return withImap(account, "Mail.delete", async (client) => {
      // ImapFlow otherwise emulates MOVE with COPY + messageDelete/EXPUNGE.
      // Require native MOVE so this operation never falls back to a broad EXPUNGE.
      const nativeMove = client.capabilities.has("MOVE") || client.enabled.has("IMAP4REV2")
        || (client.capabilities.has("IMAP4rev2") && !client.capabilities.has("IMAP4rev1"));
      if (!nativeMove) throw new MailBackendError("MAIL_MOVE_UNSUPPORTED", "The server does not support native MOVE; no mail was changed.");
      const folders = await client.list();
      const selectable = folders.filter((item) => !item.flags?.has("\\Noselect"));
      const special = selectable.filter((item) => item.specialUse === "\\Trash");
      const fallback = selectable.filter((item) => ["trash", "deleted messages", "deleted items", "已删除", "已删除邮件", "回收站"].includes(item.name.toLowerCase()));
      const matches = special.length > 0 ? special : fallback;
      const unique = [...new Map(matches.map((item) => [item.path.toLowerCase(), item])).values()];
      if (unique.length !== 1) {
        throw new MailBackendError("MAIL_TRASH_UNAVAILABLE", unique.length > 1
          ? "Multiple Trash folders matched; no mail was moved."
          : "No selectable Trash folder was found; no mail was moved.");
      }
      const trash = unique[0];
      const lock = await client.getMailboxLock(folder);
      let targetUid: number | undefined;
      let targetUidValidity: bigint | undefined;
      let sourceFolder: string;
      try {
        const mailbox = client.mailbox;
        if (!mailbox) throw new MailBackendError("MAIL_FOLDER_UNAVAILABLE", "Selected folder is unavailable.");
        if (lock.path.toLowerCase() === trash.path.toLowerCase()) {
          throw new MailBackendError("MAIL_ALREADY_IN_TRASH", "This message is already in Trash; no mail was changed.");
        }
        if (mailbox.uidValidity.toString() !== requested.uidValidity) {
          throw new MailBackendError("MAIL_STALE_MESSAGE_ID", "Folder identity changed; list messages again.");
        }
        const current = await client.fetchOne(requested.uid, { uid: true }, { uid: true });
        if (!current) throw new MailBackendError("MAIL_NOT_FOUND", "Message was not found; list messages again.");
        const moved = await client.messageMove(String(requested.uid), trash.path, { uid: true });
        if (!moved) throw new MailBackendError("MAIL_MOVE_UNCERTAIN", "The server did not confirm the move; check the source folder and Trash before retrying.");
        const remaining = await client.fetchOne(requested.uid, { uid: true }, { uid: true });
        if (remaining) throw new MailBackendError("MAIL_MOVE_UNCERTAIN", "The message still appears in the source folder; check both folders before retrying.");
        targetUid = moved.uidMap?.get(requested.uid);
        targetUidValidity = moved.uidValidity;
        sourceFolder = lock.path;
      } finally {
        lock.release();
      }
      if (targetUid === undefined) {
        return {
          status: "moved_to_trash", verification: "server_move_and_source_absent", account,
          sourceFolder, trashFolder: trash.path, sourceMessageId: input.messageId, trashMessageId: null,
        };
      }
      if (!Number.isSafeInteger(targetUid) || targetUid < 1 || targetUid > 0xffffffff) {
        throw new MailBackendError("MAIL_MOVE_UNCERTAIN", "The server returned an invalid Trash UID; check both folders before retrying.");
      }
      const trashLock = await client.getMailboxLock(trash.path, { readOnly: true });
      try {
        const trashMailbox = client.mailbox;
        if (!trashMailbox || (targetUidValidity !== undefined && trashMailbox.uidValidity !== targetUidValidity)) {
          throw new MailBackendError("MAIL_MOVE_UNCERTAIN", "Trash identity changed after the move; check both folders before retrying.");
        }
        const target = await client.fetchOne(targetUid, { uid: true }, { uid: true });
        if (!target) {
          throw new MailBackendError("MAIL_MOVE_UNCERTAIN", "The moved message was not found in Trash; check both folders before retrying.");
        }
        return {
          status: "moved_to_trash", verification: "trash_uid_verified", account,
          sourceFolder, trashFolder: trashLock.path, sourceMessageId: input.messageId,
          trashMessageId: boundMessageId(account, trashLock.path, trashMailbox.uidValidity, targetUid),
        };
      } finally {
        trashLock.release();
      }
    });
  }

  async function readMail(input: ReadMailInput): Promise<ReadMailResult> {
    const account = requireAccount(input.account);
    const requested = parseReadMessageId(account, input.messageId, input.folder);
    const folder = requested.folder;
    return withImap(account, "Mail.read", async (client) => {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const mailbox = client.mailbox;
        if (!mailbox) throw new MailBackendError("MAIL_FOLDER_UNAVAILABLE", "Selected folder is unavailable.");
        if (mailbox.uidValidity.toString() !== requested.uidValidity) {
          throw new MailBackendError("MAIL_STALE_MESSAGE_ID", "Folder identity changed; list messages again.");
        }
        const metadata = await client.fetchOne(requested.uid, { size: true }, { uid: true });
        if (!metadata) throw new MailBackendError("MAIL_NOT_FOUND", "Message was not found; list messages again.");
        if (metadata.size !== undefined && metadata.size > MAX_MESSAGE_BYTES) {
          throw new MailBackendError("MAIL_MESSAGE_TOO_LARGE", "Message exceeds the 1 MB read limit.");
        }
        const row = await client.fetchOne(requested.uid, { source: true, envelope: true, flags: true, internalDate: true, size: true }, { uid: true });
        if (!row || !row.source) throw new MailBackendError("MAIL_NOT_FOUND", "Message was not found; list messages again.");
        if (row.source.length > MAX_MESSAGE_BYTES) throw new MailBackendError("MAIL_MESSAGE_TOO_LARGE", "Message exceeds the 1 MB read limit.");
        const parsed = await simpleParser(row.source, { skipImageLinks: true, skipTextToHtml: true, maxHtmlLengthToParse: MAX_BODY_RETURN });
        const body = parsed.text ?? "";
        return {
          account,
          folder: lock.path,
          messageId: input.messageId,
          subject: (parsed.subject ?? row.envelope?.subject ?? "").slice(0, 500),
          from: (row.envelope?.from ?? []).slice(0, 10).map(formatAddress),
          to: (row.envelope?.to ?? []).slice(0, 10).map(formatAddress),
          cc: (row.envelope?.cc ?? []).slice(0, 10).map(formatAddress),
          date: safeDate(row.internalDate ?? parsed.date),
          size: row.size ?? row.source.length,
          seen: row.flags?.has("\\Seen") ?? false,
          body: body.slice(0, MAX_BODY_RETURN),
          bodyTruncated: body.length > MAX_BODY_RETURN,
          attachments: parsed.attachments.slice(0, 20).map((attachment) => ({
            filename: (attachment.filename ?? "").slice(0, 255),
            contentType: (attachment.contentType ?? "application/octet-stream").slice(0, 100),
            size: attachment.size,
          })),
        };
      } finally {
        lock.release();
      }
    });
  }

  async function saveDraft(input: WriteMailInput): Promise<SaveDraftResult> {
    const account = requireAccount(input.account);
    const content = cleanRecipients(input);
    return withImap(account, "Mail.draft", async (client) => {
      const folders = await client.list();
      const selectable = folders.filter((folder) => !folder.flags?.has("\\Noselect"));
      const special = selectable.filter((folder) => folder.specialUse === "\\Drafts");
      const fallback = selectable.filter((folder) => ["Drafts", "Draft", "草稿箱"].includes(folder.name));
      const matches = special.length > 0 ? special : fallback;
      if (matches.length !== 1) {
        throw new MailBackendError(
          "MAIL_DRAFTS_UNAVAILABLE",
          matches.length > 1 ? "Multiple Drafts folders matched; no draft was saved." : "The provider did not expose a selectable Drafts folder; no draft was saved.",
        );
      }
      const drafts = matches[0];
      const { address } = credentials(account);
      const raw = await new MailComposer({ from: address, to: content.to, cc: content.cc, subject: content.subject, text: content.body }).compile().build();
      const result = await client.append(drafts.path, raw, ["\\Draft"]);
      if (!result) throw new MailBackendError("MAIL_DRAFT_SAVE_FAILED", "The provider did not confirm the draft save; check Drafts before retrying.");
      return {
        status: "saved",
        account,
        folder: drafts.path,
        messageId: result.uidValidity !== undefined && result.uid !== undefined ? boundMessageId(account, drafts.path, result.uidValidity, result.uid) : null,
        recipientCount: content.to.length + content.cc.length,
      };
    });
  }

  async function sendMail(input: WriteMailInput): Promise<SendMailResult> {
    const account = requireAccount(input.account);
    const content = cleanRecipients(input);
    const { address, authCode, config } = credentials(account);
    let transport: SmtpTransport;
    try {
      transport = createSmtpTransport({
        host: config.smtpHost,
        port: 465,
        secure: true,
        auth: { user: address, pass: authCode },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
        tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
      });
    } catch (error) {
      throw mailError(error, "Mail.send");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const info = await Promise.race([
        transport.sendMail({ from: address, to: content.to, cc: content.cc, subject: content.subject, text: content.body }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            transport.close();
            reject(new MailBackendError("MAIL_TIMEOUT", "Mail.send timed out; delivery status is uncertain. Check Sent mail before retrying."));
          }, OPERATION_TIMEOUT_MS);
        }),
      ]);
      const intended = new Set([...content.to, ...content.cc].map((item) => item.toLowerCase()));
      const safeRecipients = (values: unknown): string[] => Array.isArray(values)
        ? values.map((value) => typeof value === "string" ? value : value && typeof value === "object" && "address" in value ? value.address : undefined)
            .filter((value): value is string => typeof value === "string" && intended.has(value.toLowerCase()))
        : [];
      const accepted = safeRecipients(info.accepted);
      const rejected = safeRecipients(info.rejected);
      const pending = safeRecipients(info.pending);
      if (rejected.length > 0 || pending.length > 0 || new Set(accepted.map((value) => value.toLowerCase())).size !== intended.size) {
        throw new MailBackendError("MAIL_PARTIAL_DELIVERY", "SMTP did not confirm every recipient. Some recipients may already have received the message; check delivery before another send.");
      }
      return {
        status: "sent",
        account,
        messageId: typeof info.messageId === "string" ? info.messageId.slice(0, 255) : "",
        accepted,
        rejected,
        pending,
      };
    } catch (error) {
      throw mailError(error, "Mail.send");
    } finally {
      if (timer) clearTimeout(timer);
      transport.close();
    }
  }

  return { listMail, readMail, searchMail, deleteMail, saveDraft, sendMail };
}

const mailBackend = createMailBackend();
export const listMail = mailBackend.listMail;
export const readMail = mailBackend.readMail;
export const searchMail = mailBackend.searchMail;
export const deleteMail = mailBackend.deleteMail;
export const saveDraft = mailBackend.saveDraft;
export const sendMail = mailBackend.sendMail;
