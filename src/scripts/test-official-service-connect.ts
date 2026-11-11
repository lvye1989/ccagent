import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startAccountFixture } from "./helpers/accountFixture.js";
import { configurePlatform, enterPlatformAccount } from "../platform/account.js";
import { connectOfficialServices, forgetOfficialKey, officialServicesView, saveOfficialServices } from "../platform/gatewayClient.js";
import { readServiceBinding, serviceCredentialStore, servicePaths } from "../platform/serviceState.js";
import { handleCustomization } from "../entrypoint/webCustomization.js";

const temporaryRoot = await realpath(os.tmpdir()), directory = await mkdtemp(path.join(temporaryRoot, "ccagent-service-connect-"));
const base = path.join(directory, "platform"), workspace = path.join(directory, "workspace");
await mkdir(base); await mkdir(workspace);
const envNames = ["CCAGENT_HOME", "CCAGENT_PLATFORM_HOME", "CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_CLOUD_URL"];
const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
process.env.CCAGENT_HOME = base; process.env.CCAGENT_PLATFORM_HOME = base;
for (const name of ["CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_CLOUD_URL"]) delete process.env[name];
type Key = { id: string; owner: string; secret: string; revoked: boolean };
const issued = new Map<string, Key>();
const route = { id: "connect-main", name: "Synthetic Responses", service: "chat", protocol: "openai-responses",
  pricing: { currency: "CNY", definition: { rates: [{ metric: "requests", price: "1", unitQuantity: "1" }], tariff: { kind: "constant" } }, markup: "1.3", usdCny: null, version: 1, sourceUrl: "https://example.invalid/pricing" },
  limits: { contextWindow: 10000, maxOutputTokens: 64, maxImages: 2, fallbackEnabled: false, fallbackRouteId: null } };
