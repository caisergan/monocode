import {
  canReplaceSessionTitle,
  titleFromPrompt,
  type Block,
  type Session,
  type TerminalSync,
} from "../../../features/sessions/model/session";

/**
 * What one agent's transcript says after a cursor, replayed into blocks the
 * way an imported session is (see `TranscriptReplay`).
 */
export type TranscriptSlice = {
  /** Blocks for the records after the cursor, or for all of them when rewound. */
  blocks: Block[];
  /**
   * The cursor is no longer in the transcript, so the user rewound or the
   * conversation was rewritten inside the CLI. `blocks` then covers everything
   * and replaces every block the session has, the frozen prefix included.
   */
  rewound: boolean;
  /** The agent's own title for the conversation, already formatted. */
  title?: string;
  /** Tokens in context after the latest reply. */
  contextUsed?: number;
  /** The model's context window, when the transcript says. */
  contextWindow?: number;
};

/**
 * A replay builds blocks with random ids, so replaying the same records twice
 * would remount the whole transcript. Ids come from where a block sits after
 * the cursor instead: a transcript only grows at the end, so a block keeps its
 * id from one sync to the next, and a new cursor (or a rewind) starts a new
 * run of ids.
 */
export function withStableBlockIds(blocks: Block[], anchor: string): Block[] {
  return blocks.map((block, index) => ({ ...block, id: `${anchor}:${index}` }));
}

function firstUserText(blocks: Block[]): string {
  return blocks.find((block) => block.role === "user")?.text ?? "";
}

/**
 * The session with the transcript read back into it. Blocks the session had
 * when it moved to the terminal (`prefixBlocks`) are left alone, since they
 * hold things a replay cannot rebuild, such as checkpoints and plan blocks.
 * Everything after them is replaced, so a sync is safe to repeat.
 */
export function applyTranscriptSlice(
  session: Session,
  sync: TerminalSync,
  slice: TranscriptSlice,
  size: number,
): Session {
  const prefixBlocks = slice.rewound ? 0 : sync.prefixBlocks;
  const anchor = slice.rewound ? "full" : (sync.afterRecord ?? "start");
  const blocks = [
    ...session.blocks.slice(0, prefixBlocks),
    ...withStableBlockIds(slice.blocks, anchor),
  ];

  // The title follows the transcript only while nothing else set it.
  const prompt = firstUserText(blocks);
  const seed = titleFromPrompt(prompt, session.harness);
  const next = slice.title ?? (prompt ? seed : undefined);
  const title =
    next && canReplaceSessionTitle(session.title, session.harness, seed)
      ? next
      : session.title;

  return {
    ...session,
    title,
    blocks,
    ...(slice.contextUsed !== undefined
      ? {
          context: {
            ...session.context,
            used: slice.contextUsed,
            ...(slice.contextWindow ? { window: slice.contextWindow } : {}),
          },
        }
      : {}),
    terminalSync: {
      ...(!slice.rewound && sync.afterRecord
        ? { afterRecord: sync.afterRecord }
        : {}),
      prefixBlocks,
      syncedSize: size,
    },
  };
}
