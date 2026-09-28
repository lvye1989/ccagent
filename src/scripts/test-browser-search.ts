#!/usr/bin/env tsx

import assert from "node:assert/strict";
import {
  browserSearchTool,
  createBrowserSearchTool,
  grantBrowserSearchExecution,
  prepareBrowserSearchInput,
  preflightBrowserSearchWithJev,
  revokeBrowserSearchExecution,
  validateBrowserSearchInput,
  type BrowserSearchRuntime,
} from "../tools/browserSearchTool.js";
import {
  buildBrowserSearchJevRequest,
  interpretBrowserSearchJevResponse,
  type BrowserSearchJevDecision,
} from "../tools/browserSearchJev.js";
import { BROWSER_SEARCH_FAST_PATH_GUIDANCE } from "../tools/computerUseGuidance.js";
import { getAllTools } from "../tools/index.js";
import { summarizeTool } from "../ui/utils/toolCardFormat.js";
import type { ToolContext } from "../tools/Tool.js";

function pass(label: string): void {
  console.log(`  [PASS] ${label}`);
}

function ordinaryDecision(): BrowserSearchJevDecision {
  return {
    configured: true,
    available: true,
    mode: "enforce",
    model: "typesafe/jev-test",
    disposition: "execute",
    risk: "ordinary_search",
    dispositionConfidence: 0.99,
    goalAlignmentProbability: 0.98,
    destinationValidityProbability: 0.99,
    publicQuerySafetyProbability: 0.99,
    permissionBehavior: "allow",
    summary: "fixture ordinary allow",
  };
}

