import { pendingNotificationCount } from "../state/notificationStore.js";

/** Select only an existing, idle owner; a team keeps the process pinned to its lead. */
export function findWebNotificationSession<T extends { id: string; busy: boolean; pending?: unknown }>(
  sessions: Iterable<T>,
  teamOwner: string | null,
): T | undefined {
  for (const session of sessions) {
    if (session.busy || session.pending || (teamOwner && teamOwner !== session.id)) continue;
    if (pendingNotificationCount({ sessionId: session.id }) > 0) return session;
  }
  return undefined;
}
