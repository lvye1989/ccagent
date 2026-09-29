import assert from "node:assert/strict";
import { simpleParser } from "mailparser";
import { createMailBackend, MailBackendError, parseBoundMailMessageId, type MailBackendDependencies } from "../tools/mailBackend.js";
import { validateMailInput } from "../tools/mailTool.js";

const env: Record<string, string> = {
  CCAGENT_QQ_MAIL_ADDRESS: "model@qq.com",
  CCAGENT_QQ_MAIL_AUTH_CODE: "local-test-code",
  CCAGENT_163_MAIL_ADDRESS: "model@163.com",
  CCAGENT_163_MAIL_AUTH_CODE: "local-test-code",
};

type ImapClient = ReturnType<NonNullable<MailBackendDependencies["createImapClient"]>>;
type SmtpTransport = ReturnType<NonNullable<MailBackendDependencies["createSmtpTransport"]>>;

function fakeImap(overrides: Record<string, unknown> = {}): ImapClient {
  const client = {
    on() { return this; },
    async connect() {},
    close() {},
    mailbox: { uidValidity: 42n, exists: 2 },
    capabilities: new Map([["MOVE", true]]),
    enabled: new Set<string>(),
    async getMailboxLock(path: string) { return { path, release() {} }; },
    async fetchAll() { return []; },
    async fetchOne() { return false; },
    async search() { return []; },
    async messageMove() { return false; },
    async list() { return []; },
    async append() { return false; },
    ...overrides,
  };
  return client as unknown as ImapClient;
}

function backend(client: ImapClient, extra: MailBackendDependencies = {}) {
  return createMailBackend({
    getEnv: (name) => env[name],
    createImapClient: () => client,
    ...extra,
  });
}

async function rejectsCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof MailBackendError && error.code === code);
}

let checks = 0;
const qqInbox7 = "m1:qq:SU5CT1g:42:7";
const qqInbox7Stale = "m1:qq:SU5CT1g:41:7";
const mail163Inbox7 = "m1:163:SU5CT1g:42:7";

{
  let options: unknown;
  let lockReadOnly: unknown;
  const client = fakeImap({
    async getMailboxLock(path: string, opts: unknown) {
      assert.equal(path, "INBOX");
      lockReadOnly = opts;
      return { path, release() {} };
    },
    async fetchAll(range: string) {
      assert.equal(range, "1:2");
      return [
        { seq: 1, uid: 5, envelope: { subject: "Old", from: [{ address: "a@example.org" }] }, size: 100, flags: new Set(["\\Seen"]) },
        { seq: 2, uid: 7, envelope: { subject: "New", from: [{ address: "b@example.org" }] }, size: 200, flags: new Set() },
      ];
    },
  });
  const result = await backend(client, { createImapClient: (value) => { options = value; return client; } }).listMail({ account: "qq", limit: 2 });
  assert.deepEqual(result.messages.map((mail) => mail.messageId), [qqInbox7, "m1:qq:SU5CT1g:42:5"]);
  assert.equal(result.messages[0].seen, false);
  assert.equal(result.total, 2);
  assert.deepEqual(lockReadOnly, { readOnly: true });
  assert.equal((options as { host: string }).host, "imap.qq.com");
  assert.equal((options as { secure: boolean }).secure, true);
  assert.equal((options as { tls: { rejectUnauthorized: boolean } }).tls.rejectUnauthorized, true);
  checks += 7;
}

