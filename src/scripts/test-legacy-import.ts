import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink, realpath, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { previewLegacyData, importLegacyData } from "../platform/legacyData.js";
import { startAccountFixture } from "./helpers/accountFixture.js";
import { createLegacyFixture } from "./helpers/legacyFixture.js";
import { enterPlatformAccount } from "../platform/account.js";
import { getCCAgentHome } from "../utils/paths.js";
import { restoreSession, getSessionPaths, applySessionRetentionPolicy, configureSessionPersistence } from "../session/storage.js";
import { loadEnv } from "../utils/loadEnv.js";
import { resetSettingsCache } from "../config/sources.js";
import { resolveProfile, resolveModelRole } from "../services/api/providers/profile.js";
import { handleCustomization } from "../entrypoint/webCustomization.js";
import { runAccountCommand } from "../entrypoint/account.js";
import { GoogleWorkspaceOAuthProvider } from "../services/mcp/googleOAuth.js";
import { bootstrapSkillStates, isSkillEnabled } from "../services/skills/preferences.js";
import { bootstrapAgentStates, isAgentEnabled } from "../agents/preferences.js";
import { storeWebSecret } from "../utils/webSecrets.js";
import { updateUserSettings } from "../utils/settings.js";

const previous = { ...process.env }, originalCwd = process.cwd();
const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "ccagent-import-test-")));
// Keep os.tmpdir's native spelling (often Windows 8.3) for the platform home.
const base = path.join(os.tmpdir(), path.basename(temp), "home"), workspace = path.join(temp, "workspace"), external = path.join(temp, "external", "provider.env");
await mkdir(workspace); await mkdir(base);
process.env.CCAGENT_HOME = base; process.env.CCAGENT_PLATFORM_HOME = base;
for (const name of ["CCAGENT_ACCOUNT_ID", "CCAGENT_AUTH_SESSION_FILE", "CCAGENT_ENV_FILE", "CCAGENT_CLOUD_URL", "NODE_TLS_REJECT_UNAUTHORIZED"]) delete process.env[name];
const fixture = await startAccountFixture(base), legacy = await createLegacyFixture(base, path.join(os.tmpdir(), path.basename(temp), "workspace"), external);
const read = async (file: string) => JSON.parse(await readFile(file, "utf8")) as any;
const exists = async (file: string) => stat(file).then(() => true, () => false);
let passed = 0;
async function test(name: string, run: () => Promise<void>) { await run(); passed++; console.log(`PASS ${name}`); }
const context = { workspace, defaultModel: "conflict" };
const apply = (preview: Awaited<ReturnType<typeof previewLegacyData>>, categories = ["configuration", "history", "extensions"], environmentFiles: string[] = [], enableHistory = false) => importLegacyData({ id: preview.id, categories, environmentFiles, enableHistory, confirmOwned: true });
let home = "", preview: Awaited<ReturnType<typeof previewLegacyData>>;
try {
  await test("anonymous preview cannot read source or create account imports", async () => {
    await assert.rejects(() => previewLegacyData(base));
  });
  await fixture.nativeClient.signIn(fixture.users[0]!.email, fixture.password); home = (await enterPlatformAccount()).home;
  const settingsFile = path.join(home, "settings.json");
  await writeFile(settingsFile, JSON.stringify({ language: "English", mode: "default", models: { conflict: { protocol: "openai-chat", model: "target-conflict", baseURL: "https://example.invalid/v1", apiKey: "target-owned-fixture" } }, env: { EXISTING_VALUE: "target-value" } }));
  await writeFile(path.join(home, "AGENT.md"), "Existing account instructions\n");
  await test("preview contains counts and paths, excludes secrets, prompt bodies, caches and identity data", async () => {
    preview = await previewLegacyData(base);
    const output = JSON.stringify(preview), plan = await read(path.join(home, "imports", "plans", preview.id + ".json"));
    for (const secret of [legacy.key, legacy.clientSecret, "LEGACY_HISTORY_PRIVATE", "fixture-oauth-access"]) assert.equal(output.includes(secret) || JSON.stringify(plan).includes(secret), false);
    assert.equal(preview.skippedCaches, 1); assert.equal(preview.executionFields, 2);
    assert.equal(preview.environmentFiles.filter(item => item.external).length, 1);
    assert.ok(!plan.entries.some((item: any) => item.relative.startsWith("platform/") || item.relative === "state.json" || item.relative.startsWith("accounts/")));
  });
  await test("ownership, unknown categories, environment approvals and cross-account sources are rejected", async () => {
    await assert.rejects(() => importLegacyData({ id: preview.id, categories: ["history"], environmentFiles: [], confirmOwned: false }));
    await assert.rejects(() => apply(preview, ["unknown"]));
    await assert.rejects(() => apply(preview, ["history"], ["foreign-environment"]));
    await assert.rejects(() => previewLegacyData(home));
  });
  let report: Awaited<ReturnType<typeof importLegacyData>>;
  await test("selected data imports without overwrites, credentials, trust or automatic executions", async () => {
    report = await apply(preview);
    assert.equal(report.state, "complete"); assert.ok(report.copied > 5); assert.ok(report.conflicts > 0); assert.ok(report.missingCredentials > 0);
    const settings = await read(settingsFile);
    assert.equal(settings.language, "English"); assert.equal(settings.mode, "default"); assert.equal(settings.hooks, undefined); assert.equal(settings.cleanupPeriodDays, undefined);
    assert.equal(settings.models.conflict.model, "target-conflict"); assert.equal(settings.env.EXISTING_VALUE, "target-value");
    assert.equal(settings.models.legacy.disabled, true); assert.equal(settings.models.local.disabled, undefined);
    assert.equal(JSON.stringify(settings).includes("fixture-header-private"), false);
    assert.equal(settings.mcpServerStates.google, "close"); assert.equal(settings.ragConnections[0].enabled, false); assert.equal(settings.agentTeamPresets[0].enabled, false);
    assert.equal(await exists(path.join(home, "oauth")), false); assert.equal(await exists(path.join(home, "state.json")), false);
    assert.equal(await readFile(path.join(home, "AGENT.md"), "utf8"), "Existing account instructions\n");
    assert.equal(await exists(path.join(home, "skills", "folder-name", "node_modules")), false);
    const schedule = (await read(path.join(home, "web-schedules.json")))[0];
    assert.equal(schedule.status, "paused"); assert.equal(schedule.mode, "default"); assert.equal(schedule.runOwner, undefined); assert.equal(schedule.runId, undefined);
    assert.equal((await read(path.join(home, "workfriend", "schedules.json"))).schedules[0].status, "cancelled");
  });
  await test("session history restores through the real store and survives default retention", async () => {
    const paths = await getSessionPaths(workspace, legacy.sessionId);
    assert.equal(await readFile(paths.transcriptPath, "utf8"), legacy.messages);
    assert.ok((await stat(paths.transcriptPath)).mtimeMs > Date.now() - 60_000);
    await applySessionRetentionPolicy(workspace);
    const restored = await restoreSession(workspace, legacy.sessionId);
    assert.equal(restored.messages.length, 2); assert.equal(restored.messages[0]!.content, "LEGACY_HISTORY_PRIVATE");
    assert.equal(await readFile(legacy.transcript, "utf8"), legacy.messages);
  });
  await test("disabled profiles are editable, cannot fall back and named extensions stay closed", async () => {
    await assert.rejects(() => resolveProfile("legacy", workspace), /尚未启用/);
    await assert.rejects(() => resolveModelRole(["image"], workspace), /尚未启用/);
    const view = await handleCustomization("models", "GET", {}, context) as any;
    assert.equal(view.models.find((item: any) => item.id === "legacy").setupRequired, true);
    assert.equal(JSON.stringify(view).includes("target-owned-fixture"), false);
    await assert.rejects(() => handleCustomization("models", "POST", { id: "legacy", protocol: "openai-chat", model: "legacy-fixture", baseURL: "https://example.invalid/v1" }, context), /API Key/);
    await bootstrapSkillStates(); await bootstrapAgentStates();
    assert.equal(isSkillEnabled("actual-skill-name"), false); assert.equal(isAgentEnabled("actual-agent-name"), false);
    const settings = await read(settingsFile); settings.models.edited.model = "manually-edited";
    await updateUserSettings({ models: settings.models });
  });
  await test("same plan replay is stable and cannot be reused with different selections", async () => {
    assert.deepEqual(await apply(preview), report!);
    await assert.rejects(() => apply(preview, ["credentials"]), /其他选择/);
    assert.equal((await read(path.join(home, "web-schedules.json"))).length, 1);
  });
  await test("unapproved external canonical environment never falls back to a stale source key", async () => {
    const next = await previewLegacyData(base); await apply(next, ["configuration", "credentials"]);
    const settings = await read(settingsFile); assert.equal(settings.models.legacy.disabled, true);
    assert.equal(settings.env.SOURCE_KEY, undefined);
    const secrets = await readFile(path.join(home, "web-secrets.env"), "utf8");
    assert.equal(secrets.includes("stale-root-key") || secrets.includes("stale-settings-key"), false);
  });
  await test("approved credentials repair only unchanged pending models and load through native resolvers", async () => {
    const next = await previewLegacyData(base); await apply(next, ["configuration", "credentials"], next.environmentFiles.filter(item => item.external).map(item => item.id));
    const settings = await read(settingsFile);
    assert.equal(settings.models.legacy.disabled, undefined); assert.equal(settings.models.conflict.model, "target-conflict");
    assert.equal(settings.models.edited.model, "manually-edited"); assert.equal(settings.models.edited.disabled, true);
    assert.equal(JSON.stringify(settings).includes(legacy.key) || JSON.stringify(settings).includes(legacy.clientSecret), false);
    assert.equal(settings.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined); assert.equal(settings.env.DATABASE_URL, undefined); assert.equal(settings.env.CCAGENT_HOME, undefined);
    process.chdir(workspace); await loadEnv(); resetSettingsCache();
    assert.equal((await resolveProfile("legacy", workspace)).apiKey, legacy.key);
    assert.equal(process.env.EXISTING_VALUE, "target-value"); assert.equal(process.env.NESTED_KEY, "fixture-nested-reference");
    assert.equal(process.env.DEEPSEEK_API_KEY, "fixture-canonical-deepseek");
    const oauth = new GoogleWorkspaceOAuthProvider("google", settings.mcpServers.google.oauth);
    assert.equal(oauth.clientInformation().client_id, legacy.clientId);
    assert.equal(oauth.clientInformation().client_secret, legacy.clientSecret);
    assert.equal((await oauth.tokens())?.refresh_token, "fixture-oauth-refresh");
    const stored = await readFile(settings.env.CCAGENT_ENV_FILE, "utf8");
    assert.equal(stored.includes("EXISTING_VALUE"), false);
  });
  await test("existing canonical path and concurrent preference and secret writes are preserved", async () => {
    const current = await read(settingsFile), canonicalPath = current.env.CCAGENT_ENV_FILE;
    const next = await previewLegacyData(base); await apply(next, ["credentials"], next.environmentFiles.filter(item => item.external).map(item => item.id));
    assert.equal((await read(settingsFile)).env.CCAGENT_ENV_FILE, canonicalPath);
    await Promise.all(Array.from({ length: 8 }, (_, index) => updateUserSettings({ ["concurrent" + index]: index })));
    await Promise.all(Array.from({ length: 8 }, (_, index) => storeWebSecret("concurrent:" + index, "fixture-concurrent-" + index)));
    const after = await read(settingsFile), secrets = await readFile(path.join(home, "web-secrets.env"), "utf8");
    for (let index = 0; index < 8; index++) { assert.equal(after["concurrent" + index], index); assert.equal(secrets.includes("fixture-concurrent-" + index), true); }
  });
  await test("changed source is rejected and staging is cleaned before new data is exposed", async () => {
    const changed = path.join(base, "plans", "changed.txt"); await mkdir(path.dirname(changed), { recursive: true }); await writeFile(changed, "before");
    const next = await previewLegacyData(base); await writeFile(changed, "changed-after-preview");
    await assert.rejects(() => apply(next, ["history"]));
    assert.equal(await exists(path.join(home, "plans", "changed.txt")), false);
    assert.equal(await exists(path.join(home, "imports", "staging", next.id)), false);
  });
  await test("source links are skipped and destination junctions cannot escape the account", async () => {
    const outside = path.join(temp, "outside"); await mkdir(outside); await writeFile(path.join(outside, "sentinel"), "preserve");
    await symlink(outside, path.join(base, "agents", "linked-folder"), "junction");
    const next = await previewLegacyData(base); assert.equal(next.skippedLinks, 1);
    await mkdir(path.join(base, "file-history"), { recursive: true }); await writeFile(path.join(base, "file-history", "test.txt"), "source");
    await symlink(outside, path.join(home, "file-history"), "junction");
    await assert.rejects(() => applyNext());
    async function applyNext() { return apply(await previewLegacyData(base), ["history"]); }
    assert.equal(await exists(path.join(outside, "test.txt")), false); assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "preserve");
    await rm(path.join(home, "file-history"));
  });
  await test("disabled history requires explicit retention consent and source zero is never inherited", async () => {
    await updateUserSettings({ cleanupPeriodDays: 0 });
    const next = await previewLegacyData(base); assert.equal(next.historyDisabled, true);
    await assert.rejects(() => apply(next, ["history"])); assert.equal((await read(settingsFile)).cleanupPeriodDays, 0);
    const enabled = await previewLegacyData(base); await apply(enabled, ["history"], [], true);
    assert.equal((await read(settingsFile)).cleanupPeriodDays, 30);
  });
  await test("malformed source configuration does not prevent history import; malformed target is retained", async () => {
    const sourceFile = path.join(base, "settings.json"), original = await readFile(sourceFile, "utf8"); await writeFile(sourceFile, "invalid-json");
    const next = await previewLegacyData(base); assert.equal(next.configurationError, true);
    await assert.rejects(() => apply(next, ["configuration"])); assert.equal((await apply(next, ["history"])).state, "complete");
    await writeFile(sourceFile, original);
    const targetOriginal = await readFile(settingsFile, "utf8"); await writeFile(settingsFile, "target-invalid-json");
    await assert.rejects(() => previewLegacyData(base)); assert.equal(await readFile(settingsFile, "utf8"), "target-invalid-json");
    await writeFile(settingsFile, targetOriginal);
  });
  await test("CLI preview does not prompt; declined import is inert and confirmed import succeeds", async () => {
    let output = ""; const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    const unexpected = { async ask() { throw new Error("Unexpected prompt"); }, async secret() { throw new Error("Unexpected secret prompt"); }, close() {} };
    assert.equal(await runAccountCommand(["import-preview", "--source", base], { output: stream, prompter: unexpected }), 0);
    const answers = ["history", "no", "history", "yes"], prompter = { ...unexpected, async ask() { return answers.shift()!; } };
    assert.equal(await runAccountCommand(["import", "--source", base], { output: stream, prompter }), 0);
    assert.match(output, /未开始导入/);
    assert.equal(await runAccountCommand(["import", "--source", base], { output: stream, prompter }), 0);
    assert.equal(output.includes(legacy.key) || output.includes("LEGACY_HISTORY_PRIVATE"), false);
  });
  await test("plan from account A cannot be replayed or sourced by account B", async () => {
    const next = await previewLegacyData(base), homeA = home;
    delete process.env.CCAGENT_ACCOUNT_ID; process.env.CCAGENT_HOME = base;
    await fixture.nativeClient.signIn(fixture.users[1]!.email, fixture.password); await enterPlatformAccount();
    await assert.rejects(() => apply(next, ["history"])); await assert.rejects(() => previewLegacyData(homeA));
    assert.equal(await exists(path.join(getCCAgentHome(), "projects")), false);
  });
  console.log(`Legacy data import: ${passed} checks passed. Fixture-only; no user data or provider requests.`);
} finally {
  await fixture.close(); process.chdir(originalCwd); configureSessionPersistence(true); resetSettingsCache();
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  for (const [key, value] of Object.entries(previous)) if (value !== undefined) process.env[key] = value;
  const parent = await realpath(os.tmpdir());
  if (path.dirname(temp) !== parent || !path.basename(temp).startsWith("ccagent-import-test-")) throw new Error("Unsafe fixture cleanup");
  // Remove the fixture junction before its target: concurrent recursive removal
  // can leave a dangling Windows junction and retry its parent indefinitely.
  await unlink(path.join(base, "agents", "linked-folder")).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  // A bounded retry accommodates Windows handles on the just-written import tree.
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
