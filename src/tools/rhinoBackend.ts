import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { rhinoProjectPath, resolveRhinoExportPath } from "./rhinoProject.js";
import type { RhinoActionName, RhinoJevObservation } from "./rhinoJev.js";
import { rhinoTargetGuids } from "./rhinoCatalog.js";
import { RhinoJobFiles, allocateRhinoCapture, sealRhinoCapture, protectRhinoArtifact, markRhinoTaskFailure } from "./rhinoArtifacts.js";
import { logWarn } from "../utils/log.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RESULT_BYTES = 2_000_000;
const OBSERVATION_MAX_AGE_MS = 60_000;

export interface RhinoObservation extends RhinoJevObservation {
  ok: true;
  rhinoVersion?: string;
}

export interface RhinoActionResult {
  ok: boolean;
  action: RhinoActionName;
  message?: string;
  createdGuids?: string[];
  updatedGuids?: string[];
  deletedGuids?: string[];
  snapshotPath?: string;
  undoRecordSerial?: number;
  document?: Record<string, unknown>;
  [key: string]: unknown;
}

interface CachedObservation {
  value: RhinoObservation;
  capturedAtMs: number;
}

const observations = new Map<string, CachedObservation>();
let rhinoCallTail: Promise<void> = Promise.resolve();

function timeoutMs(): number {
  const parsed = Number(process.env.CCAGENT_RHINO_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 5_000 && parsed <= 300_000
    ? parsed
    : DEFAULT_TIMEOUT_MS;
}

function rhinoProgId(): string {
  const configured = process.env.CCAGENT_RHINO_PROGID?.trim();
  // Rhino.Application always creates a new instance; only Interface may
  // attach to the user's already-open document. Keep that safety invariant
  // even when the ProgID is overridden for another Rhino major version.
  return configured && /^Rhino\.Interface(?:\.\d+)?$/.test(configured)
    ? configured
    : "Rhino.Interface.8";
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function resolveRhinoRunnerPath(): Promise<string> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../rhino/ccagent_rhino_runner.py"),
    path.resolve(moduleDir, "../rhino/ccagent_rhino_runner.py"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  throw new Error(
    `CCAGENT Rhino bridge asset is missing. Checked: ${candidates.join(", ")}`,
  );
}

function pythonLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function powerShellScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$progId = $env:CCAGENT_RHINO_PROGID_VALUE",
    "$wrapper = $env:CCAGENT_RHINO_WRAPPER",
    "$running = @(Get-Process -Name 'Rhino' -ErrorAction SilentlyContinue)",
    "if ($running.Count -eq 0) { throw 'Rhino 8 is not running. Open Rhino, wait for it to finish loading, then call RhinoObserve again.' }",
    "if ($running.Count -gt 1) { throw 'Multiple Rhino processes are running. Close every instance except the document CCAGENT should control, then retry.' }",
    "$rhino = $null",
    "try { $rhino = New-Object -ComObject $progId } catch { throw ('Unable to attach through ' + $progId + ': ' + $_.Exception.Message) }",
    "if ($null -eq $rhino) { throw 'Unable to attach to the running Rhino instance.' }",
    "$attached = @(Get-Process -Name 'Rhino' -ErrorAction SilentlyContinue)",
    "if ($attached.Count -gt 1) {",
    "  try { $scriptObject = $rhino.GetScriptObject(); $scriptObject.Exit() } catch {}",
    "  throw 'Rhino COM started a second automation instance instead of attaching to the open document. Close all Rhino instances, reopen only the intended document, and retry.'",
    "}",
    "$ready = $false",
    "for ($i = 0; $i -lt 120; $i++) {",
    "  try { if ([int]$rhino.IsInitialized() -ne 0) { $ready = $true; break } } catch { try { if ([int]$rhino.IsInitialized -ne 0) { $ready = $true; break } } catch {} }",
    "  Start-Sleep -Milliseconds 250",
    "}",
    "if (-not $ready) { throw 'Rhino is running but did not become ready within 30 seconds.' }",
    `$escaped = $wrapper.Replace('"', '""')`,
    `$command = '_-RunPythonScript "' + $escaped + '" _Enter'`,
    "$ran = $false",
    "for ($attempt = 0; $attempt -lt 8; $attempt++) {",
    "  try { $ran = [bool]$rhino.RunScript($command, 0); break } catch { if ($attempt -eq 7) { throw }; Start-Sleep -Milliseconds 250 }",
    "}",
    "if (-not $ran) { throw 'Rhino rejected the fixed CCAGENT bridge script. Cancel the active Rhino command and retry.' }",
    "try { $rhino.ReleaseWithoutClosing = 1 } catch {}",
    "Write-Output '{\"ok\":true}'",
  ].join("\n");
}

function fixedUndoPowerShellScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$progId = $env:CCAGENT_RHINO_PROGID_VALUE",
    "$running = @(Get-Process -Name 'Rhino' -ErrorAction SilentlyContinue)",
    "if ($running.Count -eq 0) { throw 'Rhino 8 is not running. Open Rhino, wait for it to finish loading, then retry.' }",
    "if ($running.Count -gt 1) { throw 'Multiple Rhino processes are running. Close every instance except the document CCAGENT should control, then retry.' }",
    "$rhino = New-Object -ComObject $progId",
    "$attached = @(Get-Process -Name 'Rhino' -ErrorAction SilentlyContinue)",
    "if ($attached.Count -gt 1) {",
    "  try { $scriptObject = $rhino.GetScriptObject(); $scriptObject.Exit() } catch {}",
    "  throw 'Rhino COM started a second automation instance instead of attaching to the open document. Close all Rhino instances, reopen only the intended document, and retry.'",
    "}",
    "$ready = $false",
    "for ($i = 0; $i -lt 120; $i++) {",
    "  try { if ([int]$rhino.IsInitialized() -ne 0) { $ready = $true; break } } catch { try { if ([int]$rhino.IsInitialized -ne 0) { $ready = $true; break } } catch {} }",
    "  Start-Sleep -Milliseconds 250",
    "}",
    "if (-not $ready) { throw 'Rhino is running but did not become ready within 30 seconds.' }",
    "$ran = [bool]$rhino.RunScript('_Undo', 0)",
    "try { $rhino.ReleaseWithoutClosing = 1 } catch {}",
    "if (-not $ran) { throw 'Rhino has no available undo record or rejected the fixed Undo command.' }",
    "Write-Output '{\"ok\":true}'",
  ].join("\n");
}

