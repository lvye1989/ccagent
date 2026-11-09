import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AccountError, PlatformAccountClient, type StoredAccountSession } from "../platform/accountClient.js";
import { SecureCredentialStore } from "../platform/secureStore.js";

// These fixtures never read a user's session, send a password, or call a provider.
class MemoryStore extends SecureCredentialStore<StoredAccountSession> {
  private value: StoredAccountSession | null;
  private generation = 1;
  constructor(value: StoredAccountSession) { super("fixture-memory-only"); this.value = structuredClone(value); }
  override async read(): Promise<StoredAccountSession | null> { return structuredClone(this.value); }
  override async revision(): Promise<string | null> { return this.value ? String(this.generation) : null; }
  override async write(value: StoredAccountSession): Promise<void> { this.generation++; this.value = structuredClone(value); }
  override async clear(): Promise<void> { this.generation++; this.value = null; }
  override async clearIfRevision(expected: string | null): Promise<boolean> {
    if (expected === null || String(this.generation) !== expected) return false;
    this.generation++; this.value = null; return true;
  }
}

let received = 0;
let handler: (req: IncomingMessage, res: ServerResponse) => void = () => { throw new Error("Missing fixture handler"); };
const server = createServer((req, res) => {
  assert.equal(req.url, "/api/auth/get-session");
  received++;
  handler(req, res);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const identity = { id: "fixture-account", email: "fixture@example.invalid", name: "Fixture" };
function session(cookie = "ccagent.session_token=fixture-one.signature"): StoredAccountSession {
  return { origin, cookie, user: { ...identity }, expiresAt: new Date(Date.now() + 60_000).toISOString() };
}
function reply(res: ServerResponse, user = identity): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ user, session: { expiresAt: new Date(Date.now() + 60_000).toISOString() } }));
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  received = 0;
  await run();
  passed++;
  console.log(`PASS ${name}`);
}