{
  const raw = Buffer.from("From: sender@example.org\r\nTo: model@qq.com\r\nSubject: A note\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello from test.");
  let fetches = 0;
  const client = fakeImap({
    async fetchOne(uid: number, query: { source?: boolean }, options: { uid?: boolean }) {
      assert.equal(uid, 7);
      assert.equal(options.uid, true);
      fetches++;
      return query.source
        ? { uid: 7, source: raw, size: raw.length, envelope: { from: [{ address: "sender@example.org" }] }, flags: new Set() }
        : { uid: 7, size: raw.length };
    },
  });
  const result = await backend(client).readMail({ account: "qq", messageId: "42:7" });
  assert.equal(result.body.trim(), "Hello from test.");
  assert.equal(result.messageId, "42:7");
  assert.equal(fetches, 2);
  await rejectsCode(backend(client).readMail({ account: "qq", messageId: "41:7" }), "MAIL_STALE_MESSAGE_ID");
  assert.equal(fetches, 2);
  const bound = await backend(client).readMail({ account: "qq", messageId: qqInbox7 });
  assert.equal(bound.messageId, qqInbox7);
  assert.equal(fetches, 4);
  await rejectsCode(backend(client).readMail({ account: "qq", messageId: qqInbox7, folder: "Other" }), "MAIL_MESSAGE_FOLDER_MISMATCH");
  await rejectsCode(backend(client).readMail({ account: "163", messageId: qqInbox7 }), "MAIL_MESSAGE_ACCOUNT_MISMATCH");
  checks += 9;
}

{
  let raw: Buffer | null = null;
  let flags: string[] | undefined;
  const client = fakeImap({
    async list() { return [{ path: "草稿箱", specialUse: "\\Drafts" }]; },
    async append(path: string, content: Buffer, value: string[]) {
      assert.equal(path, "草稿箱");
      raw = content;
      flags = value;
      return { uidValidity: 42n, uid: 19 };
    },
  });
  const receipt = await backend(client).saveDraft({ account: "163", to: ["reader@example.org"], subject: "测试", body: "草稿内容" });
  assert.equal(receipt.status, "saved");
  assert.equal(parseBoundMailMessageId(receipt.messageId).account, "163");
  assert.equal(parseBoundMailMessageId(receipt.messageId).folder, "草稿箱");
  assert.equal(parseBoundMailMessageId(receipt.messageId).uid, 19);
  assert.deepEqual(flags, ["\\Draft"]);
  assert.ok(raw);
  const parsed = await simpleParser(raw);
  assert.equal(parsed.subject, "测试");
  assert.equal(parsed.text?.trim(), "草稿内容");
  checks += 8;
}

{
  let calls = 0;
  let options: unknown;
  const client = fakeImap();
  const instance = backend(client, {
    createSmtpTransport: (value) => {
      options = value;
      return {
        async sendMail() {
          calls++;
          return { accepted: ["reader@example.org"], rejected: [], pending: [], messageId: "<test@example.org>" };
        },
        close() {},
      } as unknown as SmtpTransport;
    },
  });
  const input = { account: "qq" as const, to: ["reader@example.org"], subject: "A", body: "Content" };
  const receipt = await instance.sendMail(input);
  assert.equal(receipt.status, "sent");
  assert.equal(calls, 1);
  assert.equal((options as { host: string }).host, "smtp.qq.com");
  assert.equal((options as { port: number }).port, 465);
  assert.equal((options as { secure: boolean }).secure, true);
  await instance.sendMail(input);
  assert.equal(calls, 2);
  checks += 6;
}

{
  let appendPath = "";
  const client = fakeImap({
    async list() { return [
      { path: "HiddenDrafts", name: "Drafts", flags: new Set(["\\Noselect"]) },
      { path: "草稿箱", name: "草稿箱", flags: new Set() },
    ]; },
    async append(path: string) {
      appendPath = path;
      return { uidValidity: 42n, uid: 20 };
    },
  });
  const result = await backend(client).saveDraft({ account: "qq", to: ["a@example.org"], body: "Body only" });
  assert.equal(result.folder, "草稿箱");
  assert.equal(appendPath, "草稿箱");
  checks += 2;
}

{
  let appendCalled = false;
  const client = fakeImap({
    async list() { return [
      { path: "Drafts", name: "Drafts", flags: new Set() },
      { path: "Draft", name: "Draft", flags: new Set() },
    ]; },
    async append() { appendCalled = true; return { uid: 1 }; },
  });
  await rejectsCode(backend(client).saveDraft({ account: "qq", to: ["a@example.org"], body: "Body only" }), "MAIL_DRAFTS_UNAVAILABLE");
  assert.equal(appendCalled, false);
  checks += 2;
}

