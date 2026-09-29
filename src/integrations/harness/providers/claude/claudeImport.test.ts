import { describe, expect, it } from "vitest";
import {
  activeClaudeChain,
  classifyClaudeUserRecord,
  claudeTranscriptToSession,
} from "./claudeImport";

type Rec = Record<string, unknown>;

let counter = 0;
function chain(records: Rec[]): Rec[] {
  let parent: string | null = null;
  return records.map((record) => {
    const uuid = `r${++counter}`;
    const linked = { uuid, parentUuid: parent, isSidechain: false, ...record };
    parent = uuid;
    return linked;
  });
}

const user = (content: unknown, extra: Rec = {}): Rec => ({
  type: "user",
  message: { role: "user", content },
  ...extra,
});

const assistant = (content: unknown[], extra: Rec = {}): Rec => ({
  type: "assistant",
  message: {
    role: "assistant",
    model: "claude-opus-4-5",
    content,
    usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
  },
  ...extra,
});

describe("classifyClaudeUserRecord", () => {
  it("turns slash command wrappers into the typed command", () => {
    expect(
      classifyClaudeUserRecord(
        user(
          "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>",
        ),
      ),
    ).toEqual({ kind: "prompt", text: "/model opus", imageCount: 0 });
  });

  it("skips meta, command output and tool results", () => {
    expect(classifyClaudeUserRecord(user("x", { isMeta: true })).kind).toBe(
      "skip",
    );
    expect(
      classifyClaudeUserRecord(
        user("<local-command-stdout>ok</local-command-stdout>"),
      ).kind,
    ).toBe("skip");
    expect(
      classifyClaudeUserRecord(
        user([{ type: "tool_result", tool_use_id: "t", content: "ok" }]),
      ).kind,
    ).toBe("skip");
  });

  it("recognizes interruptions", () => {
    expect(
      classifyClaudeUserRecord(
        user([{ type: "text", text: "[Request interrupted by user]" }]),
      ).kind,
    ).toBe("interrupt");
  });
});

describe("activeClaudeChain", () => {
  it("follows the latest branch and crosses compaction boundaries", () => {
    const records: Rec[] = [
      { uuid: "a", parentUuid: null, ...user("first") },
      { uuid: "b", parentUuid: "a", ...assistant([{ type: "text", text: "old" }]) },
      // Rewound: a retry branches from `a`.
      { uuid: "c", parentUuid: "a", ...assistant([{ type: "text", text: "new" }]) },
      {
        uuid: "d",
        parentUuid: null,
        logicalParentUuid: "c",
        type: "system",
        subtype: "compact_boundary",
      },
      { uuid: "e", parentUuid: "d", ...user("second") },
      { type: "ai-title", aiTitle: "ignored by chain" },
    ];
    expect(activeClaudeChain(records).map((record) => record.uuid)).toEqual([
      "a",
      "c",
      "d",
      "e",
    ]);
  });

  it("walks through the link stubs left for attachments", () => {
    const records: Rec[] = [
      { uuid: "a", parentUuid: null, ...user("first") },
      { uuid: "b", parentUuid: "a", type: "attachment", isSidechain: false },
      { uuid: "c", parentUuid: "b", ...assistant([{ type: "text", text: "hi" }]) },
    ];
    const session = claudeTranscriptToSession({
      records,
      providerSessionId: "s",
      cwd: "/w",
    });
    expect(session.blocks.map((block) => block.role)).toEqual([
      "user",
      "assistant",
    ]);
  });
});

describe("claudeTranscriptToSession", () => {
  it("replays prompts, reasoning, text and tools into blocks", () => {
    const records = [
      ...chain([
        user("fix the build", { timestamp: "2026-09-01T10:00:00.000Z" }),
        assistant([{ type: "thinking", thinking: "Look at the error." }]),
        assistant([
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "npm run build" },
          },
        ]),
        user(
          [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
          { timestamp: "2026-09-01T10:00:05.000Z" },
        ),
        assistant([{ type: "text", text: "Build passes now." }], {
          timestamp: "2026-09-01T10:00:09.000Z",
        }),
        user("[Request interrupted by user]"),
        user("thanks"),
      ]),
      { type: "ai-title", aiTitle: "Fix the build" },
    ];

    const session = claudeTranscriptToSession({
      records,
      providerSessionId: "claude-session",
      cwd: "/work/app",
    });

    expect(session.harness).toBe("claude");
    expect(session.cwd).toBe("/work/app");
    expect(session.providerSessionId).toBe("claude-session");
    expect(session.busy).toBe(false);
    expect(session.title).toBe("claude · Fix the build");
    expect(session.context?.used).toBeGreaterThan(0);

    const roles = session.blocks.map((block) => block.role);
    expect(roles).toEqual([
      "user",
      "reasoning",
      "tool",
      "assistant",
      "system",
      "user",
    ]);
    const [prompt, reasoning, tool, reply, interrupt] = session.blocks;
    expect(prompt.text).toBe("fix the build");
    expect(prompt.startedAt).toBe(Date.parse("2026-09-01T10:00:00.000Z"));
    expect(prompt.durationMs).toBe(9000);
    expect(reasoning.text).toBe("Look at the error.");
    expect(tool.tool?.status).toBe("completed");
    expect(tool.tool?.callId).toBe("tool-1");
    expect(reply.text).toBe("Build passes now.");
    expect(interrupt.notice).toBe("interrupt");
    expect(session.blocks.every((block) => !block.streaming)).toBe(true);
  });

  it("falls back to the first prompt for the title", () => {
    const session = claudeTranscriptToSession({
      records: chain([user("add dark mode"), assistant([{ type: "text", text: "Done." }])]),
      providerSessionId: "s",
      cwd: "/work/app",
    });
    expect(session.title).toBe("claude · add dark mode");
  });
});
