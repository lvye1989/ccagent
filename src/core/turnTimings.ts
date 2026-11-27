import { AsyncLocalStorage } from "node:async_hooks";

export interface TurnTimings {
  queueMs: number;
  modelMs: number;
  toolsMs: number;
  summaryMs: number;
}

const context = new AsyncLocalStorage<TurnTimings>();

export function snapshotTurnTimings(t: TurnTimings | undefined): TurnTimings | undefined {
  if (!t) return undefined;
  return {
    queueMs: Math.round(t.queueMs),
    modelMs: Math.round(t.modelMs),
    toolsMs: Math.round(t.toolsMs),
    summaryMs: Math.round(t.summaryMs),
  };
}

export function currentTurnTimings(): TurnTimings | undefined {
  return snapshotTurnTimings(context.getStore());
}

// Sum active stage durations. Parallel and nested work may overlap in wall time.
export async function measureStage<T>(
  stage: Exclude<keyof TurnTimings, "queueMs">, action: () => Promise<T>,
): Promise<T> {
  const timings = context.getStore();
  if (!timings) return action();
  const start = performance.now();
  try { return await action(); }
  finally { timings[stage] += performance.now() - start; }
}

export function withTurnTimings<T, R>(timings: TurnTimings, iterator: AsyncGenerator<T, R>): AsyncGenerator<T, R> {
  return {
    next: (...args) => context.run(timings, () => iterator.next(...args)),
    return: value => context.run(timings, () => iterator.return(value)),
    throw: error => context.run(timings, () => iterator.throw(error)),
    [Symbol.asyncIterator]() { return this; },
    async [Symbol.asyncDispose]() { await context.run(timings, () => iterator.return(undefined as R)); },
  };
}