{
  const client = fakeImap();
  const instance = backend(client, {
    createSmtpTransport: () => ({
      async sendMail() { return { accepted: ["a@example.org"], rejected: ["b@example.org"], pending: [], messageId: "<test@example.org>" }; },
      close() {},
    }) as unknown as SmtpTransport,
  });
  await rejectsCode(instance.sendMail({ account: "qq", to: ["a@example.org", "b@example.org"], subject: "A", body: "Content" }), "MAIL_PARTIAL_DELIVERY");
  checks++;
}

{
  const client = fakeImap();
  await rejectsCode(backend(client).listMail({ account: "qq", limit: 51 }), "MAIL_INVALID_LIMIT");
  await rejectsCode(backend(client).readMail({ account: "qq", messageId: "7" }), "MAIL_INVALID_MESSAGE_ID");
  await rejectsCode(backend(client).saveDraft({ account: "qq", to: ["a@example.org"], subject: "A", body: "B" }), "MAIL_DRAFTS_UNAVAILABLE");
  await rejectsCode(backend(client).sendMail({ account: "qq", to: ["a@example.org", "a@example.org"], subject: "A", body: "B" }), "MAIL_INVALID_RECIPIENTS");
  await rejectsCode(backend(client, { getEnv: (name) => name === "CCAGENT_QQ_MAIL_ADDRESS" ? "attacker@qq.com.evil.example" : env[name] }).listMail({ account: "qq" }), "MAIL_INVALID_ACCOUNT_ADDRESS");
  checks += 5;
}

{
  let sentSubject: unknown;
  const client = fakeImap();
  const instance = backend(client, {
    createSmtpTransport: () => ({
      async sendMail(mail: { subject?: string }) {
        sentSubject = mail.subject;
        return { accepted: ["a@example.org"], rejected: [], pending: [], messageId: "<test@example.org>" };
      },
      close() {},
    }) as unknown as SmtpTransport,
  });
  const result = await instance.sendMail({ account: "qq", to: ["a@example.org"], body: "Body only" });
  assert.equal(sentSubject, "");
  assert.equal(result.status, "sent");
  checks += 2;
}

{
  const seen: Record<string, unknown> = {};
  const client = fakeImap({
    mailbox: { uidValidity: 42n, exists: 2_500 },
    async getMailboxLock(path: string, options: unknown) {
      seen.path = path;
      seen.options = options;
      return { path, release() {} };
    },
    async search(query: unknown, options: unknown) {
      seen.query = query;
      seen.searchOptions = options;
      return [3, 10, 7];
    },
    async fetchAll(ids: unknown, _query: unknown, options: unknown) {
      seen.fetchIds = ids;
      seen.fetchOptions = options;
      return [
        { seq: 1, uid: 10, envelope: { subject: "Quarterly update", from: [{ address: "a@example.org" }] }, size: 100, flags: new Set() },
        { seq: 2, uid: 7, envelope: { subject: "Older update", from: [{ address: "b@example.org" }] }, size: 90, flags: new Set(["\\Seen"]) },
      ];
    },
  });
  const result = await backend(client).searchMail({ account: "qq", limit: 2, subject: "update", from: "example.org", since: "2026-01-01" });
  assert.equal(seen.path, "INBOX");
  assert.deepEqual(seen.options, { readOnly: true });
  assert.deepEqual(seen.query, { subject: "update", from: "example.org", since: "2026-01-01", seq: "501:2500" });
  assert.deepEqual(seen.searchOptions, { uid: true });
  assert.deepEqual(seen.fetchIds, [10, 7]);
  assert.deepEqual(seen.fetchOptions, { uid: true });
  assert.equal(result.searchedRecentMessages, 2_000);
  assert.equal(result.totalMatchesInWindow, 3);
  assert.deepEqual(result.messages.map((item) => item.messageId), ["m1:qq:SU5CT1g:42:10", qqInbox7]);
  checks += 9;
}

{
  const client = fakeImap();
  const instance = backend(client);
  await rejectsCode(instance.searchMail({ account: "qq" }), "MAIL_INVALID_SEARCH");
  await rejectsCode(instance.searchMail({ account: "qq", since: "2026-02-30" }), "MAIL_INVALID_SEARCH");
  await rejectsCode(instance.searchMail({ account: "qq", since: "2026-02-01", before: "2026-01-01" }), "MAIL_INVALID_SEARCH");
  await rejectsCode(instance.searchMail({ account: "qq", text: "hello\nworld" }), "MAIL_INVALID_SEARCH");
  checks += 4;
}

