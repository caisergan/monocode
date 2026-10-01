import { describe, expect, it } from "vitest";
import {
  codexLastRecordId,
  codexTranscriptSlice,
  codexTranscriptToSession,
} from "./codexImport";

type Rec = Record<string, unknown>;

let clock = 0;
const at = () => new Date(Date.UTC(2026, 8, 27, 13, 0, clock++)).toISOString();

const event = (payload: Rec): Rec => ({
  type: "event_msg",
  timestamp: at(),
  payload,
});
const item = (type: string, payload: Rec): Rec => ({
  type: "response_item",
  timestamp: at(),
  payload: { type, ...payload },
});
const prompt = (message: string) => event({ type: "user_message", message });
const say = (message: string) => event({ type: "agent_message", message });

const CWD = "/work/app";

function roles(records: Rec[]) {
  return codexTranscriptToSession({ records, cwd: CWD }).blocks.map((block) => [
    block.role,
    block.role === "tool" ? (block.tool?.title ?? "") : block.text,
  ]);
}

describe("a Codex CLI rollout", () => {
  const rollout = [
    { type: "turn_context", timestamp: at(), payload: { model: "gpt-6" } },
    event({ type: "task_started", turn_id: "t1" }),
    prompt("list the files"),
    item("function_call", {
      call_id: "c1",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "ls" }),
    }),
    item("function_call_output", { call_id: "c1", output: "a.txt\nb.txt" }),
    event({
      type: "exec_command_end",
      call_id: "c1",
      command: ["/bin/zsh", "-lc", "ls"],
      cwd: CWD,
      aggregated_output: "a.txt\nb.txt",
      exit_code: 0,
      status: "completed",
    }),
    say("Two files."),
    event({
      type: "token_count",
      info: { last_token_usage: { total_tokens: 1200 }, model_context_window: 200000 },
    }),
    event({ type: "task_complete", turn_id: "t1" }),
  ];

  it("replays the prompt, the command and the answer", () => {
    const session = codexTranscriptToSession({ records: rollout, cwd: CWD });
    expect(session.blocks.map((block) => block.role)).toEqual([
      "user",
      "tool",
      "assistant",
    ]);
    expect(session.blocks[0].text).toBe("list the files");
    expect(session.blocks[1].tool?.title).toContain("ls");
    expect(session.blocks[1].tool?.status).toBe("completed");
    expect(session.blocks[2].text).toBe("Two files.");
  });

  it("shows a command once, even though the model call and its result event both describe it", () => {
    const tools = codexTranscriptToSession({ records: rollout, cwd: CWD }).blocks.filter(
      (block) => block.role === "tool",
    );
    expect(tools).toHaveLength(1);
  });

  it("takes the model and context from the rollout", () => {
    const session = codexTranscriptToSession({ records: rollout, cwd: CWD });
    expect(session.model).toContain("gpt-6");
    expect(session.context).toEqual({ used: 1200, window: 200000 });
  });

  it("titles the session by its first prompt", () => {
    const session = codexTranscriptToSession({ records: rollout, cwd: CWD });
    expect(session.title.toLowerCase()).toContain("list the files");
  });

  it("marks a failed command as failed", () => {
    const failed = [
      prompt("run it"),
      event({
        type: "exec_command_end",
        call_id: "c9",
        command: ["/bin/zsh", "-lc", "false"],
        aggregated_output: "",
        exit_code: 1,
        status: "failed",
      }),
    ];
    const tool = codexTranscriptToSession({ records: failed, cwd: CWD }).blocks.find(
      (block) => block.role === "tool",
    );
    expect(tool?.tool?.status).toBe("failed");
  });

  it("shows reasoning, patches, MCP calls and searches", () => {
    const records = [
      prompt("do things"),
      event({ type: "agent_reasoning", text: "**Planning**" }),
      event({
        type: "patch_apply_end",
        call_id: "p1",
        success: true,
        changes: { "/work/app/a.ts": { type: "add", content: "one\ntwo" } },
      }),
      event({
        type: "mcp_tool_call_end",
        call_id: "m1",
        invocation: { server: "context7", tool: "resolve-library-id", arguments: { q: "x" } },
        result: { Ok: { content: [] } },
      }),
      event({ type: "web_search_end", call_id: "w1", query: "codex resume" }),
    ];
    const blocks = codexTranscriptToSession({ records, cwd: CWD }).blocks;
    expect(blocks.map((block) => block.role)).toEqual([
      "user",
      "reasoning",
      "tool",
      "tool",
      "tool",
    ]);
    expect(blocks[2].tool?.title).toContain("a.ts");
    expect(blocks[3].tool?.title).toContain("context7");
    expect(blocks[4].tool?.title).toContain("codex resume");
  });
});

