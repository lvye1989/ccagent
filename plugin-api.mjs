/** Runtime helpers for trusted out-of-process CCAGENT hooks and stdio MCP plugins. */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
const MAX_PROCESS_OUTPUT = 1024 * 1024;

function processError(message, code, name = "Error") {
  const error = new Error(message);
  error.name = name;
  error.code = code;
  return error;
}

function waitForExit(child, timeout) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const done = value => { clearTimeout(timer); child.removeListener("exit", exited); resolve(value); };
    const exited = () => done(true);
    const timer = setTimeout(() => done(false), timeout);
    child.once("exit", exited);
  });
}

/** Best effort for ordinary foreground descendants, never a malicious-plugin sandbox. */
async function terminateProcessTree(child) {
  if (!child.pid) return false;
  let incomplete = false;
  if (process.platform === "win32") {
    const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    incomplete = await new Promise(resolve => {
      execFile(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true, timeout: 2000, maxBuffer: 16 * 1024,
      }, error => resolve(Boolean(error)));
    });
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { incomplete = true; }
    }
  } else {
    // spawn(detached:true) gives this invocation its own POSIX process group.
    // A normal spawned child's descendants inherit that group.
    try { process.kill(-child.pid, "SIGTERM"); }
    catch (error) {
      if (error.code !== "ESRCH") { incomplete = true; try { child.kill("SIGTERM"); } catch {} }
    }
    const until = Date.now() + 250;
    while (Date.now() < until) {
      try { process.kill(-child.pid, 0); }
      catch (error) { if (error.code === "ESRCH") return incomplete; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") incomplete = true; }
  }
  if (!(await waitForExit(child, 500))) incomplete = true;
  return incomplete;
}

function runProcess(program, args, { cwd, env, signal, timeout }) {
  if (signal?.aborted) return Promise.reject(Object.assign(
    processError("Plugin process aborted before start", "ABORT_ERR", "AbortError"), { stdout: "", stderr: "", killed: false },
  ));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(program, args, {
        cwd, env, windowsHide: true, shell: false, detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) { reject(Object.assign(error, { stdout: "", stderr: "", killed: false })); return; }
    const output = { stdout: [], stderr: [] }, bytes = { stdout: 0, stderr: 0 };
    let failure, settled = false, closed = false, timer;
    // Only the first terminal cause owns cleanup. Timeout, abort and output
    // overflow may race, but must never launch competing taskkill/group kills.
    let cleanup;
    const text = stream => Buffer.concat(output[stream]).toString("utf8");
    const finish = (code, exitSignal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", aborted);
      const stdout = text("stdout"), stderr = text("stderr");
      if (!failure && code === 0) resolve({ stdout, stderr });
      else {
        const error = failure ?? processError(`Plugin process exited with ${exitSignal ? `signal ${exitSignal}` : `code ${code}`}`, code);
        Object.assign(error, { stdout, stderr, signal: exitSignal ?? child.signalCode, killed: Boolean(failure && child.pid) });
        reject(error);
      }
    };
    const stop = error => {
      if (settled || failure) return;
      failure = error; clearTimeout(timer); signal?.removeEventListener("abort", aborted);
      cleanup ??= (async () => {
        let incomplete = false;
        try { incomplete = await terminateProcessTree(child); } catch { incomplete = true; }
        // A deliberately detached descendant may retain inherited pipes. Do not
        // leave this API promise or the application's event loop waiting on it.
        if (!closed) {
          child.stdout.destroy(); child.stderr.destroy();
          if (child.exitCode === null && child.signalCode === null && child.pid) { incomplete = true; child.unref(); }
        }
        if (incomplete) failure.cleanupIncomplete = true;
        finish(child.exitCode, child.signalCode);
      })();
    };
    const aborted = () => stop(processError("Plugin process aborted", "ABORT_ERR", "AbortError"));
    const append = (stream, chunk) => {
      if (settled) return;
      const available = MAX_PROCESS_OUTPUT - bytes[stream];
      if (available > 0) { const retained = chunk.subarray(0, available); output[stream].push(retained); bytes[stream] += retained.length; }
      if (chunk.length > available) stop(processError(`Plugin process ${stream} exceeds the 1 MiB output limit`, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "RangeError"));
    };
    child.stdout.on("data", chunk => append("stdout", chunk));
    child.stderr.on("data", chunk => append("stderr", chunk));
    child.stdout.on("error", stop); child.stderr.on("error", stop);
    child.once("error", stop);
    child.once("close", (code, exitSignal) => { closed = true; if (!failure) finish(code, exitSignal); });
    timer = setTimeout(() => stop(processError(`Plugin process timed out after ${timeout}ms`, "ETIMEDOUT")), timeout);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

function inside(root, file) {
  const rel = path.relative(root, file);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error("Path outside plugin root");
  }
  return file;
}

function storageName(key) {
  if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(key)) throw new Error("Invalid plugin storage key");
  return "value-" + key + ".json";
}

export function createPluginHost({ root = process.env.CCAGENT_PLUGIN_ROOT,
  data = process.env.CCAGENT_PLUGIN_DATA, adapters = {} } = {}) {
  if (!root || !data || !path.isAbsolute(root) || !path.isAbsolute(data)) throw new Error("Absolute plugin root and data directories required");

  const files = {
    async readText(relativePath) {
      const base = await realpath(root);
      const file = inside(base, path.resolve(base, relativePath));
      return readFile(inside(base, await realpath(file)), "utf8");
    },
  };
  const processes = {
    async run(program, args, { signal, timeout = 30000, env = {} } = {}) {
      if (typeof program !== "string" || !Array.isArray(args) || !args.every(arg => typeof arg === "string")) throw new Error("Expected program and arguments");
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000) throw new Error("Invalid plugin process timeout");
      if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("Expected an AbortSignal");
      const childEnv = {};
      for (const name of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG"]) {
        if (process.env[name]) childEnv[name] = process.env[name];
      }
      return runProcess(program, args, { cwd: root, env: { ...childEnv, ...env }, signal, timeout });
    },
  };
  const storage = {
    async get(key) {
      const file = path.join(data, storageName(key));
      try {
        if (!(await lstat(data)).isDirectory()) throw new Error("Invalid plugin data directory");
        const base = await realpath(data);
        const resolved = inside(base, await realpath(file));
        return JSON.parse(await readFile(resolved, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }
    },
    async set(key, value) {
      const name = storageName(key);
      const json = JSON.stringify(value);
      if (json === undefined) throw new Error("Expected JSON value");
      await mkdir(data, { recursive: true, mode: 0o700 });
      if (!(await lstat(data)).isDirectory()) throw new Error("Invalid plugin data directory");
      const file = path.join(await realpath(data), name);
      const temporary = file + "." + randomUUID() + ".tmp";
      const handle = await open(temporary, "wx", 0o600);
      try {
        try { await handle.writeFile(json, "utf8"); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
    },
  };
  return { files: adapters.files ?? files, processes: adapters.processes ?? processes, storage: adapters.storage ?? storage };
}
