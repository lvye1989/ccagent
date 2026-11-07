import { mkdir, writeFile, utimes } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getSessionPaths } from "../../session/storage.js";

/** Fabricated local records only; never calls a provider or copies user data. */
export async function createLegacyFixture(source: string, workspace: string, externalEnv: string) {
  const previous = process.env.CCAGENT_HOME; process.env.CCAGENT_HOME = source;
  const sessionId = randomUUID(), scheduleId = randomUUID();
  let paths: Awaited<ReturnType<typeof getSessionPaths>>;
  try { paths = await getSessionPaths(workspace, sessionId); }
  finally { if (previous === undefined) delete process.env.CCAGENT_HOME; else process.env.CCAGENT_HOME = previous; }
  const put = async (relative: string, value: string) => {
    const file = path.join(source, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value);
  };
  const key = "fixture-legacy-provider-credential", clientId = "fixture-google-client-id", clientSecret = "fixture-google-secret";
  const settings = {
    language: "Chinese", mode: "full", hooks: { SessionStart: "DO_NOT_EXECUTE" }, cleanupPeriodDays: 0,
    env: { CCAGENT_ENV_FILE: externalEnv, SOURCE_KEY: "stale-settings-key", EXISTING_VALUE: "source-value" },
    models: {
      legacy: { protocol: "openai-chat", model: "legacy-fixture", baseURL: "https://example.invalid/v1", apiKey: "${SOURCE_KEY}" },
      conflict: { protocol: "openai-chat", model: "source-conflict", baseURL: "https://example.invalid/v1", apiKey: "inline-conflict" },
      local: { protocol: "openai-chat", model: "local-fixture", baseURL: "http://127.0.0.1:12345/v1", apiKey: "" },
      edited: { protocol: "openai-chat", model: "source-editable", baseURL: "https://example.invalid/v1", apiKey: "${SOURCE_KEY}", headers: { "x-vendor-credential": "fixture-header-private" } },
    },
    modelRoles: { image: "legacy" },
    mcpServers: { google: { type: "http", url: "https://example.invalid/mcp", oauth: { provider: "google", clientIdEnv: "GOOGLE_CLIENT_ID", clientSecretEnv: "GOOGLE_CLIENT_SECRET", redirectUri: "http://127.0.0.1:12346/callback" } } },
    ragConnections: [{ id: "legacy-rag", name: "Legacy RAG", url: "https://example.invalid/retrieve", apiKey: "inline-rag-fixture", enabled: true }],
    agentTeamPresets: [{ id: "legacy-team", name: "Legacy team", description: "Fixture", enabled: true, roles: [] }],
  };
  await put("settings.json", JSON.stringify(settings));
  await put(".env", "SOURCE_KEY=stale-root-key\n");
  await put("web-secrets.env", "CCAGENT_WEB_KEY_LEGACY=fixture-nested-reference\n");
  await mkdir(path.dirname(externalEnv), { recursive: true });
  await writeFile(externalEnv, `SOURCE_KEY=${key}\nDEEPSEEK_API_KEY=fixture-canonical-deepseek\nGOOGLE_CLIENT_ID=${clientId}\nGOOGLE_CLIENT_SECRET=${clientSecret}\nEXISTING_VALUE=source-canonical-value\nNESTED_KEY=\${CCAGENT_WEB_KEY_LEGACY}\nCCAGENT_HOME=must-not-import\nNODE_TLS_REJECT_UNAUTHORIZED=0\nDATABASE_URL=must-not-import\n`);
  await put("oauth/google-workspace/google.json", JSON.stringify({ access_token: "fixture-oauth-access", refresh_token: "fixture-oauth-refresh", token_type: "Bearer" }));
  await put("AGENT.md", "Original account instructions\n");
  await put("agents/file-name.md", "---\nname: actual-agent-name\ndescription: Fixture agent\n---\nReview local text.\n");
  await put("skills/folder-name/SKILL.md", "---\nname: actual-skill-name\ndescription: Fixture skill\n---\nReview local text.\n");
  await put("skills/folder-name/node_modules/cache.txt", "DO_NOT_COPY_CACHE");
  await put("rhino/library.json", "{\"fixture\":true}");
  await put("web-schedules.json", JSON.stringify([{ id: scheduleId, workspace, title: "Imported schedule", prompt: "/help", model: "local", mode: "full", repeat: "daily", createdAt: "2000-01-01T00:00:00Z", nextRunAt: "2000-01-01T00:00:00Z", status: "running", runOwner: { pid: 1 }, runId: randomUUID() }]));
  await put("workfriend/schedules.json", JSON.stringify({ version: 1, schedules: [{ id: randomUUID(), cwd: workspace, workdayEnd: "18:00", workSummary: "Fixture", moodSummary: "Fixture", createdAt: "2000-01-01T00:00:00Z", checkInAt: "2000-01-01T00:00:00Z", status: "pending" }] }));
  await mkdir(paths.projectDir, { recursive: true });
  const messages = [
    { type: "session_meta", sessionId, cwd: workspace, startedAt: "2000-01-01T00:00:00Z", model: "local" },
    { type: "message", timestamp: "2000-01-01T00:00:00Z", role: "user", message: { role: "user", content: "LEGACY_HISTORY_PRIVATE" } },
    { type: "message", timestamp: "2000-01-01T00:00:01Z", role: "assistant", message: { role: "assistant", content: "Legacy answer" } },
  ].map(item => JSON.stringify(item)).join("\n") + "\n";
  await writeFile(paths.transcriptPath, messages); await writeFile(paths.latestPath, sessionId);
  await utimes(paths.transcriptPath, new Date("2000-01-01"), new Date("2000-01-01"));
  await put("state.json", "{\"trust\":\"DO_NOT_IMPORT\"}");
  await put("platform/not-a-session.json", "DO_NOT_IMPORT_AUTH");
  return { sessionId, scheduleId, key, clientId, clientSecret, transcript: paths.transcriptPath, messages };
}
