import { createHash } from "node:crypto";

/** Resume only a saved response. Verify every delivered byte before appending
 * its suffix so SSE text, JSON arguments and tool IDs cannot be duplicated. */
export function recoverableResponseBody(response: Response, options: {
  signal?: AbortSignal;
  replay: () => Promise<Response | null>;
  complete: () => Promise<void>;
  interrupted: () => Promise<Error>;
  cancelled: () => Promise<void>;
}): ReadableStream<Uint8Array> {
  if (!response.body) throw new Error("Missing response body");
  let reader = response.body.getReader(), bytesDelivered = 0, recovered = false, cancelled = false;
  const deliveredHash = createHash("sha256");
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const callId = response.headers.get("x-ccagent-call-id");
  const assertActive = () => {
    options.signal?.throwIfAborted();
    if (cancelled) throw new Error("Response cancelled");
  };
  async function read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    try { return await reader.read(); }
    catch (error) {
      assertActive();
      if (recovered) throw error;
      recovered = true;
      await reader.cancel().catch(() => {});
      const replay = await options.replay();
      if (cancelled || options.signal?.aborted) { await replay?.body?.cancel().catch(() => {}); assertActive(); }
      if (!replay) throw error;
      if (!replay.ok || replay.headers.get("x-ccagent-replay") !== "true" || !replay.body
        || (callId && replay.headers.get("x-ccagent-call-id") !== callId)
        || replay.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== contentType) {
        await replay.body?.cancel().catch(() => {});
        throw new Error("Saved response identity does not match");
      }
      reader = replay.body.getReader();
      let remaining = bytesDelivered;
      const prefixHash = createHash("sha256");
      while (remaining > 0) {
        assertActive();
        const item = await reader.read();
        if (item.done) throw new Error("Saved response is shorter than delivered content");
        const count = Math.min(remaining, item.value.byteLength);
        prefixHash.update(item.value.subarray(0, count));
        remaining -= count;
        if (remaining === 0) {
          if (!prefixHash.digest().equals(deliveredHash.copy().digest())) throw new Error("Saved response prefix does not match");
          if (count < item.value.byteLength) return { done: false, value: item.value.subarray(count) };
        }
      }
      return reader.read();
    }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await read();
        assertActive();
        if (!item.done) {
          bytesDelivered += item.value.byteLength;
          deliveredHash.update(item.value);
          controller.enqueue(item.value);
          return;
        }
        await options.complete();
        if (!cancelled) controller.close();
      } catch {
        await reader.cancel().catch(() => {});
        if (!cancelled) controller.error(await options.interrupted());
      }
    },
    async cancel() {
      cancelled = true;
      await reader.cancel().catch(() => {});
      await options.cancelled();
    },
  });
}
