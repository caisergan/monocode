import { describe, expect, it } from "vitest";
import {
  newSession,
  type Block,
  type Session,
  type TerminalSync,
} from "../../../features/sessions/model/session";
import {
  claudeLastRecordId,
  claudeTranscriptSlice,
} from "../providers/claude/claudeImport";
import { applyTranscriptSlice } from "./terminalSync";

type Rec = Record<string, unknown>;

/** A linked run of records with stable ids, like a transcript file. */
function transcript(...records: Rec[]): Rec[] {
  let parent: string | null = null;
  return records.map((record, index) => {
    const uuid = `r${index + 1}`;
    const linked = { uuid, parentUuid: parent, isSidechain: false, ...record };
    parent = uuid;
    return linked;
  });
}

const prompt = (text: string): Rec => ({
  type: "user",
  timestamp: "2026-09-30T10:00:00.000Z",
  message: { role: "user", content: text },
});

const reply = (text: string): Rec => ({
  type: "assistant",
  timestamp: "2026-09-30T10:00:05.000Z",
  message: {
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
  },
});

const CWD = "/work/app";

/** A chat session as it is when it moves to the terminal. */
function chatSession(blocks: Block[]): Session {
  return { ...newSession("claude", CWD), blocks };
}

function sync(session: Session, records: Rec[], state: TerminalSync): Session {
  const slice = claudeTranscriptSlice(records, state.afterRecord, CWD);
  return applyTranscriptSlice(session, state, slice, 100);
}

const chatBlocks: Block[] = [
  { id: "chat-u1", role: "user", text: "first question" },
  { id: "chat-a1", role: "assistant", text: "first answer" },
];

describe("a session that starts in the terminal", () => {
  const start: TerminalSync = { prefixBlocks: 0, syncedSize: 0 };
  const records = transcript(prompt("fix the login bug"), reply("On it."));

  it("becomes the full replay of the transcript", () => {
    const next = sync(chatSession([]), records, start);
    expect(next.blocks.map((block) => [block.role, block.text])).toEqual([
      ["user", "fix the login bug"],
      ["assistant", "On it."],
    ]);
  });

  it("takes its title from the first prompt while it still has the placeholder", () => {
    const session = chatSession([]);
    const next = sync(session, records, start);
    expect(next.title).not.toBe(session.title);
    expect(next.title.toLowerCase()).toContain("fix the login bug");
  });

  it("keeps a title the user or the CLI already gave it", () => {
    const named = { ...chatSession([]), title: "My own name" };
    expect(sync(named, records, start).title).toBe("My own name");
  });
});

describe("a chat session moved to the terminal", () => {
  const before = transcript(prompt("first question"), reply("first answer"));
  const cursor: TerminalSync = {
    afterRecord: "r2",
    prefixBlocks: chatBlocks.length,
    syncedSize: 10,
  };
  const after = [
    ...before,
    ...transcript(prompt("second"), reply("second answer")).map(
      (record, index) => ({
        ...record,
        uuid: `r${index + 3}`,
        parentUuid: `r${index + 2}`,
      }),
    ),
  ];

  it("leaves the blocks it already had exactly as they were", () => {
    const session = chatSession(chatBlocks);
    const next = sync(session, after, cursor);
    expect(next.blocks.slice(0, 2)).toEqual(chatBlocks);
    expect(next.blocks.slice(0, 2)[0]).toBe(chatBlocks[0]);
  });

  it("adds only what the CLI wrote after the cursor", () => {
    const next = sync(chatSession(chatBlocks), after, cursor);
    expect(next.blocks.slice(2).map((block) => [block.role, block.text])).toEqual([
      ["user", "second"],
      ["assistant", "second answer"],
    ]);
  });

  it("does nothing new when the CLI wrote nothing", () => {
    const session = chatSession(chatBlocks);
    const next = sync(session, before, cursor);
    expect(next.blocks).toEqual(chatBlocks);
  });

  it("does not retitle a session that already has a real title", () => {
    const titled = { ...chatSession(chatBlocks), title: "Login work" };
    expect(sync(titled, after, cursor).title).toBe("Login work");
  });
});

describe("syncing again", () => {
  const start: TerminalSync = { prefixBlocks: 0, syncedSize: 0 };

  it("gives the same blocks the same ids, so the transcript does not remount", () => {
    const records = transcript(prompt("one"), reply("uno"));
    const first = sync(chatSession([]), records, start);
    const again = sync(first, records, first.terminalSync!);
    expect(again.blocks.map((block) => block.id)).toEqual(
      first.blocks.map((block) => block.id),
    );
    expect(new Set(first.blocks.map((block) => block.id)).size).toBe(
      first.blocks.length,
    );
  });

  it("keeps earlier ids when the transcript grows", () => {
    const short = transcript(prompt("one"), reply("uno"));
    const longer = transcript(
      prompt("one"),
      reply("uno"),
      prompt("two"),
      reply("dos"),
    );
    const first = sync(chatSession([]), short, start);
    const grown = sync(first, longer, first.terminalSync!);
    expect(grown.blocks.slice(0, first.blocks.length).map((b) => b.id)).toEqual(
      first.blocks.map((block) => block.id),
    );
    expect(grown.blocks.length).toBeGreaterThan(first.blocks.length);
  });

  it("records how much of the transcript has been read", () => {
    const records = transcript(prompt("one"), reply("uno"));
    const next = sync(chatSession([]), records, start);
    expect(next.terminalSync).toEqual({ prefixBlocks: 0, syncedSize: 100 });
  });
});

describe("a transcript that was rewound inside the CLI", () => {
  const cursor: TerminalSync = {
    afterRecord: "gone",
    prefixBlocks: 2,
    syncedSize: 10,
  };
  const records = transcript(prompt("a new direction"), reply("sure"));

  it("is recognised when the cursor is no longer on the current branch", () => {
    expect(claudeTranscriptSlice(records, "gone", CWD).rewound).toBe(true);
    expect(claudeTranscriptSlice(records, "r1", CWD).rewound).toBe(false);
    expect(claudeTranscriptSlice(records, undefined, CWD).rewound).toBe(false);
  });

  it("replaces every block, the frozen prefix included, with the full replay", () => {
    const next = sync(chatSession(chatBlocks), records, cursor);
    expect(next.blocks.map((block) => block.text)).toEqual([
      "a new direction",
      "sure",
    ]);
    expect(next.terminalSync).toEqual({ prefixBlocks: 0, syncedSize: 100 });
  });
});

describe("claudeLastRecordId", () => {
  it("is the last record of the current branch, or nothing for an empty file", () => {
    expect(claudeLastRecordId(transcript(prompt("a"), reply("b")))).toBe("r2");
    expect(claudeLastRecordId([])).toBeUndefined();
  });
});
