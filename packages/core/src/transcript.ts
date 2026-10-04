// Transcript grouping shared with the desktop (docs/mobile/11 §11.16): the
// phone draws the same turns, folds and trail rows from the same functions.
export {
  foldableWork,
  foldedBlocks,
  firstFoldableIndex,
  groupTurnItems,
  groupTurns,
  initialThinkingIndex,
  isNoticeBlock,
  isSubagentBlock,
  isThinkingBlock,
  needsApproval,
  proseSummary,
  resolveToolCallDisplay,
  subagentName,
  toolCallLabel,
  toolCallState,
  turnCopyText,
  workSummaryLine,
} from "../../../src/features/sessions/model/transcriptActivity";
export type {
  ToolCallDisplay,
  ToolCallState,
  TurnItem,
  WorkFold,
} from "../../../src/features/sessions/model/transcriptActivity";
