/** Deterministic, task-owned Rhino housekeeping. Never scan/delete project files. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { rhinoProjectPath } from "./rhinoProject.js";
import { logWarn } from "../utils/log.js";

interface RootIdentity { path: string; real: string; dev: number; ino: number; }
interface Fingerprint { dev: number; ino: number; size: number; mtimeMs: number; hash: string; }
interface Capture { path: string; root: RootIdentity; fingerprint?: Fingerprint; }
export interface RhinoCleanupReport {
  taskId: string;
  enabled: boolean;
  reason: string;
  removed: Array<{ path: string; bytes: number }>;
  retained: Array<{ path: string; reason: string }>;
  warnings: string[];
  reportPath?: string;
}
interface TaskArtifacts {
  report: RhinoCleanupReport;
  captures: Capture[];
  jobs: RhinoJobFiles[];
  hadFailure: boolean;
  keepCaptures: number;
  reportRoot: string;
}
const tasks = new AsyncLocalStorage<TaskArtifacts>();
const JOB_NAMES = ["job.json", "run_ccagent_job.py", "result.json", "result.json.tmp"] as const;

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
}

async function identifyRoot(dir: string): Promise<RootIdentity> {
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Rhino cleanup refuses linked/non-directory roots");
  return { path: path.resolve(dir), real: await realpath(dir), dev: stat.dev, ino: stat.ino };
}

async function validateRoot(root: RootIdentity): Promise<void> {
  const current = await identifyRoot(root.path);
  if (!samePath(current.real, root.real) || current.dev !== root.dev || current.ino !== root.ino) {
    throw new Error("Rhino cleanup root was replaced or redirected; files preserved");
  }
}

async function fingerprint(file: string, root: RootIdentity): Promise<Fingerprint> {
  await validateRoot(root);
  if (!samePath(path.dirname(file), root.path)) throw new Error("Rhino cleanup target is outside its owned directory");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) {
    throw new Error("Rhino cleanup only accepts small, regular, non-linked owned files");
  }
  if (!samePath(await realpath(file), path.join(root.real, path.basename(file)))) throw new Error("Rhino cleanup target was redirected");
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, hash: createHash("sha256").update(await readFile(file)).digest("hex") };
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }

function retain(report: RhinoCleanupReport | undefined, file: string, reason: string): void {
  if (!report?.retained.some((entry) => samePath(entry.path, file))) report?.retained.push({ path: file, reason });
}

async function removeOwnedFile(file: string, root: RootIdentity, expected: Fingerprint, report?: RhinoCleanupReport): Promise<void> {
  try {
    const actual = await fingerprint(file, root);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Owned file changed after creation; preserved");
    await unlink(file); // Never recursive; never follow a directory junction.
    report?.removed.push({ path: file, bytes: actual.size });
  } catch (error) {
    if (missing(error)) return;
    retain(report, file, (error as Error).message);
    const warning = `${file}: ${(error as Error).message}`;
    if (report) report.warnings.push(warning);
    else logWarn(`Rhino temporary cleanup: ${warning}`);
  }
}

/** Handle can only be obtained from a freshly allocated, bounded temp directory. */
export class RhinoJobFiles {
  readonly jobPath: string;
  readonly resultPath: string;
  readonly wrapperPath: string;
  private inputs = new Map<string, Fingerprint>();
  private completed = false;
  private readonly owner = tasks.getStore();
  private constructor(readonly root: RootIdentity) {
    this.jobPath = path.join(root.path, JOB_NAMES[0]);
    this.wrapperPath = path.join(root.path, JOB_NAMES[1]);
    this.resultPath = path.join(root.path, JOB_NAMES[2]);
  }
  static async create(): Promise<RhinoJobFiles> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ccagent-rhino-"));
    const job = new RhinoJobFiles(await identifyRoot(dir));
    job.owner?.jobs.push(job);
    return job;
  }
  async sealInputs(): Promise<void> {
    for (const file of [this.jobPath, this.wrapperPath]) this.inputs.set(file, await fingerprint(file, this.root));
  }
  async finish(bridgeFinished: boolean): Promise<void> {
    this.completed ||= bridgeFinished;
    if (!this.completed) {
      // Killing the COM caller does NOT stop Rhino.
      if (!this.owner) logWarn(`Rhino completion unconfirmed; temporary files retained at ${this.root.path}`);
      return;
    }
    await this.cleanup();
  }
  async retryCleanup(): Promise<void> {
    if (this.completed) { await this.cleanup(); return; }
    // A timed-out Rhino command may have completed by task end. A complete
    // atomic result is evidence; age, extension and file size are not.
    try {
      await validateRoot(this.root);
      await fingerprint(this.resultPath, this.root);
      const result = JSON.parse(await readFile(this.resultPath, "utf8"));
      if (typeof result?.ok === "boolean") { this.completed = true; await this.cleanup(); return; }
    } catch { /* keep any uncertain/linked/in-progress job */ }
    retain(this.owner?.report, this.root.path, "Bridge completion unconfirmed; may still be in use by Rhino");
  }
  private async cleanup(): Promise<void> {
    const report = this.owner?.report;
    try { await validateRoot(this.root); } catch (error) {
      if (!missing(error)) { retain(report, this.root.path, (error as Error).message); report?.warnings.push((error as Error).message); }
      return;
    }
    for (const name of JOB_NAMES) {
      const file = path.join(this.root.path, name);
      try {
        // Authored inputs must remain unchanged; outputs are trusted only once
        // the fixed bridge has finished. Unknown files are never enumerated.
        const expected = this.inputs.get(file) ?? await fingerprint(file, this.root);
        await removeOwnedFile(file, this.root, expected, report);
      } catch (error) {
        if (!missing(error)) { retain(report, file, (error as Error).message); report?.warnings.push((error as Error).message); }
      }
    }
    try { await validateRoot(this.root); await rmdir(this.root.path); } catch (error) {
      if (!missing(error)) retain(report, this.root.path, "Directory not empty or changed; unknown files preserved");
    }
  }
}