function cleanPowerShellError(value: string): string {
  const serialized = [...value.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
    .map((match) => match[1])
    .join(" ");
  const source = serialized || value;
  const cleaned = source
    .replace(/_x000D__x000A_/gi, "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/#<\s*CLIXML/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/RhinoObs\s+erve/g, "RhinoObserve")
    .replace(/\s+/g, " ")
    .trim();
  const diagnosticMarker = cleaned.search(/(?:所在位置|At line:|CategoryInfo\s*:|FullyQualifiedErrorId\s*:)/i);
  return (diagnosticMarker > 0 ? cleaned.slice(0, diagnosticMarker) : cleaned).trim().slice(0, 1_500);
}

async function runPowerShell(
  script: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("The RhinoCommon automation bridge currently supports Rhino 8 on Windows only.");
  }
  if (signal?.aborted) throw new Error("Rhino operation was aborted before it started.");
  const executable = process.env.CCAGENT_POWERSHELL?.trim() || "powershell.exe";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(
      executable,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env },
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(stdout.trim());
    };
    const onAbort = () => {
      child.kill();
      finish(new Error("Rhino operation aborted. Observe the document again before retrying."));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Rhino operation timed out after ${timeoutMs()}ms.`));
    }, timeoutMs());
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_RESULT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 20_000) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) {
        finish(new Error(cleanPowerShellError(stderr) || `PowerShell exited with code ${code}`));
      } else {
        finish();
      }
    });
  });
}

async function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const previous = rhinoCallTail;
  let release!: () => void;
  rhinoCallTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function executeJob(
  job: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return await serialized(async () => {
    const runnerPath = await resolveRhinoRunnerPath();
    const files = await RhinoJobFiles.create();
    const { jobPath, resultPath, wrapperPath } = files;
    let dispatchStarted = false;
    let bridgeFinished = false;
    const payload = { ...job, result_path: resultPath };
    const wrapper = [
      "# -*- coding: utf-8 -*-",
      "import sys",
      "sys.dont_write_bytecode = True",
      `CCAGENT_JOB_PATH = '${pythonLiteral(jobPath)}'`,
      `CCAGENT_RUNNER_PATH = '${pythonLiteral(runnerPath)}'`,
      "with open(CCAGENT_RUNNER_PATH, 'rb') as _ccagent_source_file:",
      "    _ccagent_source = _ccagent_source_file.read()",
      "exec(compile(_ccagent_source, CCAGENT_RUNNER_PATH, 'exec'), globals(), globals())",
      "",
    ].join("\n");
    try {
      await writeFile(jobPath, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      await writeFile(wrapperPath, wrapper, { encoding: "utf8", mode: 0o600 });
      await files.sealInputs();
      dispatchStarted = true;
      await runPowerShell(
        powerShellScript(),
        {
          CCAGENT_RHINO_PROGID_VALUE: rhinoProgId(),
          CCAGENT_RHINO_WRAPPER: wrapperPath,
        },
        signal,
      );
      const raw = await readFile(resultPath);
      if (raw.byteLength > MAX_RESULT_BYTES) throw new Error("Rhino bridge result exceeded the 2 MB safety limit.");
      const parsed: unknown = JSON.parse(raw.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Rhino bridge returned an invalid result payload.");
      }
      const result = parsed as Record<string, unknown>;
      bridgeFinished = typeof result.ok === "boolean";
      if (result.ok !== true) {
        throw new Error(typeof result.error === "string" ? result.error : "Rhino bridge operation failed.");
      }
      return result;
    } catch (error) {
      markRhinoTaskFailure();
      try {
        const raw = await readFile(resultPath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        bridgeFinished = typeof parsed?.ok === "boolean";
        if (typeof parsed.error === "string") throw new Error(parsed.error);
      } catch (resultError) {
        if (resultError instanceof Error && resultError.message !== "ENOENT") {
          if (!/ENOENT|no such file/i.test(resultError.message)) throw resultError;
        }
      }
      throw error;
    } finally {
      // A killed COM caller does not prove Rhino stopped using these files.
      // Delete only known job files after completion; task finalization retries.
      await files.finish(!dispatchStarted || bridgeFinished).catch((error) => {
        logWarn(`Rhino temporary files retained: ${(error as Error).message}`);
      });
    }
  });
}

function normalizeObservation(raw: Record<string, unknown>): RhinoObservation {
  const observationId = randomUUID();
  const capturedAt = new Date().toISOString();
  return {
    ok: true,
    observationId,
    capturedAt,
    document: raw.document && typeof raw.document === "object" ? raw.document as Record<string, unknown> : {},
    layers: Array.isArray(raw.layers) ? raw.layers : [],
    selection: Array.isArray(raw.selection) ? raw.selection : [],
    objects: Array.isArray(raw.objects) ? raw.objects : [],
    command: raw.command && typeof raw.command === "object" ? raw.command as Record<string, unknown> : {},
    undo: raw.undo && typeof raw.undo === "object" ? raw.undo as Record<string, unknown> : {},
    objectsTruncated: raw.objects_truncated === true,
    ...(typeof raw.capture_path === "string" ? { capturePath: raw.capture_path } : {}),
    ...(typeof raw.rhino_version === "string" ? { rhinoVersion: raw.rhino_version } : {}),
  };
}

export async function observeRhino(
  options: { objectLimit?: number; capture?: boolean } = {},
  signal?: AbortSignal,
): Promise<RhinoObservation> {
  const objectLimit = Number.isInteger(options.objectLimit)
    ? Math.min(500, Math.max(1, options.objectLimit!))
    : 200;
  let capturePath: string | undefined;
  if (options.capture) {
    capturePath = await allocateRhinoCapture();
  }
  const raw = await executeJob({ kind: "observe", object_limit: objectLimit, ...(capturePath ? { capture_path: capturePath } : {}) }, signal);
  const observation = normalizeObservation(raw);
  if (capturePath) await sealRhinoCapture(capturePath);
  protectRhinoArtifact(observation.document.path, "Rhino document (never auto-delete)");
  observations.clear();
  observations.set(observation.observationId, { value: observation, capturedAtMs: Date.now() });
  return observation;
}

export function getCachedRhinoObservation(observationId: string): RhinoObservation | undefined {
  const cached = observations.get(observationId);
  if (!cached) return undefined;
  if (Date.now() - cached.capturedAtMs > OBSERVATION_MAX_AGE_MS) {
    observations.delete(observationId);
    return undefined;
  }
  return cached.value;
}

export function clearRhinoObservations(): void {
  observations.clear();
}

function actionTargetSnapshots(
  parameters: Record<string, unknown>,
  observation: RhinoObservation,
): unknown[] {
  const requested = new Set<string>(rhinoTargetGuids(parameters));
  for (const key of ["target_guids", "cutter_guids", "object_guids"] as const) {
    const values = parameters[key];
    if (Array.isArray(values)) {
      for (const value of values) if (typeof value === "string") requested.add(value.toLowerCase());
    }
  }
  if (typeof parameters.target_guid === "string") requested.add(parameters.target_guid.toLowerCase());
  if (requested.size === 0) return [];
  return [...observation.objects, ...observation.selection].filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const guid = (item as Record<string, unknown>).guid;
    return typeof guid === "string" && requested.has(guid.toLowerCase());
  });
}

export async function inspectRhino(parameters:Record<string,unknown>, observation:RhinoObservation, signal?:AbortSignal):Promise<Record<string,unknown>> {
  return await executeJob({kind:"inspect",parameters,expected_document_runtime_serial:observation.document.runtime_serial,
    expected_document:{name:observation.document.name,path:observation.document.path,units:observation.document.units},
    expected_targets:actionTargetSnapshots(parameters,observation)},signal);
}

function selectedObservationGuids(observation: RhinoObservation): string[] {
  return observation.selection.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const guid = (item as Record<string, unknown>).guid;
    return typeof guid === "string" ? [guid] : [];
  });
}

export async function executeRhinoAction(
  action: RhinoActionName,
  parameters: Record<string, unknown>,
  observation: RhinoObservation,
  signal?: AbortSignal,
): Promise<RhinoActionResult> {
  if (action === "import_export" && parameters.operation === "export") {
    const file = resolveRhinoExportPath(String(parameters.file_path));
    if (file !== parameters.file_path) throw new Error("Export destination must be normalized before user authorization.");
    await mkdir(path.dirname(file), { recursive: true });
  }
  const snapshotRoot = rhinoProjectPath("snapshots");
  await mkdir(snapshotRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotPath = path.join(snapshotRoot, `${stamp}-${action}-${randomUUID().slice(0, 8)}.json`);
  protectRhinoArtifact(snapshotPath, "Pre-action snapshot (never auto-delete)");
  protectRhinoArtifact(parameters.file_path, "Import/export file (never auto-delete)");
  protectRhinoArtifact(parameters.definition_path, "Grasshopper definition (never auto-delete)");
  if (action === "undo") {
    const snapshot = {
      created_at_utc: new Date().toISOString(),
      observation_id: observation.observationId,
      action,
      parameters,
      document: observation.document,
      command: observation.command,
      undo: observation.undo,
      targets: observation.objects,
    };
    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await serialized(async () => {
      await runPowerShell(
        fixedUndoPowerShellScript(),
        { CCAGENT_RHINO_PROGID_VALUE: rhinoProgId() },
        signal,
      );
    }).finally(() => observations.clear());
    return {
      ok: true,
      action,
      message: "Rhino executed the fixed Undo command.",
      snapshotPath,
      undoRecordSerial: 0,
      document: observation.document,
    };
  }
  const documentSerial = observation.document.runtime_serial;
  const raw = await executeJob(
    {
      kind: "action",
      action,
      parameters,
      observation_id: observation.observationId,
      expected_document_runtime_serial: documentSerial,
      expected_document: {
        name: observation.document.name,
        path: observation.document.path,
        units: observation.document.units,
      },
      expected_targets: actionTargetSnapshots(parameters, observation),
      ...(action === "import_export" && parameters.operation === "export" && parameters.selected_only === true
        ? { expected_selection_guids: selectedObservationGuids(observation) }
        : {}),
      snapshot_path: snapshotPath,
    },
    signal,
  ).finally(() => observations.clear());
  const asStringArray = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : undefined;
  return {
    ...(raw as RhinoActionResult),
    ok: true,
    action,
    ...(asStringArray(raw.created_guids) ? { createdGuids: asStringArray(raw.created_guids) } : {}),
    ...(asStringArray(raw.updated_guids) ? { updatedGuids: asStringArray(raw.updated_guids) } : {}),
    ...(asStringArray(raw.deleted_guids) ? { deletedGuids: asStringArray(raw.deleted_guids) } : {}),
    snapshotPath: typeof raw.snapshot_path === "string" ? raw.snapshot_path : snapshotPath,
    undoRecordSerial: typeof raw.undo_record_serial === "number" ? raw.undo_record_serial : undefined,
  };
}
