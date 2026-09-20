/** Regression checks for the canonical DeepSeek .env credential source. */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadEnv } from "../utils/loadEnv.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

const originalCwd = process.cwd();
const originalEnv = {
  CCAGENT_HOME: process.env.CCAGENT_HOME,
  CCAGENT_ENV_FILE: process.env.CCAGENT_ENV_FILE,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  LOAD_ENV_TEST_SETTING: process.env.LOAD_ENV_TEST_SETTING,
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
};
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccagent-load-env-"));

try {
  const cwd = path.join(root, "workspace");
  const ccagentHome = path.join(root, "home", ".ccagent");
  const canonicalEnv = path.join(root, "canonical.env");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(ccagentHome, { recursive: true });

  await fs.writeFile(
    path.join(ccagentHome, "settings.json"),
    JSON.stringify({
      env: {
        DEEPSEEK_API_KEY: "settings-key-must-be-ignored",
        LOAD_ENV_TEST_SETTING: "settings-value",
      },
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(cwd, ".env"),
    "DEEPSEEK_API_KEY=cwd-key-must-be-ignored\nDEEPSEEK_MODEL=cwd-model\n",
    "utf8",
  );
  await fs.writeFile(
    canonicalEnv,
    "DEEPSEEK_API_KEY=canonical-file-key\nDEEPSEEK_MODEL=canonical-model\n",
    "utf8",
  );

  process.chdir(cwd);
  process.env.CCAGENT_HOME = ccagentHome;
  process.env.CCAGENT_ENV_FILE = canonicalEnv;
  process.env.DEEPSEEK_API_KEY = "inherited-key-must-be-ignored";

  loadEnv();

  assert(
    process.env.DEEPSEEK_API_KEY === "canonical-file-key",
    "DeepSeek key comes only from CCAGENT_ENV_FILE",
  );
  assert(
    process.env.DEEPSEEK_MODEL === "canonical-model",
    "the configured env file wins over cwd/.env",
  );
  assert(
    process.env.LOAD_ENV_TEST_SETTING === "settings-value",
    "non-DeepSeek settings env values still load",
  );

  process.env.CCAGENT_ENV_FILE = path.join(root, "missing.env");
  process.env.DEEPSEEK_API_KEY = "second-inherited-key-must-be-ignored";
  loadEnv();
  assert(
    process.env.DEEPSEEK_API_KEY === undefined,
    "missing canonical file does not fall back to inherited or settings keys",
  );
} finally {
  process.chdir(originalCwd);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
}

console.log("\nDeepSeek canonical .env tests passed.");
