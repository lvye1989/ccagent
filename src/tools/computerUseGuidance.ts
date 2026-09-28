export const BROWSER_SEARCH_FAST_PATH_GUIDANCE = [
  "When BrowserSearch is available, for an ordinary public-web search or one explicit direct URL you MUST use BrowserSearch first; it needs no ComputerObserve snapshot and stops after one Jev-reviewed OS browser launch.",
  "Use WebSearch instead when the user needs facts, sources, or a summary rather than a visible browser page.",
  "After BrowserSearch, switch to ComputerObserve and the existing ComputerActionGroup/ComputerAction path only when the user also requested interaction with the opened page, or when the direct destination is not known safely.",
  "A successful BrowserSearch proves that the OS accepted the normalized URL, not that the page contents loaded; report that distinction and do not add a redundant screenshot/Qwen check for an open/search-only request.",
].join(" ");

export const COMPUTER_USE_BROWSER_FAST_PATH_GUIDANCE = [
  "When BrowserSearch is unavailable or the already-open page itself must be targeted, and the complete ordinary reversible sequence is known from one fresh browser snapshot, you MUST use ComputerActionGroup instead of splitting the work across ComputerAction calls.",
  "Use either set_value on one enabled Edit/ComboBox element from that snapshot followed by Enter and a final bounded wait, or Control+L followed by one type_text, Enter, and a final bounded wait.",
  "Keep the grouped final observation local with perception=off and image_delivery=text_only unless the accessibility tree is genuinely insufficient; only then re-observe with perception enabled.",
  "When the user asked only to open, search, or navigate and the grouped final observation confirms the requested query or destination, stop and report success; do not call ComputerObserve or Qwen again merely to re-verify it.",
].join(" ");
