import * as fs from "node:fs/promises";
import { getToolTempRoot } from "./paths.js";

/**
 * Create the process-private tool temp directory and return environment
 * variables for a shell subprocess. These values intentionally win over
 * inherited and settings-provided TEMP variables: otherwise a command can
 * create a file that the next file-tool call is forbidden to inspect.
 */
export async function prepareToolTempEnvironment(): Promise<Record<string, string>> {
  const root = getToolTempRoot();
  await fs.mkdir(root, { recursive: true });
  return {
    CCAGENT_TMPDIR: root,
    TEMP: root,
    TMP: root,
    TMPDIR: root,
  };
}