try {
  await test("parallel checks share exactly one live request and return independent results", async () => {
    handler = (_req, res) => { void pause(30).then(() => reply(res)); };
    const client = new PlatformAccountClient(origin, new MemoryStore(session()));
    const results = await Promise.all(Array.from({ length: 8 }, () => client.requireSession()));
    assert.equal(received, 1);
    results[0]!.user.name = "Caller mutation";
    assert.equal(results[1]!.user.name, identity.name);
  });

  await test("different client objects can share only the same native store check", async () => {
    handler = (_req, res) => { void pause(30).then(() => reply(res)); };
    const store = new MemoryStore(session());
    await Promise.all(Array.from({ length: 4 }, () => new PlatformAccountClient(origin, store).requireSession()));
    assert.equal(received, 1);
  });

  await test("completed success is not cached and later revocation is checked remotely", async () => {
    const store = new MemoryStore(session());
    const client = new PlatformAccountClient(origin, store);
    handler = (_req, res) => reply(res);
    await client.requireSession();
    handler = (_req, res) => { res.writeHead(403, { "content-type": "application/json" }); res.end("{}"); };
    await assert.rejects(() => client.requireSession(), (error: unknown) => error instanceof AccountError && error.status === 403);
    assert.equal(received, 2);
    assert.equal(await store.read(), null);
  });

  await test("failed verification is not cached", async () => {
    const store = new MemoryStore(session());
    const client = new PlatformAccountClient(origin, store);
    handler = (_req, res) => { res.writeHead(503, { "content-type": "application/json" }); res.end("{}"); };
    await assert.rejects(() => client.requireSession(), (error: unknown) => error instanceof AccountError && error.code === "service_unavailable");
    handler = (_req, res) => reply(res);
    await client.requireSession();
    assert.equal(received, 2);
  });

  await test("separate stores and credentials are never merged", async () => {
    handler = (_req, res) => { void pause(30).then(() => reply(res)); };
    await Promise.all([
      new PlatformAccountClient(origin, new MemoryStore(session())).requireSession(),
      new PlatformAccountClient(origin, new MemoryStore(session())).requireSession(),
      new PlatformAccountClient(origin, new MemoryStore(session("ccagent.session_token=fixture-two.signature"))).requireSession(),
    ]);
    assert.equal(received, 3);
  });

  await test("a late success cannot restore a locally cleared session", async () => {
    const held = deferred<ServerResponse>();
    handler = (_req, res) => held.resolve(res);
    const store = new MemoryStore(session());
    const pending = new PlatformAccountClient(origin, store).requireSession();
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof AccountError && error.code === "account_changed");
    const res = await held.promise;
    await store.clear();
    reply(res);
    await rejected;
    assert.equal(await store.read(), null);
  });

  await test("a late rejected old credential cannot clear or join a replacement login", async () => {
    const held = deferred<ServerResponse>();
    const store = new MemoryStore(session());
    const client = new PlatformAccountClient(origin, store);
    handler = (req, res) => {
      if (req.headers.cookie === session().cookie) held.resolve(res);
      else reply(res);
    };
    const pending = client.requireSession();
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof AccountError && error.status === 401);
    const oldResponse = await held.promise;
    const replacement = session("ccagent.session_token=fixture-replacement.signature");
    await store.write(replacement);
    assert.equal((await client.requireSession()).user.id, identity.id);
    oldResponse.writeHead(401, { "content-type": "application/json" }); oldResponse.end("{}");
    await rejected;
    assert.equal(received, 2);
    assert.deepEqual(await store.read(), replacement);
  });

  await test("a new session revision does not reuse a successful old response", async () => {
    const held = deferred<ServerResponse>();
    const store = new MemoryStore(session());
    const client = new PlatformAccountClient(origin, store);
    handler = (req, res) => {
      if (req.headers.cookie === session().cookie) held.resolve(res);
      else reply(res);
    };
    const pending = client.requireSession();
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof AccountError && error.code === "account_changed");
    const oldResponse = await held.promise;
    await store.write(session("ccagent.session_token=fixture-new.signature"));
    await client.requireSession();
    reply(oldResponse);
    await rejected;
    assert.equal(received, 2);
    assert.ok(await store.read());
  });

  await test("an old authentication rejection cannot clear a login written during delayed conditional cleanup", async () => {
    const parent = await realpath(os.tmpdir());
    const directory = await mkdtemp(path.join(parent, "ccagent-session-cleanup-"));
    try {
      const enteringCleanup = deferred<void>(), continueCleanup = deferred<void>();
      class DelayedClearStore extends SecureCredentialStore<StoredAccountSession> {
        override async clearIfRevision(expected: string | null): Promise<boolean> {
          enteringCleanup.resolve(); await continueCleanup.promise;
          return super.clearIfRevision(expected);
        }
      }
      const file = path.join(directory, "fixture.json");
      const store = new DelayedClearStore(file), writer = new SecureCredentialStore<StoredAccountSession>(file);
      await store.write(session());
      handler = (_req, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end("{}"); };
      const pending = new PlatformAccountClient(origin, store).requireSession();
      const rejected = assert.rejects(pending, (error: unknown) => error instanceof AccountError && error.status === 401);
      await enteringCleanup.promise;
      const replacement = session("ccagent.session_token=fixture-conditional-replacement.signature");
      await writer.write(replacement);
      continueCleanup.resolve(); await rejected;
      assert.deepEqual(await writer.read(), replacement);
    } finally {
      const relative = path.relative(parent, directory);
      assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
      await rm(directory, { recursive: true, force: true });
    }
  });

  await test("the revision check and deletion share the writer's cross-instance transaction", async () => {
    const parent = await realpath(os.tmpdir());
    const directory = await mkdtemp(path.join(parent, "ccagent-session-transaction-"));
    try {
      const file = path.join(directory, "fixture.json");
      const store = new SecureCredentialStore<StoredAccountSession>(file), writer = new SecureCredentialStore<StoredAccountSession>(file);
      await store.write(session());
      const revision = await store.revision();
      const observed = deferred<void>(), continueCheck = deferred<void>();
      const readRevision = store.revision.bind(store);
      store.revision = async () => {
        const current = await readRevision(); observed.resolve(); await continueCheck.promise; return current;
      };
      const clearing = store.clearIfRevision(revision);
      await observed.promise;
      const replacement = session("ccagent.session_token=fixture-transaction-replacement.signature");
      const writing = writer.write(replacement);
      // Without a shared mutation transaction, this write would complete and
      // then be unlinked by the old conditional clear after the pause.
      await pause(process.platform === "win32" ? 300 : 30);
      continueCheck.resolve();
      assert.equal(await clearing, true); await writing;
      assert.deepEqual(await writer.read(), replacement);
    } finally {
      const relative = path.relative(parent, directory);
      assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
      await rm(directory, { recursive: true, force: true });
    }
  });

  await test("controlled queued authentication workload measures in-flight deduplication", async () => {
    const delayMs = 60, count = 8;
    let queue = Promise.resolve();
    handler = (_req, res) => { queue = queue.then(() => pause(delayMs)).then(() => reply(res)); };
    const baselineStarted = performance.now();
    await Promise.all(Array.from({ length: count }, () => new PlatformAccountClient(origin, new MemoryStore(session())).requireSession()));
    const baselineMs = performance.now() - baselineStarted;
    assert.equal(received, count);
    received = 0;
    const store = new MemoryStore(session());
    const client = new PlatformAccountClient(origin, store);
    const sharedStarted = performance.now();
    await Promise.all(Array.from({ length: count }, () => client.requireSession()));
    const sharedMs = performance.now() - sharedStarted;
    assert.equal(received, 1);
    received = 0;
    const sequentialStarted = performance.now();
    await client.requireSession(); await client.requireSession();
    const sequentialMs = performance.now() - sequentialStarted;
    assert.equal(received, 2);
    console.log(JSON.stringify({ fixture: "local authentication, single-server queue, 60 ms per verification", parallelChecks: count,
      baseline: { remoteRequests: count, elapsedMs: Math.round(baselineMs) },
      coalesced: { remoteRequests: 1, elapsedMs: Math.round(sharedMs) },
      sequentialNoCache: { remoteRequests: 2, elapsedMs: Math.round(sequentialMs) } }));
  });
  console.log(`PASS ${passed} in-flight account-session checks`);
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
