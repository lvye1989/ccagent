# Session execution journal

The CLI, desktop Web worker and headless entrypoint use the same session journal.
Each execution event carries a harness-generated turn ID, request ID, step and
agent session ID. Tool events additionally carry the provider's tool-use ID.
The official gateway receives the logical request ID as its idempotency key;
when an unresolved call reuses an earlier key, the platform receipt records both
the logical and actual request IDs. Provider usage alone never proves billing
settlement. `/billing <logicalRequestId>` performs explicit account-owned,
read-only reconciliation.

Before dispatch, the tool call, final approval and dispatch boundary are written
and synchronized. A native tool's result is recorded before PostToolUse hooks or
other calls in a parallel batch can wait. The final event omits an unchanged
receipt payload; a hook-modified result is recorded separately.

On restore, a missing tool-result message can be reconstructed from a durable
receipt for the same session, turn, request and tool-use ID. Missing or explicitly
uncertain outcomes remain unknown. Recovery never dispatches a tool. An unknown
mutating call fences the same tool and canonical argument hash, even when a
model invents a new call ID. Foreground human review can release a retry after
checking the target state or receipt. Full mode, background execution and the
headless permission bypass do not replace this review. Tools can report
`executionOutcome: "unknown"` for timeouts, interrupted sends and partial
native operations; their original error text is retained.

New compaction checkpoints are single checksummed records. A torn checkpoint
cannot independently publish its boundary over the previous history. Before
appending, an incomplete JSON suffix is preserved in an `.interrupted-*.tail`
file and truncated to the last complete record. Interior JSON corruption is
reported instead of silently discarded. Legacy transcripts remain readable;
an orphan legacy compaction marker is removed before a later append.

Each transcript has a small `.summary.json` cache containing its list metadata
and unresolved execution keys. Appends update the cache incrementally. Size and
mtime changes invalidate it; older transcripts rebuild it lazily with bounded
parallel IO. Warm session lists do not read transcript bodies.

Temporary chats and `cleanupPeriodDays: 0` use an in-memory replay journal.
They retain protection for the current process without persisting chat content.
That in-memory protection cannot survive a process restart. The replay fence
matches the same tool and canonical arguments; it is not a general proof that
different tools or different arguments cannot produce equivalent external
effects. Such services should additionally use their own idempotency keys and
authoritative receipts.

Validation: `npm run test:session-journal` covers torn checkpoints, tail repair,
reused tool IDs, per-tool persistence, explicit/implicit unknown outcomes,
human-review recovery, disabled persistence, a 40-session listing workload and
pre-model hook cancellation. `test-web-continuity.ts` also hard-kills its own
source-mode Web process tree and checks restoration without automatic replay.
