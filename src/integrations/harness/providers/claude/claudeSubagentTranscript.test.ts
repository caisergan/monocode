import { describe, expect, it } from "vitest";
import {
  claudeSubagentTranscript,
  claudeSubagentUsage,
  feedClaudeSubagentTranscript,
  takeClaudeTranscriptSteps,
} from "./claudeSubagentTranscript";

function lines(records: Record<string, unknown>[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

const usage = (output: number) => ({
  input_tokens: 2,
  output_tokens: output,
  cache_read_input_tokens: 4_000,
  cache_creation_input_tokens: 1_000,
});

const run = [
  {
    type: "user",
    uuid: "u1",
    isSidechain: true,
    message: { role: "user", content: "Find where auth lives." },
  },
  { type: "attachment", uuid: "x1" },
  {
    type: "assistant",
    uuid: "a1",
    message: {
      id: "msg_1",
      model: "claude-sonnet-5-5",
      content: [{ type: "thinking", thinking: "Search for it." }],
      usage: usage(4),
    },
  },
  {
    type: "assistant",
    uuid: "a2",
    message: {
      id: "msg_1",
      model: "claude-sonnet-5-5",
      content: [
        {
          type: "tool_use",
          id: "toolu_grep",
          name: "Grep",
          input: { pattern: "auth" },
        },
      ],
      usage: usage(120),
    },
  },
  {
    type: "user",
    uuid: "u2",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_grep",
          content: "src/auth.ts",
        },
      ],
    },
  },
  {
    type: "assistant",
    uuid: "a3",
    message: {
      id: "msg_2",
      model: "claude-sonnet-5-5",
      content: [{ type: "text", text: "Auth lives in src/auth.ts." }],
      usage: { ...usage(30), cache_read_input_tokens: 5_000 },
    },
  },
];

describe("claude subagent transcripts", () => {
  it("counts each request once, at its final usage", () => {
    const transcript = claudeSubagentTranscript("/t/agent.jsonl");
    feedClaudeSubagentTranscript(transcript, lines(run));
    expect(claudeSubagentUsage(transcript)).toEqual({
      uncached: 2 * 1_002,
      cacheRead: 9_000,
      cacheWrite: 2_000,
      output: 150,
      contextUsed: 2 + 5_000 + 1_000 + 30,
    });
    expect(transcript.model).toBe("claude-sonnet-5-5");
    // Only readers that show the conversation keep it.
    expect(transcript.blocks).toBeUndefined();
  });

  it("rebuilds the run's conversation, tool output included", () => {
    const transcript = claudeSubagentTranscript("/t/agent.jsonl", {
      blocks: true,
    });
    feedClaudeSubagentTranscript(transcript, lines(run.slice(0, 4)));
    expect(transcript.blocks?.at(-1)?.tool?.status).toBe("in_progress");
    feedClaudeSubagentTranscript(transcript, lines(run.slice(4)));
    expect(transcript.blocks?.map((block) => [block.role, block.text])).toEqual(
      [
        ["user", "Find where auth lives."],
        ["reasoning", "Search for it."],
        ["tool", expect.stringContaining("auth")],
        ["assistant", "Auth lives in src/auth.ts."],
      ],
    );
    expect(transcript.blocks?.[2].tool).toMatchObject({
      callId: "toolu_grep",
      kind: "search",
      status: "completed",
      detail: "src/auth.ts",
    });
  });

  it("reads the run's trail and brief, for a run the stream says nothing of", () => {
    const transcript = claudeSubagentTranscript("/t/agent.jsonl", {
      trail: true,
    });
    feedClaudeSubagentTranscript(transcript, lines(run.slice(0, 4)));
    expect(transcript.brief).toBe("Find where auth lives.");
    expect(takeClaudeTranscriptSteps(transcript, 300)).toEqual([
      { stepId: "msg_1:thinking", kind: "reasoning", text: "Search for it." },
      expect.objectContaining({
        stepId: "toolu_grep",
        kind: "tool",
        text: expect.stringContaining("auth"),
        toolKind: "search",
        status: "in_progress",
      }),
    ]);
    expect(takeClaudeTranscriptSteps(transcript, 300)).toEqual([]);

    // The result settles the same step, which the session merges by its id.
    feedClaudeSubagentTranscript(transcript, lines(run.slice(4)));
    expect(takeClaudeTranscriptSteps(transcript, 300)).toEqual([
      { stepId: "toolu_grep", kind: "tool", text: "", status: "completed" },
      {
        stepId: "msg_2:text",
        kind: "message",
        text: "Auth lives in src/auth.ts.",
      },
    ]);

    // Read in one go, a call and its result are one step, and past the cap
    // only the newest are handed over. The counts and the brief stay right.
    feedClaudeSubagentTranscript(transcript, lines(run));
    const steps = takeClaudeTranscriptSteps(transcript, 2);
    expect(steps.map((step) => [step.stepId, step.status])).toEqual([
      ["toolu_grep", "completed"],
      ["msg_2:text", undefined],
    ]);
    expect(steps[0].text).toContain("auth");
    expect(transcript.brief).toBe("Find where auth lives.");
    expect(claudeSubagentUsage(transcript)?.output).toBe(150);
  });

  it("keeps no trail for a reader that only counts", () => {
    const transcript = claudeSubagentTranscript("/t/agent.jsonl");
    feedClaudeSubagentTranscript(transcript, lines(run));
    expect(transcript.steps).toBeUndefined();
    expect(transcript.brief).toBeUndefined();
    expect(takeClaudeTranscriptSteps(transcript, 300)).toEqual([]);
  });

  it("skips lines it cannot read", () => {
    const transcript = claudeSubagentTranscript("/t/agent.jsonl");
    expect(feedClaudeSubagentTranscript(transcript, "{not json\n[]\n")).toBe(
      false,
    );
    expect(claudeSubagentUsage(transcript)).toBeUndefined();
  });
});
