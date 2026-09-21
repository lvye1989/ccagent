#!/usr/bin/env tsx

import { endComputerUseIndicatorSession } from "../tools/computerUseIndicator.js";
import {
  computerActionGroupTool,
  computerObserveTool,
  preflightComputerActionGroupWithJev,
} from "../tools/computerUseTools.js";
import { toolResultText, type ToolContext } from "../tools/Tool.js";
import { loadEnv } from "../utils/loadEnv.js";

function requireExecuteFlag(): void {
  if (!process.argv.includes("--execute")) {
    throw new Error("Live browser input is disabled. Re-run with --execute after choosing a safe visible Baidu Chrome window.");
  }
}

function extractEditableIndex(observation: string): number {
  const lines = observation.split(/\r?\n/);
  const preferred = lines.find((line) => /^\[\d+\]\s+(?:Edit|ComboBox)\b/.test(line) && /id=(?:chat-textarea|kw)\b/i.test(line));
  const fallback = lines.find((line) => /^\[\d+\]\s+(?:Edit|ComboBox)\b/.test(line) && !/地址和搜索栏|address/i.test(line));
  const match = (preferred || fallback || "").match(/^\[(\d+)\]/);
  if (!match) throw new Error("No enabled page search Edit/ComboBox was found in the fresh Baidu snapshot.");
  return Number(match[1]);
}

async function main(): Promise<void> {
  requireExecuteFlag();
  await loadEnv();

  const queryArg = process.argv.find((argument) => argument.startsWith("--query="));
  const query = queryArg?.slice("--query=".length).trim() || "马斯克最新消息";
  const context: ToolContext = {
    cwd: process.cwd(),
    sessionId: "browser-search-live-regression",
  };

  let jevCalls = 0;
  let nativeBatches = 0;
  let finalObservations = 0;
  try {
    const listed = await computerObserveTool.call({ action: "list_windows" }, context);
    const listedText = toolResultText(listed.content);
    const windows = JSON.parse(listedText.slice(listedText.indexOf("["), listedText.lastIndexOf("]") + 1)) as Array<{
      id: string;
      processName: string;
      title: string;
      available: boolean;
    }>;
    const browser = windows.find(
      (window) => window.available && window.processName.toLowerCase() === "chrome" && /百度|baidu/i.test(window.title),
    );
    if (!browser) throw new Error("No visible Chrome window on Baidu is available. Open https://www.baidu.com first.");

    const observed = await computerObserveTool.call(
      {
        action: "observe",
        window_id: browser.id,
        perception: "off",
        image_delivery: "text_only",
      },
      context,
    );
    if (observed.isError) throw new Error(toolResultText(observed.content));
    const observedText = toolResultText(observed.content);
    const snapshotId = observedText.match(/snapshot_id:\s*([0-9a-f-]+)/i)?.[1];
    if (!snapshotId) throw new Error("ComputerObserve did not return a snapshot_id.");
    const elementIndex = extractEditableIndex(observedText);

    const groupInput = {
      window_id: browser.id,
      snapshot_id: snapshotId,
      goal: `在百度搜索“${query}”`,
      risk_category: "ordinary",
      actions: [
        { action: "set_value", element_index: elementIndex, text: query },
        { action: "press_key", key: "Enter" },
        { action: "wait", duration_ms: 1_500 },
      ],
    };

    const startedAt = Date.now();
    jevCalls += 1;
    const decision = await preflightComputerActionGroupWithJev(
      groupInput,
      context,
      [{ role: "user", content: `请打开百度网页，然后搜索${query}` }],
    );
    if (!decision?.available || decision.mode !== "enforce" || decision.forceDeny || decision.forceReobserve) {
      throw new Error("Jev did not authorize the ordinary browser group: " + (decision?.summary || "no decision"));
    }

    nativeBatches += 1;
    const result = await computerActionGroupTool.call(groupInput, context);
    if (result.isError) throw new Error(toolResultText(result.content));
    finalObservations += 1;
    const resultText = toolResultText(result.content);
    if (!resultText.includes("[ComputerActionGroup]") || !resultText.includes("final_observations=1")) {
      throw new Error("The grouped execution did not report exactly one final observation.");
    }
    if (!resultText.includes(query)) {
      throw new Error("The final local accessibility observation does not contain the submitted query.");
    }
    const refreshedWindowLine = resultText.match(/^window:\s+.+$/m)?.[0] || "";
    if (!refreshedWindowLine.includes(query)) {
      throw new Error("The final observation retained a stale pre-navigation window title.");
    }

    console.log("[PASS] live Baidu grouped search");
    console.log(`query=${query}`);
    console.log(`jev_calls=${jevCalls}, native_batches=${nativeBatches}, final_observations=${finalObservations}, perception_calls=0`);
    console.log(`elapsed_ms=${Date.now() - startedAt}`);
    console.log(`jev=${decision.summary}`);
  } finally {
    await endComputerUseIndicatorSession(context.sessionId);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
