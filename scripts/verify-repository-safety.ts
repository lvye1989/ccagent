/** Pre-push hygiene check. Reports locations/rule names, never secret values.
 * This is a focused guard, not a comprehensive secret scanner or security audit.
 * --staged reads index blobs, so the check covers exactly what will be committed.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import dotenv from "dotenv";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const staged = process.argv.includes("--staged");
const git = (args: string[]) => execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const names = [...new Set(git(["ls-files", "-z", "--cached", ...(staged ? [] : ["--others", "--exclude-standard"])])
  .toString("utf8").split("\0").filter(Boolean))];
const failures = new Set<string>();
const knownSecrets = new Set<string>();
const fake = /(?:example|placeholder|fixture|dummy|fake|not-a-real|your[-_ ]|test[-_]|xxx)/i;
const secretField = /(?:api[_-]?key|auth[_-]?token|secret|password|access[_-]?token|refresh[_-]?token)/i;
function collect(value: unknown, key = ""): void {
  if (typeof value === "string" && secretField.test(key) && !/Env$/i.test(key) && value.length >= 12 && !fake.test(value) && !value.includes("${")) knownSecrets.add(value);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) collect(v, k);
}
const userDir = process.env.CCAGENT_HOME || path.join(os.homedir(), ".ccagent");
const envPaths = new Set([path.join(root, ".env"), path.join(userDir, ".env")]);
if (process.env.CCAGENT_ENV_FILE) envPaths.add(path.resolve(process.env.CCAGENT_ENV_FILE));
try {
  const user = JSON.parse(fs.readFileSync(path.join(userDir, "settings.json"), "utf8"));
  collect(user);
  const envFile = user.env?.CCAGENT_ENV_FILE;
  if (typeof envFile === "string" && envFile.trim()) envPaths.add(path.resolve(userDir, envFile.trim()));
} catch { /* Missing private configuration is normal on CI. */ }
for (const envPath of envPaths) {
  try { collect(dotenv.parse(fs.readFileSync(envPath))); } catch { /* optional */ }
}
const patterns: [string, RegExp][] = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ["OpenRouter key", /\bsk-or-v1-[A-Za-z0-9_-]{32,}/g],
  ["provider key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{24,}/g],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{30,}/g],
  ["Google OAuth client secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}/g],
  ["Google OAuth access token", /\bya29\.[A-Za-z0-9_.-]{30,}/g],
];
let scanned = 0;
for (const name of names) {
  const base = path.posix.basename(name);
  if ((/^\.env(?:\.|$)/.test(base) && base !== ".env.example") ||
      /(?:^|\/)(?:\.ccagent|\.claude|node_modules|__pycache__)(?:\/|$)/.test(name) ||
      /^(?:dist\/|rhino\/(?:output|_diag)\/)/.test(name) || /\.tgz$/.test(name)) {
    failures.add(`${name}: private/generated path`);
    continue;
  }
  let buffer: Buffer;
  try { buffer = staged ? git(["show", `:${name}`]) : fs.readFileSync(path.join(root, name)); }
  catch { failures.add(`${name}: unreadable (cannot verify)`); continue; }
  if (buffer.includes(0)) continue;
  const source = buffer.toString("utf8");
  scanned++;
  const report = (offset: number, rule: string) => failures.add(`${name}:${source.slice(0, offset).split("\n").length}: ${rule}`);
  for (const secret of knownSecrets) {
    const index = source.indexOf(secret);
    if (index >= 0) report(index, "matches local credential");
  }
  for (const [rule, regex] of patterns) {
    for (const match of source.matchAll(regex)) if (!fake.test(match[0])) report(match.index!, rule);
  }
}
if (failures.size) {
  for (const entry of failures) console.error(entry);
  console.error(`FAILED: ${failures.size} safety finding(s); values redacted.`);
  process.exitCode = 1;
} else console.log(`Repository safety: ${names.length} ${staged ? "index" : "working-tree"} paths checked, ${scanned} text files scanned; no findings.`);