{
  let fetches = 0;
  let moves = 0;
  let moveArgs: unknown;
  const selectedMailbox = { uidValidity: 42n, exists: 2 };
  const client = fakeImap({
    mailbox: selectedMailbox,
    async getMailboxLock(path: string, options: unknown) {
      selectedMailbox.uidValidity = path === "Deleted Messages" ? 11n : 42n;
      assert.deepEqual(options, path === "Deleted Messages" ? { readOnly: true } : undefined);
      return { path, release() {} };
    },
    async list() { return [
      { path: "Unselectable", name: "Trash", specialUse: "\\Trash", flags: new Set(["\\Noselect"]) },
      { path: "Deleted Messages", name: "Deleted Messages", specialUse: "\\Trash", flags: new Set() },
    ]; },
    async fetchOne(uid: number) { fetches++; return fetches === 1 ? { uid: 7 } : fetches === 2 ? false : { uid }; },
    async messageMove(uid: string, destination: string, options: unknown) {
      moves++;
      moveArgs = { uid, destination, options };
      return { path: "INBOX", destination, uidValidity: 11n, uidMap: new Map([[7, 19]]) };
    },
  });
  const receipt = await backend(client).deleteMail({ account: "qq", messageId: qqInbox7 });
  assert.equal(receipt.status, "moved_to_trash");
  assert.equal(receipt.verification, "trash_uid_verified");
  assert.equal(receipt.trashFolder, "Deleted Messages");
  assert.equal(parseBoundMailMessageId(receipt.trashMessageId).folder, "Deleted Messages");
  assert.equal(parseBoundMailMessageId(receipt.trashMessageId).uidValidity, "11");
  assert.equal(parseBoundMailMessageId(receipt.trashMessageId).uid, 19);
  assert.deepEqual(moveArgs, { uid: "7", destination: "Deleted Messages", options: { uid: true } });
  assert.equal(fetches, 3);
  assert.equal(moves, 1);
  checks += 9;
}

{
  let moved = false;
  const client = fakeImap({
    capabilities: new Map(),
    async list() { return [{ path: "Trash", name: "Trash", flags: new Set() }]; },
    async messageMove() { moved = true; return false; },
  });
  await rejectsCode(backend(client).deleteMail({ account: "163", messageId: mail163Inbox7 }), "MAIL_MOVE_UNSUPPORTED");
  assert.equal(moved, false);
  checks += 2;
}

{
  let moved = false;
  const client = fakeImap({
    async list() { return [
      { path: "Trash", name: "Trash", flags: new Set() },
      { path: "Deleted Items", name: "Deleted Items", flags: new Set() },
    ]; },
    async messageMove() { moved = true; return false; },
  });
  await rejectsCode(backend(client).deleteMail({ account: "qq", messageId: qqInbox7 }), "MAIL_TRASH_UNAVAILABLE");
  assert.equal(moved, false);
  checks += 2;
}

{
  let moved = false;
  const client = fakeImap({
    async list() { return [{ path: "Trash", name: "Trash", flags: new Set() }]; },
    async fetchOne() { return { uid: 7 }; },
    async messageMove() { moved = true; return true; },
  });
  await rejectsCode(backend(client).deleteMail({ account: "qq", messageId: qqInbox7Stale }), "MAIL_STALE_MESSAGE_ID");
  assert.equal(moved, false);
  await rejectsCode(backend(client).deleteMail({ account: "qq", messageId: qqInbox7 }), "MAIL_MOVE_UNCERTAIN");
  assert.equal(moved, true);
  checks += 4;
}

