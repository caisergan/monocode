import { describe, expect, it } from "vitest";
import { activePiChain, piTranscriptToSession, piUserPrompt } from "./piImport";

type Entry = Record<string, unknown>;

let counter = 0;
/** Entries linked parent to child, as Pi appends them. */
function chain(entries: Entry[], parent: string | null = null): Entry[] {
  return entries.map((entry) => {
    const id = (entry.id as string | undefined) ?? `e${++counter}`;
    const linked = { parentId: parent, ...entry, id };
    parent = id;
    return linked;
  });
}

const header = (cwd = "/work/app"): Entry => ({
  type: "session",
  version: 3,
  id: "01a02bd1-6b43-7b70-a1c8-e63521ccf32b",
  cwd,
});

const user = (text: string, extra: Entry = {}): Entry => ({
  type: "message",
  timestamp: "2026-08-22T23:32:28.000Z",
  message: { role: "user", content: [{ type: "text", text }], ...extra },
});

const assistant = (content: unknown[], extra: Entry = {}): Entry => ({
  type: "message",
  timestamp: "2026-08-22T23:32:37.000Z",
  message: {
    role: "assistant",
    content,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    stopReason: "toolUse",
    usage: {
      input: 900,
      output: 50,
      cacheRead: 100,
      cacheWrite: 0,
      totalTokens: 1050,
    },
    ...extra,
  },
});

const toolResult = (
  callId: string,
  text: string,
  extra: Entry = {},
): Entry => ({
  type: "message",
  timestamp: "2026-08-22T23:32:40.000Z",
  message: {
    role: "toolResult",
    toolCallId: callId,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    ...extra,
  },
});

function toSession(records: Entry[], harness: "pi" | "omp" = "pi") {
  return piTranscriptToSession({
    harness,
    records,
    providerSessionId: "01a02bd1-6b43-7b70-a1c8-e63521ccf32b",
    cwd: "/work/app",
  });
}

describe("piUserPrompt", () => {
  it("reads typed text and counts images", () => {
    expect(
      piUserPrompt({
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", mimeType: "image/png" },
        ],
      }),
    ).toEqual({ text: "look at this", imageCount: 1 });
    expect(piUserPrompt({ role: "user", content: "plain" })).toEqual({
      text: "plain",
      imageCount: 0,
    });
  });

  it("skips messages the agent wrote as the user", () => {
    expect(
      piUserPrompt({ role: "user", attribution: "agent", content: "nudge" }),
    ).toBeNull();
    expect(piUserPrompt({ role: "user", content: [] })).toBeNull();
  });
});

describe("activePiChain", () => {
  it("follows the branch that was continued after a rewind", () => {
    const [prompt, first] = chain([
      user("try it"),
      assistant([{ type: "text", text: "Attempt one" }]),
    ]);
    // Rewound to the prompt and answered again.
    const retry = {
      ...assistant([{ type: "text", text: "Attempt two" }]),
      id: "r1",
      parentId: prompt.id,
    };
    const texts = activePiChain([header(), prompt, first, retry]).map(
      (entry) => ((entry.message as Entry).content as Entry[])[0].text,
    );
    expect(texts).toEqual(["try it", "Attempt two"]);
  });
});

