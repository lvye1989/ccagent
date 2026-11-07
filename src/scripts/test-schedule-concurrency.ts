import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { startAccountFixture } from "./helpers/accountFixture.js";
import { accountHome } from "../platform/account.js";
import { WebScheduleStore } from "../entrypoint/webSchedules.js";
import { bootstrapWorkfriendScheduler, cancelWorkfriendSchedule, clearWorkfriendTimers, createWorkfriendSchedule, listWorkfriendSchedules } from "../workfriend/scheduler.js";
import { drainPendingNotifications } from "../state/notificationStore.js";
import { withFileTransaction } from "../utils/fileTransaction.js";

type Message = { id: number; op: string; args: any[] };
if (process.argv.includes("--schedule-worker")) {
  const store = new WebScheduleStore();
  const claims = new Map<string, string>();
  const actions: Record<string, (...args: any[]) => unknown> = {
    load: () => store.load(), list: workspace => store.list(workspace), add: task => store.add(task),
    claim: async (workspace, at) => { const task = await store.claimDue(workspace, at ? new Date(at) : undefined); if (task) claims.set(task.id, task.runId); return task; },
    finish: (id, update, runId) => store.recordResult(id, runId ?? claims.get(id) ?? "", update), change: (id, workspace, action) => store.change(id, workspace, action),
    reminder: input => createWorkfriendSchedule(input), reminders: listWorkfriendSchedules,
    boot: bootstrapWorkfriendScheduler, cancel: cancelWorkfriendSchedule, notifications: drainPendingNotifications,
  };
  process.on("message", async ({ id, op, args }: Message) => {
    if (op === "stop") { clearWorkfriendTimers(); process.exit(0); }
    try { process.send?.({ id, value: await actions[op]!(...args) }); }
    catch (error) { process.send?.({ id, error: (error as Error).message }); }
  });
  process.once("disconnect", () => { clearWorkfriendTimers(); process.exit(0); });
  process.send?.({ ready: true });
} else {
  const temporaryRoot = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, "ccagent-schedule-concurrency-"));
  const home = path.join(directory, "home"), workspace = path.join(directory, "project");
  await mkdir(home); await mkdir(workspace);
  const workers: { child: ChildProcess; call: (op: string, ...args: any[]) => Promise<any>; stop: () => Promise<void> }[] = [];
  let outer: ChildProcess | undefined;
  let fixture: Awaited<ReturnType<typeof startAccountFixture>> | undefined;
  let checks = 0;
  async function test(name: string, action: () => Promise<void>) { await action(); checks++; console.log(`PASS ${name}`); }
  async function worker(workerHome: string) {
    const child = spawn(process.execPath, ["--import", "tsx", path.resolve(import.meta.filename), "--schedule-worker"], {
      env: { ...process.env, CCAGENT_HOME: workerHome }, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout?.resume(); child.stderr?.resume();
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    let sequence = 0;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Schedule worker did not start")), 15_000);
      child.once("error", reject);
      child.on("message", (value: any) => {
        if (value.ready) { clearTimeout(timer); resolve(); return; }
        const entry = pending.get(value.id); if (!entry) return;
        clearTimeout(entry.timer); pending.delete(value.id);
        if (value.error) entry.reject(new Error(value.error)); else entry.resolve(value.value);
      });
    });
    child.once("exit", () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Schedule worker exited")); } pending.clear(); });
    const handle = {
      child,
      call(op: string, ...args: any[]) {
        return new Promise<any>((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Schedule operation timed out: ${op}`)); }, 15_000);
          pending.set(id, { resolve, reject, timer });
          child.send({ id, op, args }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
        });
      },
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
        child.send({ id: 0, op: "stop", args: [] });
        await exit;
      },
    };
    workers.push(handle); return handle;
  }
  const input = (title: string, extra = {}) => ({ title, workspace, prompt: "/help", model: "fixture", mode: "default", repeat: "none", nextRunAt: new Date(Date.now() + 3600_000).toISOString(), ...extra });
  try {
    const actors = await Promise.all([worker(home), worker(home), worker(home)]);
    await test("three processes add without losing another window's updates", async () => {
      await Promise.all(actors.map((actor, index) => Promise.all(Array.from({ length: 8 }, (_, number) => actor.call("add", input(`${index}:${number}`))))));
      for (const actor of actors) assert.equal((await actor.call("list", workspace)).length, 24);
    });
    const due = await actors[0]!.call("add", input("claim once", { nextRunAt: new Date(Date.now() - 1000).toISOString() }));
    const claims = await Promise.all(actors.map(actor => actor.call("claim", workspace)));
    const ownerIndex = claims.findIndex(Boolean), owner = actors[ownerIndex]!;
    await test("only one process claims the same due task", async () => {
      assert.equal(claims.filter(Boolean).length, 1); assert.equal(claims[ownerIndex].id, due.id);
      assert(!("runOwner" in claims[ownerIndex]), "Process ownership stays out of the public task response");
    });
    await test("a new window preserves a live run and rejects non-owner result writes", async () => {
      const newcomer = await worker(home); await newcomer.call("load");
      assert.equal((await newcomer.call("list", workspace)).find((item: any) => item.id === due.id).status, "running");
      await assert.rejects(newcomer.call("finish", due.id, { finished: true }), /Only the instance/);
      for (const action of ["pause", "resume", "delete", "run-now"]) await assert.rejects(newcomer.call("change", due.id, workspace, action), /Wait for/);
    });
    await test("another due task in the same workspace waits for the running task", async () => {
      const second = await actors[1]!.call("add", input("second", { nextRunAt: new Date(Date.now() - 500).toISOString() }));
      assert.equal(await actors[1]!.call("claim", workspace), null);
      await owner.call("finish", due.id, { sessionId: "11111111-1111-4111-8111-111111111111", finished: true });
      for (const actor of actors) assert.equal((await actor.call("list", workspace)).find((item: any) => item.id === due.id).status, "completed");
      const claimed = await actors[1]!.call("claim", workspace); assert.equal(claimed.id, second.id);
      await actors[1]!.call("finish", second.id, { finished: true });
    });
    await test("an exited owner's run pauses for review and never automatically repeats", async () => {
      const abandoned = await owner.call("add", input("interrupted", { nextRunAt: new Date(Date.now() - 100).toISOString() }));
      assert.equal((await owner.call("claim", workspace)).id, abandoned.id);
      await owner.call("finish", abandoned.id, { sessionId: "22222222-2222-4222-8222-222222222222" });
      await owner.stop();
      const survivor = actors.find(actor => actor !== owner)!;
      const task = (await survivor.call("list", workspace)).find((item: any) => item.id === abandoned.id);
      assert.equal(task.status, "paused"); assert.match(task.lastError, /手动继续/);
      assert.equal(task.lastSessionId, "22222222-2222-4222-8222-222222222222");
      assert.equal(await survivor.call("claim", workspace), null);
    });
    await test("a delayed completion cannot finish a newer repetition of the same task", async () => {
      const actor = actors.find(item => item !== owner)!, repeatedWorkspace = workspace + "-repeated";
      const task = await actor.call("add", input("repeated", { workspace: repeatedWorkspace, repeat: "daily", nextRunAt: new Date(Date.now() - 1000).toISOString() }));
      const first = await actor.call("claim", repeatedWorkspace); await actor.call("finish", task.id, { finished: true });
      const second = await actor.call("claim", repeatedWorkspace, new Date(Date.now() + 86400_000).toISOString());
      assert.notEqual(first.runId, second.runId);
      await assert.rejects(actor.call("finish", task.id, { finished: true }, first.runId), /Only the instance/);
      assert.equal((await actor.call("list", repeatedWorkspace))[0].status, "running");
      await actor.call("finish", task.id, { finished: true }, second.runId);
    });
    await test("corrupt schedule data is rejected without rewriting the original bytes", async () => {
      const invalidHome = path.join(directory, "invalid"); await mkdir(invalidHome);
      const file = path.join(invalidHome, "web-schedules.json"), bytes = "[invalid existing schedule data";
      await writeFile(file, bytes);
      const actor = await worker(invalidHome); await assert.rejects(actor.call("load"));
      assert.equal(await readFile(file, "utf8"), bytes);
    });
    await test("separate account directories cannot see or claim each other's tasks", async () => {
      const separateHome = path.join(directory, "separate"); await mkdir(separateHome);
      const actor = await worker(separateHome);
      assert.deepEqual(await actor.call("list", workspace), []); assert.equal(await actor.call("claim", workspace), null);
    });
    const reminderActors = await Promise.all([worker(home), worker(home), worker(home)]);
    const future = new Date(Date.now() + 3 * 3600_000);
    const hhmm = (value: Date) => `${value.getHours().toString().padStart(2, "0")}:${value.getMinutes().toString().padStart(2, "0")}`;
    await test("concurrent Workfriend reminder creation preserves every entry", async () => {
      await Promise.all(reminderActors.map((actor, index) => Promise.all(Array.from({ length: 5 }, (_, number) => actor.call("reminder", {
        workdayEnd: hhmm(future), workSummary: `${index}:${number}`, moodSummary: "test", cwd: workspace,
      })))));
      assert.equal((await reminderActors[0]!.call("reminders")).length, 15);
    });
    await test("three reminder timers produce one claimed notification", async () => {
      const soon = new Date(Date.now() + 30 * 60_000);
      const reminder = await reminderActors[0]!.call("reminder", { workdayEnd: hhmm(soon), workSummary: "claim once", moodSummary: "test", cwd: workspace });
      await Promise.all(reminderActors.map(actor => actor.call("boot")));
      let notifications: any[] = [];
      for (let attempt = 0; attempt < 60; attempt++) {
        notifications.push(...(await Promise.all(reminderActors.map(actor => actor.call("notifications")))).flat());
        if (notifications.length) break; await delay(50);
      }
      await delay(250);
      notifications.push(...(await Promise.all(reminderActors.map(actor => actor.call("notifications")))).flat());
      assert.equal(notifications.length, 1); assert.match(notifications[0].text, new RegExp(reminder.id));
      assert.equal((await reminderActors[1]!.call("reminders")).find((item: any) => item.id === reminder.id).status, "fired");
      assert.equal(await reminderActors[2]!.call("cancel", reminder.id), false);
    });
    await test("legacy running tasks require review without losing their previous result", async () => {
      const legacyHome = path.join(directory, "legacy"); await mkdir(legacyHome);
      await writeFile(path.join(legacyHome, "web-schedules.json"), JSON.stringify([{ ...due, status: "running", lastSessionId: "legacy-session" }]));
      const actor = await worker(legacyHome); await actor.call("load");
      const [task] = await actor.call("list", workspace); assert.equal(task.status, "paused"); assert.equal(task.lastSessionId, "legacy-session");
    });

    const base = path.join(directory, "platform"); await mkdir(base);
    fixture = await startAccountFixture(base);
    const platformAccountHome = accountHome(base, fixture.users[0]!.id); await mkdir(platformAccountHome, { recursive: true });
    await writeFile(path.join(platformAccountHome, "settings.json"), JSON.stringify({ model: "fixture", models: { fixture: { protocol: "openai-chat", model: "fixture", baseURL: "https://example.invalid/v1", apiKey: "unused-fixture-key" } } }));
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer(); server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => address && typeof address !== "string" ? resolve(address.port) : reject(new Error("port"))); });
    });
    const env: NodeJS.ProcessEnv = { ...process.env, CCAGENT_HOME: base, CCAGENT_PLATFORM_HOME: base };
    for (const name of ["CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_DESKTOP_TOKEN", "NODE_TLS_REJECT_UNAUTHORIZED"]) delete env[name];
    outer = spawn(process.execPath, [path.resolve(import.meta.dirname, "../../dist/ccagent.js"), "web", "--workspace", workspace, "--port", String(port)], { env, cwd: workspace, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    outer.stdout?.resume(); outer.stderr?.resume();
    const origin = `http://127.0.0.1:${port}`;
    for (let attempt = 0; ; attempt++) {
      try { if ((await fetch(origin + "/api/health")).ok) break; } catch { /* Starting. */ }
      if (attempt > 100) throw new Error("Web service did not start"); await delay(100);
    }
    async function request(route: string, cookie?: string, body?: unknown) {
      return fetch(origin + route, { method: body === undefined ? "GET" : "POST", headers: { "x-ccagent-web": "1", origin, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    }
    async function login() {
      const response = await request("/api/account/login", undefined, { email: fixture!.users[0]!.email, password: fixture!.password });
      assert.equal(response.status, 200); const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
      assert.equal((await request("/api/bootstrap", cookie)).status, 200); return cookie;
    }
    const cookieA = await login(), cookieB = await login();
    await test("a schedule poll waiting on another process does not falsely reject a workspace change", async () => {
      let unlock!: () => void, acquired!: () => void;
      const locked = new Promise<void>(resolve => { acquired = resolve; });
      const holding = withFileTransaction(path.join(platformAccountHome, "web-schedules.json"), async () => {
        acquired(); await new Promise<void>(resolve => { unlock = resolve; });
      });
      await locked;
      try {
        // Both real workers poll every ten seconds; keep the shared file busy
        // until their next poll, then release it while the user action waits.
        await delay(10_500);
        const change = request("/api/workspaces/select", cookieB, { path: workspace });
        await delay(100); unlock();
        const response = await change; assert.equal(response.status, 200, await response.text());
      } finally { unlock(); await holding; }
    });
    let scheduledId = "";
    await test("two authenticated Web workers share fresh schedule lists", async () => {
      const response = await request("/api/schedules", cookieA, input("real local help", { nextRunAt: new Date(Date.now() + 1000).toISOString() }));
      assert.equal(response.status, 201); scheduledId = (await response.json() as any).task.id;
      const tasks = (await (await request("/api/schedules", cookieB)).json() as any).tasks;
      assert.equal(tasks.length, 1); assert.equal(tasks[0].id, scheduledId);
    });
    await test("one real QueryEngine session executes the due task across two windows", async () => {
      let task: any;
      for (let attempt = 0; attempt < 150; attempt++) {
        task = (await (await request("/api/schedules", cookieB)).json() as any).tasks.find((item: any) => item.id === scheduledId);
        if (task?.status === "completed") break; await delay(100);
      }
      assert.equal(task?.status, "completed"); assert(task.lastSessionId);
      await delay(1000);
      for (const cookie of [cookieA, cookieB]) {
        const response = await request("/api/bootstrap", cookie); assert.equal(response.status, 200);
        const sessions = (await response.json() as any).sessions;
        assert.equal(sessions.length, 1); assert.equal(sessions[0].sessionId, task.lastSessionId);
      }
    });
    await test("a third authenticated worker does not pause another process's live claim", async () => {
      const response = await request("/api/schedules", cookieA, input("live owner")); assert.equal(response.status, 201);
      const id = (await response.json() as any).task.id, actor = await worker(platformAccountHome);
      assert.equal((await actor.call("claim", workspace, new Date(Date.now() + 7200_000).toISOString())).id, id);
      const cookieC = await login();
      assert.equal((await (await request("/api/schedules", cookieC)).json() as any).tasks.find((item: any) => item.id === id).status, "running");
      await actor.call("finish", id, { finished: true });
      assert.equal((await (await request("/api/schedules", cookieB)).json() as any).tasks.find((item: any) => item.id === id).status, "completed");
    });
    console.log(`Schedule concurrency: ${checks} checks passed; real process locks and authenticated Web/QueryEngine paths, no paid provider requests.`);
  } finally {
    if (outer && outer.exitCode === null && outer.signalCode === null && outer.connected) {
      const stopped = new Promise<void>(resolve => outer!.once("exit", () => resolve()));
      outer.send("ccagent:shutdown", () => {}); await stopped;
    }
    await Promise.all(workers.map(actor => actor.stop()));
    await fixture?.close();
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    assert(path.basename(directory).startsWith("ccagent-schedule-concurrency-"));
    await rm(directory, { recursive: true, force: true });
  }
}
