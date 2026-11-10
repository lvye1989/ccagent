import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { nativeNetworkAgent } from "./nativeNetwork.js";

export class PlatformTransportError extends Error {
  constructor() { super("官方服务连接中断，请查看调用状态后再重试。"); this.name = "PlatformTransportError"; }
}

/** Native transport: verified TLS, bounded streams, no redirect or credential forwarding. */
export function platformRequest(url: URL, options: {
  method?: string; headers?: Record<string, string>; body?: Uint8Array; signal?: AbortSignal;
  timeoutMs?: number; maximumBytes?: number;
} = {}): Promise<Response> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    let settled = false, size = 0;
    let responseBody: ReadableStreamDefaultController<Uint8Array> | undefined;
    const request = transport.request(url, {
      method: options.method ?? "GET", rejectUnauthorized: true, agent: nativeNetworkAgent(url),
      ...(url.hostname === "localhost" && url.protocol === "http:" ? { hostname: "127.0.0.1" } : {}),
      headers: { ...options.headers, ...(options.body ? { "content-length": String(options.body.byteLength) } : {}) },
    });
    const stop = () => request.destroy(new PlatformTransportError());
    const timer = setTimeout(stop, options.timeoutMs ?? 180_000);
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", stop); };
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();
    request.once("error", () => {
      cleanup();
      const error = options.signal?.aborted ? options.signal.reason : new PlatformTransportError();
      if (!settled) reject(error); else { try { responseBody?.error(error); } catch { /* Already cancelled. */ } }
    });
    request.once("response", incoming => {
      const status = incoming.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        settled = true; cleanup(); incoming.destroy();
        reject(new Error("官方服务返回了不允许的跳转，请核对官方服务地址。")); return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        // Session changes are handled by the account client, never exposed in service responses.
        if (value !== undefined && name !== "set-cookie") headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const source = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      const reader = source.getReader();
      const body = new ReadableStream<Uint8Array>({
        start(controller) { responseBody = controller; },
        async pull(controller) {
          try {
            const item = await reader.read();
            if (item.done) { cleanup(); controller.close(); return; }
            size += item.value.byteLength;
            if (size > (options.maximumBytes ?? 64 * 1024 * 1024)) throw new PlatformTransportError();
            controller.enqueue(item.value);
          } catch {
            cleanup(); await reader.cancel().catch(() => {});
            try { controller.error(options.signal?.aborted ? options.signal.reason : new PlatformTransportError()); } catch { /* Already closed. */ }
          }
        },
        async cancel() { cleanup(); await reader.cancel().catch(() => {}); request.destroy(); },
      });
      settled = true;
      if ([204, 205, 304].includes(status)) { cleanup(); incoming.resume(); resolve(new Response(null, { status, headers })); }
      else resolve(new Response(body, { status, headers }));
    });
    request.end(options.body);
  });
}
