import type { Block } from "../../features/sessions/model/session";
import {
  claudeSubagentTranscript,
  readClaudeSubagentTranscript,
} from "./providers/claude/claudeSubagentTranscript";

/** A delegated run's own conversation, read from the provider's transcript. */
export type SubagentConversation = {
  /** Read what is new; resolves true when the conversation changed. */
  read(): Promise<boolean>;
  blocks(): Block[];
};

/**
 * A reader for the run's transcript, or null when its provider keeps none the
 * app can read. Only Claude records a transcript path on its runs today.
 */
export function subagentConversation(
  transcriptPath: string | undefined,
): SubagentConversation | null {
  if (!transcriptPath) return null;
  const transcript = claudeSubagentTranscript(transcriptPath, { blocks: true });
  return {
    read: () => readClaudeSubagentTranscript(transcript),
    blocks: () => transcript.blocks ?? [],
  };
}