async function main(): Promise<void> {
  console.log("\n[1] Deterministic input validation and URL allowlist");
  const chinese = prepareBrowserSearchInput({
    action: "search",
    engine: "baidu",
    query: "马斯克 最新消息 & SpaceX",
  });
  assert.equal(chinese.destinationHost, "www.baidu.com");
  assert.equal(new URL(chinese.canonicalUrl).pathname, "/s");
  assert.equal(new URL(chinese.canonicalUrl).searchParams.get("wd"), "马斯克 最新消息 & SpaceX");
  assert.ok(!chinese.canonicalUrl.includes(" "));
  pass("Chinese and reserved query characters are encoded through URLSearchParams");

  const expectedEngines = new Map([
    ["baidu", ["www.baidu.com", "/s", "wd"]],
    ["bing", ["www.bing.com", "/search", "q"]],
    ["google", ["www.google.com", "/search", "q"]],
    ["duckduckgo", ["duckduckgo.com", "/", "q"]],
  ]);
  for (const [engine, [host, pathname, key]] of expectedEngines) {
    const plan = prepareBrowserSearchInput({ action: "search", engine, query: "safe test" });
    const url = new URL(plan.canonicalUrl);
    assert.equal(url.hostname, host);
    assert.equal(url.pathname, pathname);
    assert.equal(url.searchParams.get(key!), "safe test");
  }
  pass("All search engines use immutable host/path/parameter templates");

  assert.match(validateBrowserSearchInput({ action: "search", engine: "evil", query: "test" }) ?? "", /engine must/);
  assert.match(validateBrowserSearchInput({ action: "search", engine: "constructor", query: "test" }) ?? "", /engine must/);
  assert.match(validateBrowserSearchInput({ action: "open_url", url: "javascript:alert(1)" }) ?? "", /Only HTTPS/);
  assert.match(validateBrowserSearchInput({ action: "open_url", url: "file:///C:/secret.txt" }) ?? "", /Only HTTPS/);
  assert.match(validateBrowserSearchInput({ action: "open_url", url: "https://user:pass@example.com/" }) ?? "", /credentials/);
  assert.match(validateBrowserSearchInput({ action: "open_url", url: "http://example.com/" }) ?? "", /requires HTTPS/);
  assert.equal(validateBrowserSearchInput({ action: "open_url", url: "http://127.0.0.1:3000/" }), null);
  assert.match(validateBrowserSearchInput({ action: "search", engine: "bing", query: "x", url: "https://example.com" }) ?? "", /not allowed/);
  pass("Custom engines, unsafe schemes, credentials, public HTTP, and mixed action fields are rejected");

  console.log("\n[2] Typed Jev request and conservative thresholds");
  const direct = prepareBrowserSearchInput({
    action: "open_url",
    url: "https://example.com/news?token=must-not-leak&lang=zh",
  });
  const request = buildBrowserSearchJevRequest(direct, "Open the example news page");
  const serialized = JSON.stringify(request);
  assert.ok(serialized.includes("token") && serialized.includes("lang"));
  assert.ok(!serialized.includes("must-not-leak"));
  pass("Direct URL query keys reach Jev but caller-supplied values are withheld");

  const allowed = interpretBrowserSearchJevResponse({
    model: "typesafe/jev-test",
    attempts: 1,
    answers: {
      disposition: { type: "choice", choice: "execute", confidence: 0.99 },
      risk: { type: "choice", choice: "ordinary_search", confidence: 0.99 },
      goal_aligned: { type: "noul", noul: 0.98 },
      destination_valid: { type: "noul", noul: 0.99 },
      public_query_safe: { type: "noul", noul: 0.99 },
    },
  }, { mode: "enforce", model: "fixture", minConfidence: 0.8 });
  assert.equal(allowed.permissionBehavior, "allow");
  const uncertain = interpretBrowserSearchJevResponse({
    model: "typesafe/jev-test",
    answers: {
      disposition: { type: "choice", choice: "execute", confidence: 0.7 },
      risk: { type: "choice", choice: "ordinary_search", confidence: 0.8 },
      goal_aligned: { type: "noul", noul: 0.9 },
      destination_valid: { type: "noul", noul: 0.85 },
      public_query_safe: { type: "noul", noul: 0.9 },
    },
  }, { mode: "enforce", model: "fixture", minConfidence: 0.8 });
  assert.equal(uncertain.permissionBehavior, "ask");
  assert.equal(uncertain.requiresFallbackReview, undefined);
  const misaligned = interpretBrowserSearchJevResponse({
    model: "typesafe/jev-test",
    answers: {
      disposition: { type: "choice", choice: "deny", confidence: 0.99 },
      risk: { type: "choice", choice: "misaligned", confidence: 0.99 },
      goal_aligned: { type: "noul", noul: 0.02 },
      destination_valid: { type: "noul", noul: 0.99 },
      public_query_safe: { type: "noul", noul: 0.99 },
    },
  }, { mode: "enforce", model: "fixture", minConfidence: 0.8 });
  assert.equal(misaligned.forceDeny, true);
  pass("Only complete high-confidence ordinary evidence auto-allows; uncertainty asks and misalignment denies");

  console.log("\n[3] One-time central grant and hermetic execution");
  const opened: string[] = [];
  let indicators = 0;
  let listCalls = 0;
  const runtime: BrowserSearchRuntime = {
    openExternalUrl: async (url) => { opened.push(url); return true; },
    listWindows: async () => {
      listCalls++;
      return [{ id: "1", processId: 1, processName: "chrome", title: "fixture" }];
    },
    ensureIndicator: async () => { indicators++; },
    wait: async () => {},
  };
  const tool = createBrowserSearchTool(runtime);
  const input = { action: "search", engine: "baidu", query: "黄仁勋 最新消息" };
  const context: ToolContext = { cwd: process.cwd(), sessionId: "browser-search-test", toolUseId: "call-1" };
  const ungranted = await tool.call(input, context);
  assert.equal(ungranted.isError, true);
  assert.equal(opened.length, 0);
  pass("Direct tool invocation cannot bypass the central grant");

  grantBrowserSearchExecution("call-1", input, ordinaryDecision(), {
    finalPermission: "auto_allowed",
    sessionId: context.sessionId,
  });
  const executed = await tool.call(input, context);
  assert.equal(executed.isError, undefined);
  assert.equal(opened.length, 1);
  assert.equal(indicators, 1);
  assert.equal(listCalls, 1);
  assert.match(String(executed.content), /launch_status=accepted/);
  assert.match(String(executed.content), /page_load=not independently verified/);
  pass("A granted call performs one opener call and one local window-metadata check only");

  const replay = await tool.call(input, context);
  assert.equal(replay.isError, true);
  assert.equal(opened.length, 1);
  pass("The exact-input grant is single-use and cannot be replayed");

  grantBrowserSearchExecution("call-tamper", input, ordinaryDecision(), {
    finalPermission: "auto_allowed",
    sessionId: context.sessionId,
  });
  const tampered = await tool.call({ ...input, query: "different query" }, { ...context, toolUseId: "call-tamper" });
  assert.equal(tampered.isError, true);
  assert.equal(opened.length, 1);
  revokeBrowserSearchExecution("call-tamper");
  pass("Changing the input after review invalidates the grant");

  const unavailable: BrowserSearchJevDecision = {
    configured: true,
    available: false,
    mode: "enforce",
    model: "fixture",
    requiresFallbackReview: true,
    summary: "fixture timeout",
  };
  assert.throws(
    () => grantBrowserSearchExecution("fallback-no-review", input, unavailable, {
      finalPermission: "full_access",
      sessionId: context.sessionId,
    }),
    /independent fallback/,
  );
  grantBrowserSearchExecution("fallback-reviewed", input, unavailable, {
    finalPermission: "auto_allowed",
    independentlyReviewed: true,
    sessionId: context.sessionId,
  });
  const fallback = await tool.call(input, { ...context, toolUseId: "fallback-reviewed" });
  assert.equal(fallback.isError, undefined);
  assert.equal(opened.length, 2);
  pass("Jev outage keeps the operation intact but requires an explicit independent review");

  for (const invalidPermission of ["ask", "user_denied"] as const) {
    assert.throws(
      () => grantBrowserSearchExecution(`invalid-${invalidPermission}`, input, ordinaryDecision(), {
        finalPermission: invalidPermission,
        sessionId: context.sessionId,
      }),
      /final allow decision/,
    );
  }
  pass("Non-final ask and user_denied traces cannot mint an execution grant");

  grantBrowserSearchExecution("cross-session", input, ordinaryDecision(), {
    finalPermission: "auto_allowed",
    sessionId: context.sessionId,
  });
  const wrongSession = await tool.call(input, {
    ...context,
    sessionId: "different-browser-search-session",
    toolUseId: "cross-session",
  });
  assert.equal(wrongSession.isError, true);
  assert.equal(opened.length, 2);
  const rightSession = await tool.call(input, { ...context, toolUseId: "cross-session" });
  assert.equal(rightSession.isError, undefined);
  assert.equal(opened.length, 3);
  pass("A different session cannot consume or invalidate another session's grant");

  const abortController = new AbortController();
  grantBrowserSearchExecution("abort-before-consume", input, ordinaryDecision(), {
    finalPermission: "auto_allowed",
    sessionId: context.sessionId,
  });
  abortController.abort();
  const cancelled = await tool.call(input, {
    ...context,
    abortSignal: abortController.signal,
    toolUseId: "abort-before-consume",
  });
  assert.equal(cancelled.isError, true);
  assert.equal(opened.length, 3);
  const afterCancellation = await tool.call(input, { ...context, toolUseId: "abort-before-consume" });
  assert.equal(afterCancellation.isError, undefined);
  assert.equal(opened.length, 4);
  pass("Cancellation is checked before the one-time grant is consumed");

  const secretInput = { action: "search", engine: "bing", query: "token=super-private-value" };
  const secretDecision = await preflightBrowserSearchWithJev(
    secretInput,
    { cwd: process.cwd(), sessionId: "browser-search-secret-test" },
    [{ role: "user", content: "Search for the token text" }],
  );
  assert.equal(secretDecision.permissionBehavior, "ask");
  assert.equal(secretDecision.available, false);
  assert.equal(secretDecision.sensitiveInputWithheld, true);
  assert.ok(!secretDecision.summary.includes("super-private-value"));
  pass("Secret-like search text is withheld from all remote reviewers and requires user confirmation");

  grantBrowserSearchExecution("bound-preflight", secretInput, secretDecision, {
    finalPermission: "allow_once",
    independentlyReviewed: true,
  });
  const wrongBoundSession = await tool.call(secretInput, {
    ...context,
    sessionId: "different-browser-search-session",
    toolUseId: "bound-preflight",
  });
  assert.equal(wrongBoundSession.isError, true);
  const rightBoundSession = await tool.call(secretInput, {
    ...context,
    sessionId: "browser-search-secret-test",
    toolUseId: "bound-preflight",
  });
  assert.equal(rightBoundSession.isError, undefined);
  pass("The central preflight decision carries its session binding into the grant without API changes");

  console.log("\n[4] Registry, prompt routing, and UI summary");
  const oldKey = process.env.OPENROUTER_API_KEY;
  const oldMode = process.env.CCAGENT_JEV_MODE;
  const oldEnabled = process.env.CCAGENT_COMPUTER_USE_JEV;
  process.env.OPENROUTER_API_KEY = "test-key-not-used";
  process.env.CCAGENT_JEV_MODE = "enforce";
  process.env.CCAGENT_COMPUTER_USE_JEV = "1";
  try {
    const names = getAllTools().map((candidate) => candidate.name);
    assert.ok(names.includes("BrowserSearch"));
    assert.ok(names.indexOf("BrowserSearch") < names.indexOf("ComputerObserve"));
  } finally {
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
    if (oldMode === undefined) delete process.env.CCAGENT_JEV_MODE; else process.env.CCAGENT_JEV_MODE = oldMode;
    if (oldEnabled === undefined) delete process.env.CCAGENT_COMPUTER_USE_JEV; else process.env.CCAGENT_COMPUTER_USE_JEV = oldEnabled;
  }
  assert.ok(BROWSER_SEARCH_FAST_PATH_GUIDANCE.includes("MUST use BrowserSearch first"));
  assert.ok(BROWSER_SEARCH_FAST_PATH_GUIDANCE.includes("Use WebSearch instead"));
  assert.equal(browserSearchTool.isReadOnly(), false);
  assert.equal(browserSearchTool.decisionPolicy, "specialized_jev");
  const summary = summarizeTool("BrowserSearch", input, String(executed.content));
  assert.equal(summary.label, "Jev Browser Search");
  assert.match(summary.stat ?? "", /opened/);
  pass("The fast path is registered first, prompt-routed distinctly from WebSearch, and visible in the UI");

  console.log("\nBrowserSearch hermetic tests passed. No real browser was launched.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
