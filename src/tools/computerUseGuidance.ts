export const COMPUTER_USE_BROWSER_FAST_PATH_GUIDANCE = [
  "For an ordinary browser search or direct navigation whose complete reversible sequence is known from one fresh browser snapshot, you MUST use ComputerActionGroup instead of splitting the work across ComputerAction calls.",
  "Use either set_value on one enabled Edit/ComboBox element from that snapshot followed by Enter and a final bounded wait, or Control+L followed by one type_text, Enter, and a final bounded wait.",
  "Keep the grouped final observation local with perception=off and image_delivery=text_only unless the accessibility tree is genuinely insufficient; only then re-observe with perception enabled.",
  "When the user asked only to open, search, or navigate and the grouped final observation confirms the requested query or destination, stop and report success; do not call ComputerObserve or Qwen again merely to re-verify it.",
].join(" ");