let creates = 0, revokes = 0, catalogRequests = 0, catalogInvalid = false, dropCreation = false, rejectRevoke = false;
let createDelay = 0;
let heldCreate: { arrived(): void; wait: Promise<void> } | undefined;
let heldCatalog: { arrived(): void; wait: Promise<void> } | undefined;
let fixture: Awaited<ReturnType<typeof startAccountFixture>>;
fixture = await startAccountFixture(base, { handleService: async (request, response, user) => {
  const reply = (status: number, value: unknown) => { response.writeHead(status); response.end(JSON.stringify(value)); return true; };
  if (!user) return reply(401, { code: "UNAUTHORIZED" });
  if (request.url === "/api/account/me") return reply(200, { permissions: [] });
  if (request.url === "/api/account/wallet") return reply(200, { wallet: { available: "0", frozen: "0" } });
  if (request.url === "/api/account/keys") {
    assert.equal(request.headers.origin, fixture.origin);
    let text = ""; for await (const chunk of request) text += chunk;
    const input = JSON.parse(text);
    if (request.method === "POST") {
      assert.deepEqual(input, { name: "CCAGENT 应用专用 Key" }); creates++;
      const key = { id: randomUUID(), owner: user.id, secret: "ccagent_" + randomBytes(32).toString("base64url"), revoked: false };
      issued.set(key.id, key);
      const held = heldCreate; heldCreate = undefined;
      if (held) { held.arrived(); await held.wait; }
      if (createDelay) await delay(createDelay);
      if (dropCreation) { request.socket.destroy(); return true; }
      return reply(201, { key: { id: key.id, prefix: key.secret.slice(0, 16) }, secret: key.secret });
    }
    assert.equal(request.method, "DELETE");
    const key = issued.get(input.id); assert(key && key.owner === user.id, "cleanup stays with the creating account");
    revokes++; if (rejectRevoke) return reply(503, { message: key.secret });
    key.revoked = true; return reply(200, { revoked: true });
  }
  if (request.url === "/v1/models") {
    catalogRequests++;
    const key = [...issued.values()].find(key => `Bearer ${key.secret}` === request.headers.authorization);
    if (!key || key.owner !== user.id || key.revoked) return reply(403, { code: "INVALID_API_KEY" });
    const held = heldCatalog; heldCatalog = undefined;
    if (held) { held.arrived(); await held.wait; }
    return reply(200, { data: catalogInvalid ? [{ privateDiagnostic: key.secret }] : [route], defaults: { chat: route.id, vision: null, decision: null, search: null, voice: null } });
  }
  throw new Error("Unexpected paid or unrelated request");
} });
let checks = 0;
async function test(name: string, action: () => Promise<void>) { await action(); checks++; console.log(`PASS ${name}`); }
function hold() {
  let arrived!: () => void, release!: () => void;
  const observed = new Promise<void>(resolve => { arrived = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  return { arrived, wait, release, observed };
}
async function loginA() {
  await fixture.nativeClient.signIn(fixture.users[0]!.email, fixture.password);
  process.env.CCAGENT_HOME = base; delete process.env.CCAGENT_ACCOUNT_ID; delete process.env.CCAGENT_AUTH_SESSION_FILE;
  await configurePlatform(fixture.origin); await enterPlatformAccount();
}
async function reset() {
  catalogInvalid = false; dropCreation = false; rejectRevoke = false; createDelay = 0;
  await loginA(); await forgetOfficialKey();
  await rm(servicePaths().state + ".connect", { force: true });
}
function noSecrets(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const key of issued.values()) assert(!text.includes(key.secret), "complete API Keys never leave backend responses/errors");
}
function connectProcess() {
  const source = `const {connectOfficialServices}=await import(${JSON.stringify(new URL("../platform/gatewayClient.ts", import.meta.url).href)});try{console.log(JSON.stringify(await connectOfficialServices()));}catch(error){console.error(error.message);process.exitCode=1;}`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", reject); child.once("close", code => resolve({ code, output }));
  });
}
try {
  await loginA();
  await test("view/GET never creates a Key; explicit connect creates once and returns only safe state", async () => {
    assert.equal((await officialServicesView()).configured, false);
    await handleCustomization("official-services", "GET", {}, { workspace, defaultModel: "personal" }); assert.equal(creates, 0);
    const result = await handleCustomization("official-services", "POST", { op: "connect", automaticAuxiliary: true, fallbackEnabled: false, makeDefault: true }, { workspace, defaultModel: "personal" });
    assert.equal(creates, 1); noSecrets(result);
    const binding = (await readServiceBinding())!;
    assert.equal(binding.configuration.roles.main, route.id); assert.equal(binding.configuration.automaticAuxiliary, true); assert.equal(binding.configuration.auxiliaryEnabled, false); assert.equal(binding.configuration.fallbackEnabled, false);
    assert(!((await readFile(servicePaths().key, "utf8")).includes(binding.credential.apiKey)), "Windows stores DPAPI ciphertext");
    const before = catalogRequests; noSecrets(await connectOfficialServices()); assert.equal(creates, 1); assert(catalogRequests > before);
    const settings = await readFile(path.join(process.env.CCAGENT_HOME!, "settings.json"), "utf8").catch(() => "{}");
    assert(!settings.includes("ccagent:connect-main"), "connect does not silently choose a paid default model");
  });
  await test("two local processes share one connection lock and one newly issued Key", async () => {
    await reset(); const before = creates; createDelay = 500;
    const results = await Promise.all([connectProcess(), connectProcess()]); createDelay = 0;
    assert.equal(creates, before + 1);
    for (const result of results) { assert.equal(result.code, 0, result.output); noSecrets(result.output); assert.equal(JSON.parse(result.output).configured, true); }
  });
  await test("parallel callers reuse the same binding without leaking its secret", async () => {
    await reset(); const before = creates;
    const results = await Promise.all([connectOfficialServices(), connectOfficialServices(), connectOfficialServices()]);
    assert.equal(creates, before + 1); for (const result of results) noSecrets(result);
  });
  await test("catalog validation failure compensates creation and leaves no local credential", async () => {
    await reset(); catalogInvalid = true; const before = revokes;
    await assert.rejects(connectOfficialServices(), error => { noSecrets(String(error)); return true; });
    assert.equal(revokes, before + 1); assert.equal(await readServiceBinding(), null);
  });
  await test("a failed save restores the previous binding and revokes only the newly created Key", async () => {
    await reset(); await connectOfficialServices(); const original = (await readServiceBinding())!;
    const old = [...issued.values()].find(key => key.secret === original.credential.apiKey)!; old.revoked = true;
    const store = serviceCredentialStore(), originalWrite = store.write.bind(store); let failed = false;
    store.write = async value => { await originalWrite(value); if (!failed && value.apiKey !== original.credential.apiKey) { failed = true; throw new Error("synthetic private storage failure"); } };
    const before = revokes;
    try { await assert.rejects(connectOfficialServices(), error => { noSecrets(String(error)); return true; }); }
    finally { store.write = originalWrite; }
    assert(failed); assert.equal(revokes, before + 1); assert.deepEqual(await readServiceBinding(), original);
  });
  await test("another window's manual binding wins over a delayed automatic connection", async () => {
    await reset(); const held = hold(); heldCatalog = held;
    const pending = connectOfficialServices(), refused = assert.rejects(pending, /其他窗口/);
    await held.observed;
    const manual = { id: randomUUID(), owner: fixture.users[0]!.id, secret: "ccagent_" + randomBytes(32).toString("base64url"), revoked: false }; issued.set(manual.id, manual);
    const before = revokes;
    try { await saveOfficialServices({ apiKey: manual.secret, roles: {} }); held.release(); await refused; }
    finally { held.release(); await refused; }
    assert.equal((await readServiceBinding())!.credential.apiKey, manual.secret); assert.equal(manual.revoked, false); assert.equal(revokes, before + 1);
  });
  await test("account switching during creation discards the secret and compensates with the original session", async () => {
    await reset(); const held = hold(); heldCreate = held; const before = revokes;
    const pending = connectOfficialServices(), refused = assert.rejects(pending, /账户/); await held.observed;
    try { await fixture.nativeClient.signIn(fixture.users[1]!.email, fixture.password); held.release(); await refused; }
    finally { held.release(); await refused; }
    assert.equal(revokes, before + 1); assert.equal(await readServiceBinding(), null);
    const beforeCreate = creates; await assert.rejects(connectOfficialServices(), /账户/); assert.equal(creates, beforeCreate);
  });
  await test("service-origin changes during creation never persist the old service Key", async () => {
    await reset(); const held = hold(); heldCreate = held; const before = revokes;
    const pending = connectOfficialServices(), refused = assert.rejects(pending, /服务地址|账户/); await held.observed;
    try { await configurePlatform("http://127.0.0.1:1"); held.release(); await refused; }
    finally { held.release(); await refused; await configurePlatform(fixture.origin); }
    assert.equal(revokes, before + 1); assert.equal(await readServiceBinding(), null);
  });
  await test("an unknown creation result is not retried by subsequent connects", async () => {
    await reset(); dropCreation = true; const before = creates;
    await assert.rejects(connectOfficialServices(), /待核对|核对/); dropCreation = false;
    await assert.rejects(connectOfficialServices(), /核对/); assert.equal(creates, before + 1); assert.equal(await readServiceBinding(), null);
  });
  await test("uncertain compensation blocks duplicate creation and keeps secrets out of errors", async () => {
    await reset(); catalogInvalid = true; rejectRevoke = true; const before = creates;
    await assert.rejects(connectOfficialServices(), error => { noSecrets(String(error)); return /核对/.test(String(error)); });
    catalogInvalid = false; rejectRevoke = false;
    await assert.rejects(connectOfficialServices(), /核对/); assert.equal(creates, before + 1); assert.equal(await readServiceBinding(), null);
  });
  console.log(`Official service connection: ${checks} checks passed (loopback HTTP, DPAPI and cross-process locking; no production Key changes or paid calls).`);
} finally {
  await fixture.close();
  for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  assert.equal(path.dirname(directory), temporaryRoot); assert(path.basename(directory).startsWith("ccagent-service-connect-"));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
