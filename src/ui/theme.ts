/**
 * Shared UI theme — a single source of truth for the colors and glyphs the
 * terminal UI uses, so the welcome banner, conversation, input box and status
 * line stay visually consistent instead of each component hard-coding its own
 * "magenta"/"green"/"cyan". Values mirror Claude Code's dark theme palette
 * (utils/theme.ts) closely enough to feel familiar.
 */

export const theme = {
  // CCAGENT blue — the assistant accent, spinner star, prompt caret.
  brand: "#2563EB",
  brandLight: "#38BDF8",

  // Conversation roles.
  assistant: "#3B82F6",
  // Subtle full-width bar behind a user prompt (dark-terminal friendly).
  userBarBg: "#34343A",
  userBarText: "#FFFFFF",

  // Chrome.
  border: "#5A5A66",
  borderDim: "#3A3A42",
  muted: "#8A8A94",

  // Tool result / notice states.
  ok: "#5BB98C",
  error: "#E5484D",
  warn: "#E2A336",
  info: "#818CF8",

  // Markdown accents stay in the CCAGENT blue family.
  mdHeading: "#2563EB",
  mdHeadingSub: "#38BDF8",
  mdInlineCode: "#7DD3FC",
  mdLink: "#60A5FA",
  mdQuote: "#8A8A94",
} as const;

export const glyph = {
  assistant: "\u25CF", // ● filled dot for the assistant
  toolDot: "\u25CF", // ● tool-call status dot (colored by state)
  resultCorner: "\u23BF", // ⎿ result/continuation corner under a tool call
  userCaret: "\u203A", // › the user prompt caret inside the bar
  promptCaret: "\u203A", // › the input box caret
  bullet: "\u00B7", // · tip bullet
} as const;

/**
 * Per-permission-mode presentation (symbol + color + label), mirroring Claude
 * Code's PermissionMode config so the welcome banner and footer agree on how a
 * mode looks. The symbol prefixes the label as a quick visual cue; the color
 * makes a non-default mode pop out of the otherwise muted chrome.
 */
export const modeStyle: Record<
  string,
  { label: string; color: string; symbol: string }
> = {
  // ⏵ caret pair = "running through" confirmations; ⏸ = paused (read-only).
  default: { label: "default", color: theme.muted, symbol: "" },
  plan: { label: "plan", color: theme.info, symbol: "\u23F8" }, // ⏸
  auto: { label: "auto", color: theme.warn, symbol: "\u23F5\u23F5" }, // ⏵⏵
  full: { label: "full", color: theme.error, symbol: "!" },
} as const;

export function getModeStyle(mode: string): {
  label: string;
  color: string;
  symbol: string;
} {
  return modeStyle[mode] ?? modeStyle.default!;
}