describe("model calls with no event of their own", () => {
  it("shows the code-mode runner as the command it runs, with its output", () => {
    const records = [
      prompt("status"),
      item("custom_tool_call", {
        call_id: "x1",
        name: "exec",
        input: 'text(await tools.exec_command({cmd:"git status --short",max_output_tokens:500}));',
      }),
      item("custom_tool_call_output", {
        call_id: "x1",
        output: [
          { type: "input_text", text: "Script completed" },
          { type: "input_text", text: "M a.ts" },
        ],
      }),
    ];
    const tool = codexTranscriptToSession({ records, cwd: CWD }).blocks.find(
      (block) => block.role === "tool",
    );
    expect(tool?.tool?.title).toContain("git status --short");
    expect(tool?.tool?.status).toBe("completed");
    expect(tool?.tool?.detail).toContain("M a.ts");
  });

  it("names the files of an apply_patch call", () => {
    const records = [
      prompt("edit"),
      item("custom_tool_call", {
        call_id: "a1",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch",
      }),
      item("custom_tool_call_output", { call_id: "a1", output: "Success" }),
    ];
    const tool = codexTranscriptToSession({ records, cwd: CWD }).blocks.find(
      (block) => block.role === "tool",
    );
    expect(tool?.tool?.title).toContain("src/a.ts");
  });

  it("cancels a call whose output never arrived", () => {
    const records = [
      prompt("hang"),
      item("function_call", { call_id: "h1", name: "shell", arguments: '{"command":["ls"]}' }),
    ];
    const tool = codexTranscriptToSession({ records, cwd: CWD }).blocks.find(
      (block) => block.role === "tool",
    );
    expect(tool?.tool?.status).toBe("cancelled");
  });

  it("keeps an unknown tool's name", () => {
    const records = [
      prompt("x"),
      item("function_call", { call_id: "u1", name: "spawn_agent", arguments: "{}" }),
      item("function_call_output", { call_id: "u1", output: "{}" }),
    ];
    const tool = codexTranscriptToSession({ records, cwd: CWD }).blocks.find(
      (block) => block.role === "tool",
    );
    expect(tool?.tool?.title).toContain("spawn_agent");
  });
});

describe("an app-server rollout", () => {
  it("reads prompts and answers from completed items", () => {
    const records = [
      event({
        type: "item_completed",
        item: { type: "UserMessage", content: [{ type: "text", text: "pull upstream" }] },
      }),
      event({
        type: "item_completed",
        item: { type: "AgentMessage", content: [{ type: "Text", text: "Merging." }] },
      }),
    ];
    expect(roles(records)).toEqual([
      ["user", "pull upstream"],
      ["assistant", "Merging."],
    ]);
  });

  it("does not repeat an answer that is recorded twice", () => {
    const records = [
      prompt("hi"),
      say("Hello."),
      event({
        type: "item_completed",
        item: { type: "AgentMessage", content: [{ type: "Text", text: "Hello." }] },
      }),
    ];
    expect(roles(records)).toEqual([
      ["user", "hi"],
      ["assistant", "Hello."],
    ]);
  });
});

describe("turns that were cut short or undone", () => {
  it("notes an interruption", () => {
    const blocks = codexTranscriptToSession({
      records: [prompt("go"), event({ type: "turn_aborted", reason: "interrupted" })],
      cwd: CWD,
    }).blocks;
    expect(blocks.at(-1)?.notice).toBe("interrupt");
  });

  it("drops the turns the user rolled back", () => {
    const records = [
      prompt("first"),
      say("one"),
      prompt("second"),
      say("two"),
      event({ type: "thread_rolled_back", num_turns: 1 }),
      prompt("third"),
      say("three"),
    ];
    expect(roles(records)).toEqual([
      ["user", "first"],
      ["assistant", "one"],
      ["user", "third"],
      ["assistant", "three"],
    ]);
  });

  it("marks a compaction", () => {
    const blocks = codexTranscriptToSession({
      records: [prompt("a"), say("b"), event({ type: "context_compacted" })],
      cwd: CWD,
    }).blocks;
    expect(blocks.at(-1)?.text).toMatch(/compacted/i);
  });
});

describe("codexTranscriptSlice", () => {
  const before = [prompt("first"), say("one")];
  const after = [...before, prompt("second"), say("two")];

  it("has a cursor at the last record", () => {
    expect(codexLastRecordId(before)).toMatch(/^1:/);
    expect(codexLastRecordId([])).toBeUndefined();
  });

  it("replays only what came after the cursor", () => {
    const slice = codexTranscriptSlice(after, codexLastRecordId(before), CWD);
    expect(slice.rewound).toBe(false);
    expect(slice.blocks.map((block) => block.text)).toEqual(["second", "two"]);
  });

  it("replays everything when there is no cursor", () => {
    const slice = codexTranscriptSlice(after, undefined, CWD);
    expect(slice.rewound).toBe(false);
    expect(slice.blocks).toHaveLength(4);
  });

  it("is rewound when the record at the cursor is not the one it was", () => {
    const rewritten = [prompt("other"), say("thing"), prompt("x"), say("y")];
    const slice = codexTranscriptSlice(rewritten, codexLastRecordId(before), CWD);
    expect(slice.rewound).toBe(true);
    expect(slice.blocks).toHaveLength(4);
  });

  it("is rewound when the rollout is now shorter than the cursor", () => {
    const slice = codexTranscriptSlice(before.slice(0, 1), "5:whenever", CWD);
    expect(slice.rewound).toBe(true);
  });

  it("is rewound when a rollback reaches back before the cursor", () => {
    const records = [
      prompt("first"),
      say("one"),
      prompt("second"),
      say("two"),
      event({ type: "thread_rolled_back", num_turns: 2 }),
      prompt("fresh"),
      say("start"),
    ];
    const cursor = codexLastRecordId(records.slice(0, 4));
    const slice = codexTranscriptSlice(records, cursor, CWD);
    expect(slice.rewound).toBe(true);
    expect(slice.blocks.map((block) => block.text)).toEqual(["fresh", "start"]);
  });

  it("does not need a rewind for a rollback that stays inside the new records", () => {
    const records = [
      prompt("first"),
      say("one"),
      prompt("second"),
      say("two"),
      event({ type: "thread_rolled_back", num_turns: 1 }),
    ];
    const slice = codexTranscriptSlice(records, codexLastRecordId(records.slice(0, 2)), CWD);
    expect(slice.rewound).toBe(false);
    expect(slice.blocks).toEqual([]);
  });
});