{
  assert.equal(validateMailInput({ account: "qq", operation: "search", subject: "invoice", limit: 20 }), null);
  assert.equal(validateMailInput({ account: "qq", operation: "delete", message_id: qqInbox7 }), null);
  assert.equal(validateMailInput({ account: "qq", operation: "read", message_id: "42:7" }), null);
  assert.match(validateMailInput({ account: "qq", operation: "search" }) ?? "", /criterion/);
  assert.match(validateMailInput({ account: "qq", operation: "search", since: "2026-02-30" }) ?? "", /real YYYY-MM-DD/);
  assert.match(validateMailInput({ account: "qq", operation: "delete", message_id: "42:7" }) ?? "", /folder-bound/);
  assert.match(validateMailInput({ account: "163", operation: "delete", message_id: qqInbox7 }) ?? "", /another account/);
  assert.match(validateMailInput({ account: "qq", operation: "delete", message_id: qqInbox7, folder: "Other" }) ?? "", /unexpected field/);
  assert.match(validateMailInput({ account: "qq", operation: "read", message_id: qqInbox7, folder: "Other" }) ?? "", /does not match/);
  assert.match(validateMailInput({ account: "qq", operation: "delete", message_id: qqInbox7, to: ["victim@example.org"] }) ?? "", /unexpected field/);
  checks += 10;
}

{
  let connectCount = 0;
  const client = fakeImap({ async connect() { connectCount++; } });
  const instance = backend(client);
  await rejectsCode(instance.deleteMail({ account: "qq", messageId: "42:7" }), "MAIL_INVALID_MESSAGE_ID");
  await rejectsCode(instance.deleteMail({ account: "163", messageId: qqInbox7 }), "MAIL_MESSAGE_ACCOUNT_MISMATCH");
  assert.equal(connectCount, 0);
  checks += 3;
}

{
  let moved = false;
  const client = fakeImap({
    async list() { return [{ path: "垃圾箱", name: "垃圾箱", flags: new Set() }]; },
    async messageMove() { moved = true; return false; },
  });
  await rejectsCode(backend(client).deleteMail({ account: "qq", messageId: qqInbox7 }), "MAIL_TRASH_UNAVAILABLE");
  assert.equal(moved, false);
  checks += 2;
}

{
  let fetches = 0;
  const client = fakeImap({
    async list() { return [{ path: "Trash", name: "Trash", flags: new Set() }]; },
    async fetchOne() { fetches++; return fetches === 1 ? { uid: 7 } : false; },
    async messageMove() { return { path: "INBOX", destination: "Trash" }; },
  });
  const result = await backend(client).deleteMail({ account: "qq", messageId: qqInbox7 });
  assert.equal(result.verification, "server_move_and_source_absent");
  assert.equal(result.trashMessageId, null);
  assert.equal(fetches, 2);
  checks += 3;
}

{
  const selected: string[] = [];
  let fetches = 0;
  const client = fakeImap({
    async list() { return [{ path: "Trash", name: "Trash", flags: new Set() }]; },
    async getMailboxLock(path: string) { selected.push(path); return { path, release() {} }; },
    async fetchOne() { fetches++; return fetches === 1 ? { uid: 7 } : false; },
    async messageMove() { return { path: "Other", destination: "Trash" }; },
  });
  const result = await backend(client).deleteMail({ account: "qq", messageId: "m1:qq:T3RoZXI:42:7" });
  assert.deepEqual(selected, ["Other"]);
  assert.equal(result.sourceFolder, "Other");
  checks += 2;
}

{
  let fetches = 0;
  const selectedMailbox = { uidValidity: 42n, exists: 2 };
  const client = fakeImap({
    mailbox: selectedMailbox,
    async list() { return [{ path: "Trash", name: "Trash", specialUse: "\\Trash", flags: new Set() }]; },
    async getMailboxLock(path: string) {
      selectedMailbox.uidValidity = path === "Trash" ? 11n : 42n;
      return { path, release() {} };
    },
    async fetchOne(uid: number) { fetches++; return fetches === 1 ? { uid: 7 } : false; },
    async messageMove() { return { path: "INBOX", destination: "Trash", uidValidity: 11n, uidMap: new Map([[7, 19]]) }; },
  });
  await rejectsCode(backend(client).deleteMail({ account: "qq", messageId: qqInbox7 }), "MAIL_MOVE_UNCERTAIN");
  assert.equal(fetches, 3);
  checks += 2;
}

console.log(`mail backend: ${checks} offline checks passed`);
