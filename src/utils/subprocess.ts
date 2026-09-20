import { spawn, type ChildProcess } from "node:child_process";

export const MAX_COMMAND_TIMEOUT_MS = 24 * 60 * 60_000;

export function validateCommandTimeout(
  value: unknown,
  defaultTimeoutMs: number,
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: defaultTimeoutMs };
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_COMMAND_TIMEOUT_MS
  ) {
    return {
      ok: false,
      error: `timeout must be an integer from 1 to ${MAX_COMMAND_TIMEOUT_MS} milliseconds`,
    };
  }
  return { ok: true, value };
}

export class BoundedTextBuffer {
  private retained = "";
  private totalChars = 0;

  constructor(private readonly limit: number) {}

  append(chunk: Buffer | string): string {
    const text = chunk.toString();
    this.totalChars += text.length;
    if (this.retained.length < this.limit) {
      this.retained += text.slice(0, this.limit - this.retained.length);
    }
    return text;
  }

  toString(): string {
    if (this.totalChars <= this.retained.length) return this.retained;
    return `${this.retained}\n...[truncated ${this.totalChars - this.retained.length} chars]`;
  }
}

function waitForClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("close", onClose);
  });
}

/** Terminate the spawned shell and its descendants, then wait for cleanup. */
export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.once("error", () => {
        try { child.kill(); } catch { /* already gone */ }
        resolve();
      });
      killer.once("close", () => resolve());
    });
    await waitForClose(child, 1_000);
    return;
  }

  try { child.kill("SIGTERM"); } catch { return; }
  if (await waitForClose(child, 750)) return;
  try { child.kill("SIGKILL"); } catch { return; }
  await waitForClose(child, 750);
}
