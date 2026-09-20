#!/usr/bin/env tsx

import { checkPermission, type PermissionSettings } from "../permissions/permissions.js";
import {
  buildClassicWordsRequest,
  createClassicWordsTool,
} from "../tools/classicWordsTool.js";
import { findToolByName } from "../tools/index.js";
import { toolResultText } from "../tools/Tool.js";

const failures: string[] = [];

function assert(condition: unknown, label: string): void {
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}`);
  if (!condition) failures.push(label);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function main(): Promise<void> {
  console.log("\n[1] Tool registration and permissions");
  const registered = findToolByName("classic_words");
  assert(registered?.name === "classic_words", "classic_words is registered as a built-in tool");
  assert(registered?.isReadOnly() === true, "classic_words is read-only");
  assert(registered?.isConcurrencySafe?.() === true, "classic_words is concurrency-safe");

  const settings: PermissionSettings = { allow: [], deny: [], mode: "plan" };
  const permission = await checkPermission({
    tool: registered!,
    input: { action: "search_writings", query: "黄鹤楼" },
    cwd: process.cwd(),
    mode: "plan",
    settings,
  });
  assert(permission.behavior === "allow", "classic_words is allowed in Plan Mode");

  console.log("\n[2] Request construction and validation");
  const request = buildClassicWordsRequest(
    {
      action: "search_writings",
      query: "黄鹤楼",
      exact_match: true,
      clause_index: "title",
      page: 2,
      language: "traditional",
    },
    "https://api.cnkgraph.com",
  );
  const requestBody = JSON.parse(String(request.init.body)) as Record<string, unknown>;
  const requestHeaders = new Headers(request.init.headers);
  assert(
    request.url === "https://api.cnkgraph.com/api/writing/find" && request.init.method === "POST",
    "search_writings maps to POST /api/writing/find",
  );
  assert(
    requestBody.key === "黄鹤楼" && requestBody.exactlyMatch === true && requestBody.pageNo === 2,
    "search fields map to the CNKGraph request body",
  );
  assert(requestHeaders.get("accept-language") === "zh-hant", "traditional mode sends Accept-Language: zh-hant");

  const volume = buildClassicWordsRequest(
    { action: "get_volume", volume_id: "KR4h0140_024" },
    "https://api.cnkgraph.com",
  );
  assert(
    volume.url === "https://api.cnkgraph.com/api/book/volume/KR4h0140_024",
    "get_volume safely maps the volume id into the URL",
  );

  let invalidRejected = false;
  try {
    buildClassicWordsRequest({ action: "search_writings" }, "https://api.cnkgraph.com");
  } catch {
    invalidRejected = true;
  }
  assert(invalidRejected, "search_writings rejects an empty search instead of sending a broad request");

  console.log("\n[3] Response validation, limiting, and error isolation");
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> = {};
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({
      WritingCount: 3,
      Writings: [
        { Id: 1, Title: "黄鹤楼" },
        { Id: 2, Title: "登黄鹤楼" },
        { Id: 3, Title: "第三条应被裁剪" },
      ],
    });
  }) as typeof fetch;
  const tool = createClassicWordsTool(mockFetch);
  const result = await tool.call(
    { action: "search_writings", query: "黄鹤楼", max_results: 2 },
    { cwd: process.cwd() },
  );
  const resultText = toolResultText(result.content);
  assert(!result.isError, "valid JSON response succeeds");
  assert(
    capturedUrl === "https://api.cnkgraph.com/api/writing/find" && capturedBody.key === "黄鹤楼",
    "tool sends the expected direct CNKGraph REST request",
  );
  assert(
    resultText.includes("黄鹤楼") && resultText.includes("登黄鹤楼") && !resultText.includes("第三条应被裁剪"),
    "major result arrays are limited by max_results",
  );
  assert(resultText.includes("Source API:"), "result preserves source traceability");

  let fetchCount = 0;
  const neverFetch = (async () => {
    fetchCount += 1;
    return jsonResponse({});
  }) as typeof fetch;
  const invalidResult = await createClassicWordsTool(neverFetch).call(
    { action: "search_books", query: "" },
    { cwd: process.cwd() },
  );
  assert(invalidResult.isError === true && fetchCount === 0, "invalid input is isolated before network I/O");

  const htmlTool = createClassicWordsTool((async () => new Response("<html>error</html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  })) as typeof fetch);
  const htmlResult = await htmlTool.call(
    { action: "get_writing", writing_id: 10000 },
    { cwd: process.cwd() },
  );
  assert(htmlResult.isError === true, "non-JSON upstream response becomes a contained tool error");

  const failureTool = createClassicWordsTool((async () => jsonResponse({ message: "upstream" }, 503)) as typeof fetch);
  const failureResult = await failureTool.call(
    { action: "get_person", person_id: 15188 },
    { cwd: process.cwd() },
  );
  assert(failureResult.isError === true, "HTTP failure becomes a contained tool error");

  const primitiveTool = createClassicWordsTool((async () => jsonResponse("unexpected")) as typeof fetch);
  const primitiveResult = await primitiveTool.call(
    { action: "get_writing", writing_id: 10000 },
    { cwd: process.cwd() },
  );
  assert(primitiveResult.isError === true, "unexpected JSON shape becomes a contained tool error");

  const savedTimeout = process.env.CLASSIC_WORDS_TIMEOUT_MS;
  process.env.CLASSIC_WORDS_TIMEOUT_MS = "10";
  try {
    const hangingTool = createClassicWordsTool(((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch);
    const timeoutResult = await hangingTool.call(
      { action: "get_writing", writing_id: 10000 },
      { cwd: process.cwd() },
    );
    assert(
      timeoutResult.isError === true && toolResultText(timeoutResult.content).includes("timed out"),
      "a hung upstream request is aborted at the configured timeout",
    );
  } finally {
    if (savedTimeout === undefined) delete process.env.CLASSIC_WORDS_TIMEOUT_MS;
    else process.env.CLASSIC_WORDS_TIMEOUT_MS = savedTimeout;
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} classic_words test(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log("\nAll classic_words tests passed.");
}

await main();
