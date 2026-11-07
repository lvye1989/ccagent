import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const tasks = new AsyncLocalStorage<string>();
export function currentPlatformTaskId(): string | undefined { return tasks.getStore(); }

/** Keep task attribution across generator pauses and detached child operations. */
export function inPlatformTask<T, R, N>(taskId: string | undefined, iterator: AsyncGenerator<T, R, N>): AsyncGenerator<T, R, N> {
  const id = taskId && /^[A-Za-z0-9._:-]{1,200}$/.test(taskId) ? taskId : randomUUID();
  return {
    next: (...args: [] | [N]) => tasks.run(id, () => iterator.next(...args)),
    return: value => tasks.run(id, () => iterator.return(value)),
    throw: error => tasks.run(id, () => iterator.throw(error)),
    [Symbol.asyncIterator]() { return this; },
    async [Symbol.asyncDispose]() { await tasks.run(id, () => iterator.return(undefined as R)); },
  };
}