describe("piTranscriptToSession", () => {
  it("replays prompts, thinking, text and tools", () => {
    const session = toSession([
      header(),
      { type: "session_info", id: "i0", parentId: null, name: "Fix the build" },
      ...chain(
        [
          { type: "thinking_level_change", thinkingLevel: "high" },
          user("run the build"),
          assistant([
            { type: "thinking", thinking: "Check the script." },
            {
              type: "toolCall",
              id: "c1",
              name: "bash",
              arguments: { command: "npm run build" },
            },
          ]),
          toolResult("c1", "build ok"),
          assistant([{ type: "text", text: "It builds now." }], {
            stopReason: "stop",
          }),
        ],
        "i0",
      ),
    ]);

    expect(session.harness).toBe("pi");
    expect(session.model).toBe("pi:openai-codex/gpt-5.6-sol");
    expect(session.modelSettings.thinking).toBe("high");
    expect(session.providerSessionId).toBe(
      "01a02bd1-6b43-7b70-a1c8-e63521ccf32b",
    );
    expect(session.title).toBe("pi · Fix the build");
    expect(session.busy).toBe(false);
    expect(session.context?.used).toBe(1050);
    expect(session.blocks.map((block) => block.role)).toEqual([
      "user",
      "reasoning",
      "tool",
      "assistant",
    ]);
    const [prompt, reasoning, tool, reply] = session.blocks;
    expect(prompt.text).toBe("run the build");
    expect(prompt.durationMs).toBe(9000);
    expect(reasoning.text).toBe("Check the script.");
    expect(tool.tool?.status).toBe("completed");
    expect(tool.tool?.detail).toBe("build ok");
    expect(reply.text).toBe("It builds now.");
  });

  it("marks interruptions and cancels calls that never returned", () => {
    const session = toSession([
      header(),
      ...chain([
        user("run the tests"),
        assistant([
          {
            type: "toolCall",
            id: "c1",
            name: "bash",
            arguments: { command: "npm test" },
          },
        ]),
        assistant([], {
          stopReason: "aborted",
          errorMessage: "Operation aborted",
        }),
      ]),
    ]);
    const tool = session.blocks.find((block) => block.tool);
    expect(tool?.tool?.status).toBe("cancelled");
    expect(session.blocks.at(-1)).toMatchObject({
      role: "system",
      notice: "interrupt",
    });
  });

  it("shows an error only when no retry answered", () => {
    const retried = toSession([
      header(),
      ...chain([
        user("hello"),
        assistant([], { stopReason: "error", errorMessage: "overloaded" }),
        assistant([{ type: "text", text: "Hi!" }], { stopReason: "stop" }),
      ]),
    ]);
    expect(retried.blocks.some((block) => block.notice === "error")).toBe(
      false,
    );

    const failed = toSession([
      header(),
      ...chain([
        user("hello"),
        assistant([], { stopReason: "error", errorMessage: "overloaded" }),
        user("again"),
      ]),
    ]);
    expect(failed.blocks.map((block) => block.role)).toEqual([
      "user",
      "system",
      "user",
    ]);
    expect(failed.blocks[1]).toMatchObject({
      notice: "error",
      text: "Pi stopped with an error: overloaded",
    });
  });

  it("notes compactions and omp's titles", () => {
    const session = toSession(
      [
        { type: "title", v: 1, title: "Slot title" },
        header(),
        ...chain([
          user("map the code"),
          {
            type: "compaction",
            summary: "Earlier work",
            firstKeptEntryId: "x",
          },
          { type: "title_change", title: "Network audit", source: "auto" },
          user("continue"),
        ]),
      ],
      "omp",
    );
    expect(session.harness).toBe("omp");
    expect(session.title).toBe("omp · Network audit");
    expect(session.blocks.map((block) => block.text)).toContain(
      "Conversation compacted.",
    );
  });

  it("falls back to the first prompt for the title and notes images", () => {
    const session = toSession([
      header(),
      ...chain([
        {
          type: "message",
          message: {
            role: "user",
            content: [
              { type: "text", text: "what is this" },
              { type: "image", mimeType: "image/png" },
            ],
          },
        },
      ]),
    ]);
    expect(session.title).toBe("pi · what is this");
    expect(session.blocks[0].text).toBe(
      "what is this\n\n_1 image not imported_",
    );
  });

  it("turns a task call's details into subagent rows", () => {
    const session = toSession([
      header(),
      ...chain([
        user("review it"),
        assistant([
          {
            type: "toolCall",
            id: "t1",
            name: "task",
            arguments: { agent: "scout", task: "Check auth" },
          },
        ]),
        toolResult("t1", "Auth looks fine", {
          toolName: "task",
          details: {
            results: [
              {
                index: 0,
                agent: "scout",
                task: "Check auth",
                output: "Auth looks fine",
                exitCode: 0,
              },
            ],
          },
        }),
      ]),
    ]);
    const agent = session.blocks.find((block) => block.tool?.callId === "t1");
    expect(agent?.tool?.status).toBe("completed");
  });
});