export async function allocateRhinoCapture(): Promise<string> {
  const dir = rhinoProjectPath("previews");
  await mkdir(dir, { recursive: true });
  const root = await identifyRoot(dir);
  const file = path.join(dir, `${Date.now()}-${randomUUID()}.png`);
  // Exclusive reservation proves this was not an existing user file.
  await writeFile(file, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
  tasks.getStore()?.captures.push({ path: file, root });
  return file;
}

export async function sealRhinoCapture(file: string): Promise<void> {
  const capture = tasks.getStore()?.captures.find((entry) => entry.path === file);
  if (capture) capture.fingerprint = await fingerprint(file, capture.root);
}

export function protectRhinoArtifact(file: unknown, reason: string): void {
  if (typeof file === "string" && path.isAbsolute(file)) retain(tasks.getStore()?.report, file, reason);
}

export function markRhinoTaskFailure(): void { const task = tasks.getStore(); if (task) task.hadFailure = true; }

export function rhinoCleanupSummary(report: RhinoCleanupReport): string {
  const bytes = report.removed.reduce((sum, entry) => sum + entry.bytes, 0);
  return `Rhino 自动清理：已删除 ${report.removed.length} 个本任务临时文件（${bytes} 字节${report.removed.length ? "，不可恢复" : ""}）；保留模型、导出成果、快照及必要预览。` +
    (report.reason !== "completed" ? " 本次有失败/中断或已关闭自动清理，观察截图保留。" : "") +
    (report.warnings.length ? ` ${report.warnings.length} 项清理未完成，相关文件已保留。` : "") +
    (report.reportPath ? `\n清理记录：${report.reportPath}` : "");
}

/** Called around the entire built-in agent invocation, including exceptions. */
export async function withRhinoTaskCleanup<T extends { reason: string; finalText: string; warnings?: string[] }>(
  operation: () => Promise<T>,
  onReport?: (report: RhinoCleanupReport) => void,
): Promise<T> {
  const keep = Number(process.env.CCAGENT_RHINO_KEEP_CAPTURES);
  const task: TaskArtifacts = {
    report: { taskId: randomUUID(), enabled: process.env.CCAGENT_RHINO_AUTO_CLEANUP !== "0", reason: "exception", removed: [], retained: [], warnings: [] },
    captures: [], jobs: [], hadFailure: false,
    keepCaptures: Number.isInteger(keep) && keep >= 1 && keep <= 20 ? keep : 1,
    reportRoot: rhinoProjectPath("reports", "cleanup"),
  };
  return tasks.run(task, async () => {
    let result: T | undefined;
    try { result = await operation(); return result; }
    finally {
      const report = task.report;
      report.reason = !report.enabled ? "disabled" : task.hadFailure ? "failed_step" : result?.reason ?? "exception";
      try {
        for (const job of task.jobs) await job.retryCleanup();
        const valid = task.captures.filter((capture) => capture.fingerprint && capture.fingerprint.size > 0);
        const keepPaths = new Set(valid.slice(-task.keepCaptures).map((capture) => capture.path));
        for (const capture of task.captures) {
          const referenced = result?.finalText.includes(path.basename(capture.path));
          if (report.reason !== "completed" || !capture.fingerprint || keepPaths.has(capture.path) || referenced || report.retained.some((e) => samePath(e.path, capture.path))) {
            retain(report, capture.path, referenced ? "Referenced in final response" : keepPaths.has(capture.path) ? "Final preview" : "Diagnostics or protected capture");
          } else await removeOwnedFile(capture.path, capture.root, capture.fingerprint, report);
        }
        report.warnings = [...new Set(report.warnings)];
        if (task.jobs.length || task.captures.length || report.retained.length) {
          await mkdir(task.reportRoot, { recursive: true });
          const reportPath = path.join(task.reportRoot, `${report.taskId}.json`);
          await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
          report.reportPath = reportPath;
        }
      } catch (error) { report.warnings.push(`Cleanup incomplete: ${(error as Error).message}`); }
      if (task.jobs.length || task.captures.length || report.warnings.length) {
        const summary = rhinoCleanupSummary(report);
        if (result) {
          result.finalText += `\n\n${summary}`;
          if (report.warnings.length) result.warnings = [...(result.warnings ?? []), ...report.warnings];
        } else logWarn(summary);
        try { onReport?.(report); } catch { /* UI errors must not replace the original result/error. */ }
      }
    }
  });
}
