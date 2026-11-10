import { peekPendingNotifications, subscribePendingNotifications } from "../state/notificationStore.js";

/** Select only an existing, idle owner; a team keeps the process pinned to its lead. */
export function findWebNotificationSession<T extends { id: string; busy: boolean; pending?: unknown }>(
  sessions: Iterable<T>,
  teamOwner: string | null,
): T | undefined {
  const eligible = new Map<string, T>();
  for (const session of sessions) {
    if (!session.busy && !session.pending && (!teamOwner || teamOwner === session.id)) eligible.set(session.id, session);
  }
  // Preserve notification arrival order across conversations, rather than
  // repeatedly preferring whichever session was opened first.
  for (const notification of peekPendingNotifications()) {
    if (notification.ownerSessionId && eligible.has(notification.ownerSessionId)) return eligible.get(notification.ownerSessionId);
  }
  return undefined;
}

/** Same push-and-idle continuation as the CLI; the caller retains the worker lock. */
export function createWebNotificationDispatcher<T extends { id: string; busy: boolean; pending?: unknown }>(options: {
  sessions: () => Iterable<T>;
  teamOwner: () => string | null;
  blocked: () => boolean;
  start: (session: T) => void;
}): { request: () => void; dispose: () => void } {
  let queued = false, disposed = false;
  const request = () => {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (disposed || options.blocked()) return;
      const session = findWebNotificationSession(options.sessions(), options.teamOwner());
      if (session) options.start(session);
    });
  };
  const unsubscribe = subscribePendingNotifications(request);
  return { request, dispose() { disposed = true; unsubscribe(); } };
}
