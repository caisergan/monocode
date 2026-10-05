import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyHarnessEvent } from "../../core/apply";
import { newSession } from "../../../../features/sessions/model/session";
import {
  resetHarnessModelOverlays,
  setHarnessModels,
} from "../../../../features/sessions/model/models";
import {
  foldableWork,
  foldedBlocks,
  groupTurnItems,
  workSummaryLine,
} from "../../../../features/sessions/model/transcriptActivity";

const sent: string[] = [];
const spawned: string[][] = [];
let onLine: ((line: string) => void) | undefined;
let onExit: ((code?: number | null) => void) | undefined;
const writeChild = vi.fn(async (_id: string, line: string) => {
  sent.push(line);
});

vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async (_id: string, _path: string, args: string[]) => {
    spawned.push(args);
  },
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (
    _id: string,
    line: (l: string) => void,
    exit: (code?: number | null) => void,
  ) => {
    onLine = line;
    onExit = exit;
  },
  writeChild,
}));

const {
  bindClaudeSession,
  cancelClaudeTurn,
  compactClaudeContext,
  respondClaudeApproval,
  respondClaudeQuestion,
  restoreClaudeTaskLists,
  sendClaudeTurn,
  steerClaudeTurn,
  stopClaudeSession,
  __claudeTestReset,
} = await import("./claude");
const { claudeCommandProvider, __claudeCommandsTestReset } =
  await import("./claudeCommands");
const { CLAUDE_MODEL_CATALOG, modelsFromClaudeListModels } = await import(
  "./claudeCatalog"
);
import type { HarnessEvent } from "../../core/types";
import type { RuntimeMode, TurnIntent } from "../../../../features/sessions/model/session";

function parse() {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function emit(rec: Record<string, unknown>) {
  onLine!(JSON.stringify(rec));
}

const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `timed out waiting for ${label}; sent=${JSON.stringify(parse())}`,
  );
};

async function startTurn(
  sessionId: string,
  options: {
    runtimeMode?: RuntimeMode;
    intent?: TurnIntent;
    providerAccountId?: string;
  } = {},
) {
  const events: HarnessEvent[] = [];
  const turn = sendClaudeTurn({
    sessionId,
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: options.runtimeMode ?? "supervised",
    intent: options.intent,
    providerAccountId: options.providerAccountId,
    text: "explore the codebase",
    attachments: [],
    onEvent: (event) => events.push(event),
  });

  await waitFor(
    () =>
      parse().some((m) => {
        const request = m.request as Record<string, unknown> | undefined;
        return request?.subtype === "initialize";
      }),
    "initialize",
  );
  emit({ type: "system", subtype: "init", session_id: "sess_1" });
  emit({
    type: "control_response",
    response: { subtype: "success", request_id: "monocode_1" },
  });
  await waitFor(() => parse().some((m) => m.type === "user"), "user prompt");
  return { events, turn };
}

/** What Claude streams when a finished task wakes it for another turn. */
function emitFollowUpTurn(text: string) {
  emit({ type: "system", subtype: "init", session_id: "sess_1" });
  emit({
    type: "stream_event",
    session_id: "sess_1",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  });
  emit({
    type: "assistant",
    session_id: "sess_1",
    message: { content: [{ type: "text", text }] },
  });
  emit({ type: "result", subtype: "success", session_id: "sess_1" });
}

/** A subagent Claude ran inline: its report comes back on the parent's stream. */
function emitInlineSubagent(taskId = "t1") {
  emit({
    type: "assistant",
    session_id: "sess_1",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_agent",
          name: "Task",
          input: {
            description: "Explore the auth module",
            subagent_type: "explore",
          },
        },
      ],
    },
  });
  emit({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: "toolu_agent",
    description: "Explore the auth module",
    task_type: "local_agent",
  });
  emit({
    type: "user",
    session_id: "sess_1",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_agent",
          content: "Auth lives in src/auth.",
        },
      ],
    },
  });
}

function emitBackgroundBash(taskId = "b1") {
  emit({
    type: "assistant",
    session_id: "sess_1",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_bash",
          name: "Bash",
          input: { command: "sleep 30 && echo done", run_in_background: true },
        },
      ],
    },
  });
  emit({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [
      {
        task_id: taskId,
        task_type: "local_bash",
        description: "Wait 30 seconds then print done",
      },
    ],
  });
  emit({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: "toolu_bash",
    description: "Wait 30 seconds then print done",
    task_type: "local_bash",
  });
  emit({
    type: "user",
    session_id: "sess_1",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_bash",
          content: `Command running in background with ID: ${taskId}`,
        },
      ],
    },
  });
  emit({
    type: "stream_event",
    session_id: "sess_1",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "waiting" },
    },
  });
  emit({
    type: "assistant",
    session_id: "sess_1",
    message: { content: [{ type: "text", text: "waiting" }] },
  });
  emit({ type: "result", subtype: "success", session_id: "sess_1" });
}

function emitBashFinished(taskId = "b1") {
  emit({ type: "system", subtype: "background_tasks_changed", tasks: [] });
  emit({
    type: "system",
    subtype: "task_updated",
    task_id: taskId,
    patch: { status: "completed" },
  });
  emit({
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    tool_use_id: "toolu_bash",
    status: "completed",
    summary: 'Background command "sleep 30 && echo done" completed (exit code 0)',
  });
}

function backgroundUpdates(events: HarnessEvent[]): string[][] {
  return events.flatMap((event) =>
    event.type === "background.updated" ? [event.tasks] : [],
  );
}

beforeEach(() => {
  sent.length = 0;
  spawned.length = 0;
  onLine = undefined;
  onExit = undefined;
  writeChild.mockClear();
  __claudeTestReset();
  __claudeCommandsTestReset();
});

afterEach(async () => {
  await stopClaudeSession("s1");
  __claudeTestReset();
});

describe("claude streamed tool inputs", () => {
  it("replaces an empty Shell row with the complete assistant tool input", async () => {
    const { events, turn } = await startTurn("s1");
    emit({
      type: "stream_event",
      session_id: "sess_1",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_shell",
          name: "Bash",
          input: {},
        },
      },
    });
    emit({
      type: "stream_event",
      session_id: "sess_1",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"command":"git status',
        },
      },
    });
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_shell",
            name: "Bash",
            input: {
              command: "git status --short",
              description: "Check changes",
            },
          },
        ],
      },
    });
    emit({
      type: "user",
      session_id: "sess_1",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_shell", content: "clean" },
        ],
      },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.updated",
        callId: "toolu_shell",
        title: "git status --short",
        status: "pending",
      }),
    );
    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    const tool = session.blocks.find(
      (block) => block.tool?.callId === "toolu_shell",
    );
    expect(tool?.text).toBe("git status --short");
    expect(tool?.tool?.status).toBe("completed");
  });
});

describe("claude task tools", () => {
  function emitTaskTool(
    id: string,
    name: string,
    input: Record<string, unknown>,
    result: string,
    providerSessionId = "sess_1",
  ) {
    emit({
      type: "assistant",
      session_id: providerSessionId,
      message: { content: [{ type: "tool_use", id, name, input }] },
    });
    emit({
      type: "user",
      session_id: providerSessionId,
      message: {
        content: [{ type: "tool_result", tool_use_id: id, content: result }],
      },
    });
  }

  it("builds the task list from TaskCreate and TaskUpdate, not subagent rows", async () => {
    const { events, turn } = await startTurn("s1");
    emitTaskTool(
      "toolu_c1",
      "TaskCreate",
      { subject: "Write tests", description: "Cover the parser" },
      "Task #1 created successfully: Write tests",
    );
    emitTaskTool(
      "toolu_c2",
      "TaskCreate",
      { subject: "Ship it", description: "Open the PR" },
      "Task #2 created successfully: Ship it",
    );
    emitTaskTool(
      "toolu_u1",
      "TaskUpdate",
      { taskId: "1", status: "in_progress" },
      "Updated task #1 status",
    );
    emitTaskTool(
      "toolu_u2",
      "TaskUpdate",
      { taskId: "1", status: "completed" },
      "Updated task #1 status",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    const lists = session.blocks.filter((block) => block.role === "tasks");
    expect(lists).toHaveLength(1);
    expect(lists[0].taskList?.items).toEqual([
      { id: "1", text: "Write tests", status: "completed" },
      { id: "2", text: "Ship it", status: "pending" },
    ]);
    expect(
      session.blocks.some(
        (block) => block.tool?.kind === "agent" || block.agent !== undefined,
      ),
    ).toBe(false);
  });

  it("keeps earlier tasks updatable after a restart resumes the conversation", async () => {
    const first = await startTurn("s1");
    emitTaskTool(
      "toolu_c1",
      "TaskCreate",
      { subject: "Write tests", description: "Cover the parser" },
      "Task #1 created successfully: Write tests",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    const events: HarnessEvent[] = [...first.events];
    const userCount = parse().filter(
      (message) => message.type === "user",
    ).length;
    const second = sendClaudeTurn({
      sessionId: "s1",
      cwd: "/repo",
      model: "claude:opus-5",
      modelSettings: {},
      runtimeMode: "supervised",
      text: "finish it",
      attachments: [],
      onEvent: (event) => events.push(event),
    });
    await waitFor(() => spawned.length === 2, "replacement Claude process");
    expect(spawned[1]).toEqual(expect.arrayContaining(["--resume", "sess_1"]));
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await waitFor(
      () =>
        parse().filter((message) => message.type === "user").length > userCount,
      "follow-up prompt",
    );
    emitTaskTool(
      "toolu_u1",
      "TaskUpdate",
      { taskId: "1", status: "completed" },
      "Updated task #1 status",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await second;

    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    const lists = session.blocks.filter((block) => block.role === "tasks");
    expect(lists.at(-1)?.taskList?.items).toEqual([
      { id: "1", text: "Write tests", status: "completed" },
    ]);
  });

  /** A later turn that must launch a new Claude process. */
  async function restartedTurn(
    events: HarnessEvent[],
    options: {
      intent?: TurnIntent;
      providerAccountId?: string;
      providerSessionId?: string;
    } = {},
  ) {
    const spawnCount = spawned.length;
    const userCount = parse().filter(
      (message) => message.type === "user",
    ).length;
    const turn = sendClaudeTurn({
      sessionId: "s1",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      modelSettings: {},
      runtimeMode: "supervised",
      intent: options.intent,
      providerAccountId: options.providerAccountId,
      text: "finish it",
      attachments: [],
      onEvent: (event) => events.push(event),
    });
    await waitFor(
      () => spawned.length === spawnCount + 1,
      "replacement Claude process",
    );
    emit({
      type: "system",
      subtype: "init",
      session_id: options.providerSessionId ?? "sess_1",
    });
    await waitFor(
      () =>
        parse().filter((message) => message.type === "user").length > userCount,
      "follow-up prompt",
    );
    return { turn };
  }

  function lastTaskItems(events: HarnessEvent[]) {
    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    return session.blocks.filter((block) => block.role === "tasks").at(-1)
      ?.taskList?.items;
  }

  it("shows a TaskUpdate subject rename in the panel", async () => {
    const { events, turn } = await startTurn("s1");
    emitTaskTool(
      "toolu_c1",
      "TaskCreate",
      { subject: "Write tests", description: "Cover the parser" },
      "Task #1 created successfully: Write tests",
    );
    emitTaskTool(
      "toolu_u1",
      "TaskUpdate",
      { taskId: "1", subject: "Write parser tests", status: "in_progress" },
      "Updated task #1 subject, status",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    expect(lastTaskItems(events)).toEqual([
      { id: "1", text: "Write parser tests", status: "in_progress" },
    ]);
  });

  it("keeps earlier tasks across a plan to build restart", async () => {
    const first = await startTurn("s1", { intent: "plan" });
    emitTaskTool(
      "toolu_c1",
      "TaskCreate",
      { subject: "Write tests" },
      "Task #1 created successfully: Write tests",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    const events: HarnessEvent[] = [...first.events];
    const { turn: second } = await restartedTurn(events, { intent: "build" });
    expect(spawned[1]).toEqual(expect.arrayContaining(["--resume", "sess_1"]));
    emitTaskTool(
      "toolu_u1",
      "TaskUpdate",
      { taskId: "1", status: "completed" },
      "Updated task #1 status",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await second;

    expect(lastTaskItems(events)).toEqual([
      { id: "1", text: "Write tests", status: "completed" },
    ]);
  });

  it("keeps earlier tasks after the Claude child exits", async () => {
    const first = await startTurn("s1");
    emitTaskTool(
      "toolu_c1",
      "TaskCreate",
      { subject: "Write tests" },
      "Task #1 created successfully: Write tests",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;
    onExit!(1);

    const events: HarnessEvent[] = [...first.events];
    const { turn: second } = await restartedTurn(events);
    emitTaskTool(
      "toolu_u1",
      "TaskUpdate",
      { taskId: "1", status: "completed" },
      "Updated task #1 status",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await second;

    expect(lastTaskItems(events)).toEqual([
      { id: "1", text: "Write tests", status: "completed" },
    ]);
  });

  it("rehydrates tasks from the persisted panel after an app restart", async () => {
    const first = await startTurn("s1");
    emitTaskTool(
      "toolu_c1",
      "TaskCreate",
      { subject: "Write tests" },
      "Task #1 created successfully: Write tests",
    );
    emitTaskTool(
      "toolu_c2",
      "TaskCreate",
      { subject: "Ship it" },
      "Task #2 created successfully: Ship it",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;
    const restored = first.events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );

    // App restart: all module state is gone; only the saved transcript remains.
    await stopClaudeSession("s1");
    __claudeTestReset();
    bindClaudeSession("s1", "sess_1", "/repo");
    restoreClaudeTaskLists(
      "s1",
      restored.blocks.flatMap((block) =>
        block.taskList ? [block.taskList] : [],
      ),
    );

    const events: HarnessEvent[] = [...first.events];
    const { turn: second } = await restartedTurn(events);
    expect(spawned.at(-1)).toEqual(
      expect.arrayContaining(["--resume", "sess_1"]),
    );
    emitTaskTool(
      "toolu_u1",
      "TaskUpdate",
      { taskId: "1", status: "completed" },
      "Updated task #1 status",
    );
    emitTaskTool(
      "toolu_c3",
      "TaskCreate",
      { subject: "Tag release" },
      "Task #3 created successfully: Tag release",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await second;

    expect(lastTaskItems(events)).toEqual([
      { id: "1", text: "Write tests", status: "completed" },
      { id: "2", text: "Ship it", status: "pending" },
      { id: "3", text: "Tag release", status: "pending" },
    ]);
  });

  /** Conversation A: tasks #1 and #2 in sess_1, reduced like the saved transcript. */
  async function conversationWithTasks() {
    const first = await startTurn("s1");
    emitTaskTool(
      "toolu_c1",
      "TaskCreate",
      { subject: "Write tests" },
      "Task #1 created successfully: Write tests",
    );
    emitTaskTool(
      "toolu_c2",
      "TaskCreate",
      { subject: "Ship it" },
      "Task #2 created successfully: Ship it",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;
    return first.events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
  }

  /** Conversation B updates A's #1, then creates its own #1. */
  function emitConversationB() {
    emitTaskTool(
      "toolu_u1",
      "TaskUpdate",
      { taskId: "1", status: "completed" },
      "Updated task #1 status",
      "sess_2",
    );
    emitTaskTool(
      "toolu_c3",
      "TaskCreate",
      { subject: "Fresh task" },
      "Task #1 created successfully: Fresh task",
      "sess_2",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_2" });
  }

  it("rehydrates the bound conversation's panel past a later conversation's panel", async () => {
    const restored = await conversationWithTasks();
    const lists = [
      ...restored.blocks.flatMap((block) =>
        block.taskList ? [block.taskList] : [],
      ),
      {
        key: "claude-tasks",
        providerSessionId: "sess_2",
        items: [{ id: "1", text: "Other conversation", status: "pending" as const }],
      },
    ];

    await stopClaudeSession("s1");
    __claudeTestReset();
    bindClaudeSession("s1", "sess_1", "/repo");
    restoreClaudeTaskLists("s1", lists);

    const events: HarnessEvent[] = [];
    const { turn } = await restartedTurn(events);
    emitTaskTool(
      "toolu_u1",
      "TaskUpdate",
      { taskId: "2", status: "completed" },
      "Updated task #2 status",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    expect(lastTaskItems(events)).toEqual([
      { id: "1", text: "Write tests", status: "pending" },
      { id: "2", text: "Ship it", status: "completed" },
    ]);
  });

  it("does not carry tasks to another conversation bound to the same thread", async () => {
    const restored = await conversationWithTasks();
    expect(
      restored.blocks.find((block) => block.role === "tasks")?.taskList
        ?.providerSessionId,
    ).toBe("sess_1");

    await stopClaudeSession("s1");
    bindClaudeSession("s1", "sess_2", "/repo");
    restoreClaudeTaskLists(
      "s1",
      restored.blocks.flatMap((block) =>
        block.taskList ? [block.taskList] : [],
      ),
    );

    const events: HarnessEvent[] = [];
    const { turn } = await restartedTurn(events, { providerSessionId: "sess_2" });
    expect(spawned.at(-1)).toEqual(
      expect.arrayContaining(["--resume", "sess_2"]),
    );
    emitConversationB();
    await turn;

    const updates = events.filter((event) => event.type === "tasks.updated");
    expect(updates).toEqual([
      expect.objectContaining({
        providerSessionId: "sess_2",
        items: [{ id: "1", text: "Fresh task", status: "pending" }],
      }),
    ]);
  });

  it("starts a clean task map when Claude reports a different conversation", async () => {
    await conversationWithTasks();

    const events: HarnessEvent[] = [];
    const turn = sendClaudeTurn({
      sessionId: "s1",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      modelSettings: {},
      runtimeMode: "supervised",
      text: "keep going",
      attachments: [],
      onEvent: (event) => events.push(event),
    });
    await waitFor(
      () => parse().filter((message) => message.type === "user").length > 1,
      "follow-up prompt",
    );
    emitConversationB();
    await turn;

    expect(
      events.filter((event) => event.type === "tasks.updated").at(-1),
    ).toEqual(
      expect.objectContaining({
        providerSessionId: "sess_2",
        items: [{ id: "1", text: "Fresh task", status: "pending" }],
      }),
    );
  });

  it("drops the task map when the conversation cannot resume", async () => {
    const first = await startTurn("s1", { providerAccountId: "work" });
    emitTaskTool(
      "toolu_c1",
      "TaskCreate",
      { subject: "Write tests" },
      "Task #1 created successfully: Write tests",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    const events: HarnessEvent[] = [];
    const { turn: second } = await restartedTurn(events, { providerAccountId: "home" });
    expect(spawned.at(-1)).not.toContain("--resume");
    emitTaskTool(
      "toolu_u1",
      "TaskUpdate",
      { taskId: "1", status: "completed" },
      "Updated task #1 status",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await second;

    expect(events.some((event) => event.type === "tasks.updated")).toBe(false);
  });
});

describe("claude assistant message boundaries", () => {
  it("keeps a follow-up paragraph separate and does not replay its snapshot", async () => {
    const { events, turn } = await startTurn("s1");
    const progress = "- update the notes and commit";
    const update =
      "Connect returned an empty file for one image on one post. The catch-up skips it and carries on, and I'll include it in the final tally.";
    for (const text of [progress, update]) {
      emit({
        type: "stream_event",
        session_id: "sess_1",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        },
      });
      emit({
        type: "assistant",
        session_id: "sess_1",
        message: { content: [{ type: "text", text }] },
      });
    }
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    expect(session.blocks.map((block) => block.text)).toEqual([
      progress,
      update,
    ]);
    expect(events.filter((event) => event.type === "message.delta")).toEqual([
      { type: "message.delta", text: progress },
      { type: "message.delta", text: update },
    ]);
  });
});

describe("claude usage limits", () => {
  it("reports a limit Claude refuses again without a new rate limit event", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
    const limitText = "You've hit your session limit · resets 8am (Europe/Istanbul)";
    const refuse = () =>
      emit({
        type: "result",
        subtype: "success",
        is_error: true,
        result: limitText,
        session_id: "sess_1",
      });
    const first = await startTurn("s1");
    emit({
      type: "rate_limit_event",
      session_id: "sess_1",
      rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour" },
    });
    refuse();
    await first.turn;
    expect(first.events).toContainEqual({
      type: "usage.limited",
      resetsAt: resetsAt * 1000,
    });

    // Claude only sends the event when the status changes: the next refused
    // turn carries nothing but its text.
    const secondEvents: HarnessEvent[] = [];
    const userMessages = parse().filter(
      (message) => message.type === "user",
    ).length;
    const second = sendClaudeTurn({
      sessionId: "s1",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      runtimeMode: "supervised",
      text: "Worker results are ready.",
      attachments: [],
      onEvent: (event) => secondEvents.push(event),
    });
    await waitFor(
      () =>
        parse().filter((message) => message.type === "user").length >
        userMessages,
      "second user prompt",
    );
    refuse();
    await second;
    expect(secondEvents).toContainEqual({
      type: "usage.limited",
      resetsAt: resetsAt * 1000,
    });
  });

  it("looks a stale refused window's reset up again", async () => {
    const first = await startTurn("s1");
    emit({
      type: "rate_limit_event",
      session_id: "sess_1",
      rate_limit_info: { status: "rejected", resetsAt: 1_000 },
    });
    emit({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "You've hit your weekly limit",
      session_id: "sess_1",
    });
    await first.turn;
    // The event's own reset reports as is; apply.ts decides it is not ahead.
    expect(first.events).toContainEqual({
      type: "usage.limited",
      resetsAt: 1_000_000,
    });

    const secondEvents: HarnessEvent[] = [];
    const userMessages = parse().filter(
      (message) => message.type === "user",
    ).length;
    const second = sendClaudeTurn({
      sessionId: "s1",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      runtimeMode: "supervised",
      text: "continue",
      attachments: [],
      onEvent: (event) => secondEvents.push(event),
    });
    await waitFor(
      () =>
        parse().filter((message) => message.type === "user").length >
        userMessages,
      "second user prompt",
    );
    emit({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "You've hit your weekly limit",
      session_id: "sess_1",
    });
    await second;
    expect(secondEvents).toContainEqual({ type: "usage.limited" });
  });
});

describe("claude model switching", () => {
  it("restarts a named account with the new model while resuming the provider conversation", async () => {
    const first = await startTurn("s1", {
      providerAccountId: "account-work",
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    const userCount = parse().filter(
      (message) => message.type === "user",
    ).length;
    const second = sendClaudeTurn({
      sessionId: "s1",
      cwd: "/repo",
      model: "claude:opus-5",
      modelSettings: {},
      runtimeMode: "supervised",
      providerAccountId: "account-work",
      text: "what did I ask before?",
      attachments: [],
      onEvent: () => undefined,
    });

    await waitFor(() => spawned.length === 2, "replacement Claude process");
    expect(spawned[1]).toEqual(
      expect.arrayContaining([
        "--model",
        "claude-opus-5",
        "--resume",
        "sess_1",
      ]),
    );
    expect(spawned[1]).not.toContain("--session-id");

    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await waitFor(
      () =>
        parse().filter((message) => message.type === "user").length > userCount,
      "follow-up prompt",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await second;
  });
});

describe("claude context window", () => {
  const contextProbe = () =>
    parse().find(
      (m) =>
        (m.request as Record<string, unknown> | undefined)?.subtype ===
        "get_context_usage",
    );

  function replyContextUsage(response: Record<string, unknown>) {
    emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: contextProbe()!.request_id,
        response,
      },
    });
  }

  it("asks for the window at startup so the first turn shows the gauge", async () => {
    const { events, turn } = await startTurn("s1");
    await waitFor(() => !!contextProbe(), "get_context_usage");
    replyContextUsage({ totalTokens: 15_000, maxTokens: 1_000_000 });

    expect(events).toContainEqual({
      type: "context",
      window: 1_000_000,
      used: 15_000,
    });
    const session = events.reduce(
      (current, event) => applyHarnessEvent(current, event),
      newSession("/repo", "claude"),
    );
    expect(session.context).toEqual({ used: 15_000, window: 1_000_000 });

    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
  });

  it("keeps the turn's own reading when the reply comes after it", async () => {
    const { events, turn } = await startTurn("s1");
    await waitFor(() => !!contextProbe(), "get_context_usage");
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 40_000, output_tokens: 10 },
      },
    });
    replyContextUsage({ totalTokens: 15_000, maxTokens: 200_000 });

    expect(events.filter((event) => event.type === "context")).toEqual([
      { type: "context", used: 40_010 },
      { type: "context", window: 200_000 },
    ]);

    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
  });

  it("waits for the turn result when Claude Code cannot answer", async () => {
    const { events, turn } = await startTurn("s1");
    await waitFor(() => !!contextProbe(), "get_context_usage");
    emit({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: contextProbe()!.request_id,
        error: "get_context_usage is not supported in this context",
      },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    expect(events.some((event) => event.type === "context")).toBe(false);
    expect(events.some((event) => event.type === "session.error")).toBe(false);
  });
});

describe("claude legacy account resume", () => {
  it("resumes a legacy thread when the missing account resolves to default", async () => {
    bindClaudeSession("s1", "legacy-session", "/repo");
    const { turn } = await startTurn("s1", {
      providerAccountId: "default",
    });
    expect(spawned[0]).toEqual(
      expect.arrayContaining(["--resume", "legacy-session"]),
    );
    expect(spawned[0]).not.toContain("--session-id");
    emit({ type: "result", subtype: "success", session_id: "legacy-session" });
    await turn;
  });

  it("does not resume a legacy default thread under a named account", async () => {
    bindClaudeSession("s1", "legacy-session", "/repo");
    const { turn } = await startTurn("s1", {
      providerAccountId: "account-work",
    });
    expect(spawned[0]).not.toContain("--resume");
    expect(spawned[0]).toContain("--session-id");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
  });
});

describe("claude subagents", () => {
  it.each(["allow", "deny"] as const)(
    "routes a child permission decision: %s",
    async (decision) => {
      const { events, turn } = await startTurn("s1");
      emit({
        type: "control_request",
        request_id: "child_permission",
        session_id: "sess_child",
        parent_tool_use_id: "toolu_agent",
        request: {
          subtype: "can_use_tool",
          tool_name: "Read",
          tool_use_id: "child_read",
          input: { file_path: "/home/user/.gitconfig" },
        },
      });
      const approval = events.find(
        (event) => event.type === "approval.requested",
      )!;
      expect(approval).toMatchObject({ callId: "child_read" });
      respondClaudeApproval("s1", approval.requestId, decision);
      await waitFor(
        () =>
          parse().some(
            (message) =>
              (message.response as Record<string, unknown>)?.request_id ===
              "child_permission",
          ),
        "child decision",
      );
      expect(
        parse().find(
          (message) =>
            (message.response as Record<string, unknown>)?.request_id ===
            "child_permission",
        ),
      ).toMatchObject({
        type: "control_response",
        response: { response: { behavior: decision } },
      });
      expect(
        events.filter((event) => event.type === "session.providerBound").at(-1),
      ).toMatchObject({ providerSessionId: "sess_1" });
      emit({ type: "result", subtype: "success", session_id: "sess_1" });
      await turn;
    },
  );

  it("keeps simultaneous child questions reachable in the single-question UI", async () => {
    const { events, turn } = await startTurn("s1");
    for (const id of ["child_a", "child_b"]) {
      emit({
        type: "control_request",
        request_id: id,
        parent_tool_use_id: `agent_${id}`,
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: `Question from ${id}`,
                options: [{ label: "Proceed" }],
              },
            ],
          },
        },
      });
    }
    expect(
      events.filter((event) => event.type === "question.asked"),
    ).toHaveLength(1);
    for (const id of ["child_a", "child_b"]) {
      const session = events.reduce(
        applyHarnessEvent,
        newSession("claude", "/repo"),
      );
      const request = session.pendingQuestion!;
      expect(request.questions[0].prompt).toBe(`Question from ${id}`);
      respondClaudeQuestion(
        "s1",
        request.requestId,
        id === "child_a"
          ? {
              kind: "answered",
              answers: {
                [request.questions[0].id]: [request.questions[0].options[0].id],
              },
            }
          : { kind: "skipped" },
      );
      await waitFor(
        () =>
          parse().some(
            (message) =>
              (message.response as Record<string, unknown>)?.request_id === id,
          ),
        "question response",
      );
      expect(
        parse().find(
          (message) =>
            (message.response as Record<string, unknown>)?.request_id === id,
        ),
      ).toMatchObject({
        response: {
          response: { behavior: id === "child_a" ? "allow" : "deny" },
        },
      });
    }
    expect(
      events.reduce(applyHarnessEvent, newSession("claude", "/repo"))
        .pendingQuestion,
    ).toBeUndefined();
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
  });

  it.each(["child_a", "child_b"])(
    "preserves the remaining question when %s is cancelled by the server",
    async (cancelled) => {
      const { events, turn } = await startTurn("s1");
      for (const id of ["child_a", "child_b"]) {
        emit({
          type: "control_request",
          request_id: id,
          parent_tool_use_id: `agent_${id}`,
          request: {
            subtype: "can_use_tool",
            tool_name: "AskUserQuestion",
            input: {
              questions: [{ question: id, options: [{ label: "Proceed" }] }],
            },
          },
        });
      }
      emit({ type: "control_cancel_request", request_id: cancelled });
      await waitFor(
        () => events.some((event) => event.type === "question.resolved"),
        "cancelled question",
      );
      const session = events.reduce(
        applyHarnessEvent,
        newSession("claude", "/repo"),
      );
      const remaining = cancelled === "child_a" ? "child_b" : "child_a";
      expect(session.pendingQuestion?.questions[0].prompt).toBe(remaining);
      respondClaudeQuestion("s1", session.pendingQuestion!.requestId, {
        kind: "skipped",
      });
      await waitFor(
        () =>
          parse().some(
            (message) =>
              (message.response as Record<string, unknown>)?.request_id ===
              remaining,
          ),
        "remaining question response",
      );
      expect(
        parse().some(
          (message) =>
            (message.response as Record<string, unknown>)?.request_id ===
            cancelled,
        ),
      ).toBe(false);
      emit({ type: "result", subtype: "success", session_id: "sess_1" });
      await turn;
    },
  );

  it("fails the active turn if a child permission reply cannot be delivered", async () => {
    const { events, turn } = await startTurn("s1");
    emit({
      type: "control_request",
      request_id: "child_permission",
      parent_tool_use_id: "toolu_agent",
      request: {
        subtype: "can_use_tool",
        tool_name: "Read",
        input: { file_path: "/home/user/.gitconfig" },
      },
    });
    const approval = events.find(
      (event) => event.type === "approval.requested",
    )!;
    let outcome: unknown;
    void turn.catch((error) => {
      outcome = error;
    });
    writeChild.mockRejectedValueOnce(new Error("Broken pipe"));
    respondClaudeApproval("s1", approval.requestId, "allow");
    await waitFor(() => outcome instanceof Error, "failed permission delivery");
    expect(outcome).toMatchObject({ message: "Broken pipe" });
    expect(events).toContainEqual({
      type: "session.error",
      message: "Broken pipe",
    });
  });

  it.each([
    {
      scenario: "different descriptions",
      descriptions: ["Explore the auth module", "Review the tests"],
    },
    {
      scenario: "identical descriptions",
      descriptions: ["Explore the auth module", "Explore the auth module"],
    },
  ])(
    "shows one row per background subagent when the task list comes first ($scenario)",
    async ({ descriptions }) => {
      const { events, turn } = await startTurn("s1");
      const agents = [
        { id: "toolu_a", task: "t1", description: descriptions[0] },
        { id: "toolu_b", task: "t2", description: descriptions[1] },
      ];

      emit({
        type: "assistant",
        session_id: "sess_1",
        message: {
          content: agents.map((agent) => ({
            type: "tool_use",
            id: agent.id,
            name: "Agent",
            input: {
              description: agent.description,
              subagent_type: "explore",
              run_in_background: true,
            },
          })),
        },
      });
      // Claude lists the tasks, with no tool_use_id, before it announces them.
      emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: agents.map((agent) => ({
          task_id: agent.task,
          task_type: "local_agent",
          description: agent.description,
        })),
      });
      // Each listed task must claim a different call, even before task_started
      // supplies the authoritative IDs for agents with identical descriptions.
      expect(
        new Set(
          events.flatMap((event) =>
            event.type === "tool.updated" ? [event.callId] : [],
          ),
        ),
      ).toEqual(new Set(["toolu_a", "toolu_b"]));
      for (const agent of agents) {
        emit({
          type: "system",
          subtype: "task_started",
          task_id: agent.task,
          tool_use_id: agent.id,
          description: agent.description,
          task_type: "local_agent",
          is_backgrounded: true,
        });
      }

      await waitFor(
        () =>
          events.filter(
            (event) =>
              event.type === "tool.updated" && event.callId === "toolu_b",
          ).length > 0,
        "second task started",
      );
      const rows = events.flatMap((event) =>
        event.type === "tool.started" && event.kind === "agent"
          ? [event.callId]
          : [],
      );
      expect(rows).toEqual(["toolu_a", "toolu_b"]);

      emit({
        type: "system",
        subtype: "task_notification",
        task_id: "t1",
        tool_use_id: "toolu_a",
        status: "completed",
        summary: "First agent finished",
      });
      const session = events.reduce(
        applyHarnessEvent,
        newSession("claude", "/repo"),
      );
      expect(
        session.blocks.find((block) => block.tool?.callId === "toolu_a")?.tool,
      ).toMatchObject({ status: "completed", detail: "First agent finished" });
      expect(
        session.blocks.find((block) => block.tool?.callId === "toolu_b")?.tool,
      ).toMatchObject({ status: "in_progress" });
      emit({
        type: "system",
        subtype: "task_notification",
        task_id: "t2",
        tool_use_id: "toolu_b",
        status: "completed",
        summary: "Second agent finished",
      });
      emit({ type: "result", subtype: "success", session_id: "sess_1" });
      await turn;
    },
  );

  it("keeps an unmatched background subagent visible until it finishes", async () => {
    const { events, turn } = await startTurn("s1");
    const description = "Explore the auth module";
    const task = {
      task_id: "t1",
      task_type: "local_agent",
      description,
    };
    // A task can be listed without an Agent call in the parent transcript.
    for (let i = 0; i < 2; i++) {
      emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [task],
      });
    }
    emit({
      type: "system",
      subtype: "task_progress",
      task_id: "t1",
      description,
      summary: "Reading the auth module",
    });
    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    expect(
      session.blocks.filter((block) => block.tool?.kind === "agent"),
    ).toHaveLength(1);
    expect(
      session.blocks.find(
        (block) => block.tool?.callId === `agent:${description}`,
      )?.tool,
    ).toMatchObject({
      status: "in_progress",
      detail: "Reading the auth module",
    });

    emit({
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      status: "completed",
      summary: "Found the auth entry points",
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    const finished = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    expect(
      finished.blocks.filter((block) => block.tool?.kind === "agent"),
    ).toHaveLength(1);
    expect(
      finished.blocks.find(
        (block) => block.tool?.callId === `agent:${description}`,
      )?.tool,
    ).toMatchObject({
      status: "completed",
      detail: "Found the auth entry points",
    });
  });

  it("stays busy after a parent result while a background subagent is running", async () => {
    const { events, turn } = await startTurn("s1");
    let settled = false;
    void turn.then(() => {
      settled = true;
    });

    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: {
              description: "Explore the auth module",
              subagent_type: "explore",
            },
          },
        ],
      },
    });
    emit({
      type: "system",
      subtype: "task_started",
      task_id: "t1",
      tool_use_id: "toolu_agent",
      description: "Explore the auth module",
      task_type: "local_agent",
      is_backgrounded: true,
    });
    emit({
      type: "user",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_agent",
            content: "Backgrounded",
          },
        ],
      },
    });
    emit({
      type: "result",
      subtype: "success",
      session_id: "sess_1",
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "tool.started" &&
          event.kind === "agent" &&
          event.title === "Explore the auth module",
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "message.completed")).toBe(
      false,
    );

    emit({
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      tool_use_id: "toolu_agent",
      status: "completed",
      summary: "Found the tokens",
    });
    // The notification wakes Claude for a follow-up turn; that turn's result
    // is what ends the MonoCode turn.
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    emitFollowUpTurn("The explorer found the tokens.");
    await turn;
    expect(settled).toBe(true);
    expect(events.some((event) => event.type === "message.completed")).toBe(
      true,
    );
  });

  it("does not end the turn on a subagent result", async () => {
    const { events, turn } = await startTurn("s1");
    let settled = false;
    void turn.then(() => {
      settled = true;
    });

    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: { description: "Explore", subagent_type: "explore" },
          },
        ],
      },
    });
    emit({
      type: "result",
      subtype: "success",
      session_id: "sess_sub",
      parent_tool_use_id: "toolu_agent",
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    expect(events.some((event) => event.type === "message.completed")).toBe(
      false,
    );

    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
    expect(settled).toBe(true);
  });

  it("does not dump subagent assistant text into the parent transcript", async () => {
    const { events, turn } = await startTurn("s1");
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: { description: "Explore", subagent_type: "explore" },
          },
        ],
      },
    });
    emit({
      type: "assistant",
      parent_tool_use_id: "toolu_agent",
      message: { content: [{ type: "text", text: "I will grep for tokens" }] },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
    expect(
      events.some(
        (event) =>
          event.type === "message.delta" &&
          event.text.includes("I will grep for tokens"),
      ),
    ).toBe(false);
  });

  it("mirrors a subagent's tools, thinking and prose onto its own row", async () => {
    const { events, turn } = await startTurn("s1");
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: {
              description: "Correctness review",
              subagent_type: "explore",
            },
          },
        ],
      },
    });
    emit({
      type: "assistant",
      parent_tool_use_id: "toolu_agent",
      message: {
        id: "msg_sub_1",
        model: "claude-haiku-4-5",
        content: [
          { type: "thinking", thinking: "Start with the reducer." },
          { type: "text", text: "I will grep for tokens" },
          {
            type: "tool_use",
            id: "toolu_sub_read",
            name: "Read",
            input: { file_path: "/repo/src/App.tsx" },
          },
        ],
      },
    });
    emit({
      type: "user",
      parent_tool_use_id: "toolu_agent",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_sub_read",
            content: "export function App() {}",
          },
        ],
      },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    expect(
      events
        .reduce(applyHarnessEvent, newSession("claude", "/repo"))
        .blocks.find((block) => block.tool?.callId === "toolu_agent")?.agentRun
        ?.model,
    ).toBe("claude-haiku-4-5");
    const steps = events.filter((event) => event.type === "agent.step");
    expect(steps.every((step) => step.callId === "toolu_agent")).toBe(true);
    expect(
      steps.map((step) => [step.stepId, step.kind, step.text, step.status]),
    ).toEqual([
      ["msg_sub_1:thinking", "reasoning", "Start with the reducer.", undefined],
      ["msg_sub_1:text", "message", "I will grep for tokens", undefined],
      ["toolu_sub_read", "tool", "Read /repo/src/App.tsx", "in_progress"],
      ["toolu_sub_read", "tool", "", "completed"],
    ]);
  });

  it("keeps heartbeats and retry notices off a subagent's steps", async () => {
    const { events, turn } = await startTurn("s1");
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: { description: "Explore", subagent_type: "explorer" },
          },
        ],
      },
    });
    emit({
      type: "assistant",
      parent_tool_use_id: "toolu_agent",
      message: {
        id: "msg_sub_1",
        content: [
          {
            type: "tool_use",
            id: "toolu_sub_bash",
            name: "Bash",
            input: { command: "git ls-files" },
          },
        ],
      },
    });
    // What Claude Code streams while the run takes longer than 30s, and
    // when the subagent's API request is retried and then recovers.
    for (const n of [0, 1]) {
      emit({
        type: "tool_progress",
        tool_use_id: `toolu_agent-heartbeat-${n}`,
        tool_name: "Agent",
        parent_tool_use_id: "toolu_agent",
        elapsed_time_seconds: 30 * (n + 1),
        heartbeat: true,
      });
    }
    emit({
      type: "tool_progress",
      tool_use_id: "agent_msg_parent",
      tool_name: "Agent",
      parent_tool_use_id: "toolu_agent",
      elapsed_time_seconds: 0,
      subagent_type: "explorer",
      subagent_retry: { agent_id: "a1", attempt: 1, max_retries: 10 },
    });
    emit({
      type: "tool_progress",
      tool_use_id: "agent_msg_parent",
      tool_name: "Agent",
      parent_tool_use_id: "toolu_agent",
      elapsed_time_seconds: 0,
      subagent_type: "explorer",
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    const steps = events
      .reduce(applyHarnessEvent, newSession("claude", "/repo"))
      .blocks.find((block) => block.tool?.callId === "toolu_agent")?.agentRun
      ?.steps;
    expect(steps?.map((step) => step.id)).toEqual(["toolu_sub_bash"]);
  });

  it("keeps a failed subagent tool result on its tool row", async () => {
    const { events, turn } = await startTurn("s1");
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: { description: "Run tests" },
          },
        ],
      },
    });
    emit({
      type: "assistant",
      parent_tool_use_id: "toolu_agent",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_sub_bash",
            name: "Bash",
            input: { command: "npm test" },
          },
        ],
      },
    });
    emit({
      type: "user",
      parent_tool_use_id: "toolu_agent",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_sub_bash",
            is_error: true,
            content: [{ type: "text", text: "Tests failed: assertion error" }],
          },
        ],
      },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    expect(
      session.blocks.find((block) => block.tool?.callId === "toolu_agent")
        ?.agentRun?.steps,
    ).toMatchObject([
      {
        id: "toolu_sub_bash",
        kind: "tool",
        text: "npm test",
        toolKind: "execute",
        status: "failed",
        detail: "Tests failed: assertion error",
      },
    ]);
  });

  it("does not mirror a subagent result onto the parent tool row", async () => {
    const { events, turn } = await startTurn("s1");
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_agent",
            name: "Agent",
            input: { description: "Correctness review" },
          },
        ],
      },
    });
    emit({
      type: "user",
      parent_tool_use_id: "toolu_agent",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_sub_read",
            content: "export function App() {}",
          },
        ],
      },
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;

    // The parent stays in flight: only the subagent's own row settles.
    expect(
      events.some(
        (event) =>
          event.type === "tool.updated" &&
          event.callId === "toolu_agent" &&
          event.status === "completed",
      ),
    ).toBe(false);
  });

  it("ends the turn once a subagent has reported back inline", async () => {
    const { turn } = await startTurn("s1");
    let settled = false;
    void turn.then(() => {
      settled = true;
    });

    emitInlineSubagent();
    emit({ type: "result", subtype: "success", session_id: "sess_1" });

    await turn;
    expect(settled).toBe(true);
  });

  it("routes an unexpected provider exit to the turn that is actually running", async () => {
    const first = await startTurn("s1");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await first.turn;

    const secondEvents: HarnessEvent[] = [];
    const userMessages = parse().filter(
      (message) => message.type === "user",
    ).length;
    const second = sendClaudeTurn({
      sessionId: "s1",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      runtimeMode: "supervised",
      text: "try again",
      attachments: [],
      onEvent: (event) => secondEvents.push(event),
    });
    await waitFor(
      () =>
        parse().filter((message) => message.type === "user").length >
        userMessages,
      "second user prompt",
    );

    onExit?.(1);
    await expect(second).rejects.toThrow("Claude Code exited");
    expect(first.events.some((event) => event.type === "session.ended")).toBe(
      false,
    );
    expect(secondEvents).toContainEqual({ type: "session.ended", code: 1 });
    expect(secondEvents).toContainEqual({
      type: "session.error",
      message: "Claude Code exited",
    });
  });
});

describe("claude background tasks", () => {
  it("keeps the turn working through a background command and Claude's follow-up", async () => {
    const { events, turn } = await startTurn("s1");
    let settled = false;
    void turn.then(() => {
      settled = true;
    });

    emitBackgroundBash();
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    expect(events.some((event) => event.type === "message.completed")).toBe(
      false,
    );
    expect(backgroundUpdates(events)).toEqual([
      ["Wait 30 seconds then print done"],
    ]);

    emitBashFinished();
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);

    emitFollowUpTurn("It finished and printed done.");
    await turn;
    expect(backgroundUpdates(events)).toEqual([
      ["Wait 30 seconds then print done"],
      [],
    ]);
    // The command waited on sits under the message Claude left off with as
    // a row of its own, and the reply is a new message after it, once.
    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    const turn1 = session.blocks.slice(1);
    const background = turn1.find((block) => block.tool?.background);
    expect(background?.tool).toMatchObject({
      callId: "background:b1",
      status: "completed",
      detail:
        'Background command "sleep 30 && echo done" completed (exit code 0)',
    });
    expect(background?.text).toContain("sleep 30");
    expect(
      turn1
        .filter((block) => block.role === "assistant" || block.tool?.background)
        .map((block) => (block.tool?.background ? "[background]" : block.text)),
    ).toEqual(["waiting", "[background]", "It finished and printed done."]);
    const items = groupTurnItems(turn1, { settled: true });
    const fold = foldableWork(items);
    const answer = items.at(-1);
    expect(answer?.type === "block" && answer.block.text).toBe(
      "It finished and printed done.",
    );
    // What Claude yielded with is its answer; the follow-up does not fold it.
    expect(
      (fold ? foldedBlocks(items, fold) : []).map((block) => block.text),
    ).not.toContain("waiting");
  });

  it("shows the waited-on command as a live row under Claude's last message", async () => {
    const { events } = await startTurn("s1");
    emitBackgroundBash();
    await new Promise((r) => setTimeout(r, 10));

    const session = events.reduce(
      applyHarnessEvent,
      newSession("claude", "/repo"),
    );
    const last = session.blocks.at(-1);
    expect(session.blocks.at(-2)?.text).toBe("waiting");
    expect(last?.tool).toMatchObject({
      background: true,
      status: "in_progress",
      kind: "execute",
    });
    const items = groupTurnItems(session.blocks.slice(1));
    const group = items.at(-1);
    expect(group?.type === "activity" && workSummaryLine(group.blocks, true)).toBe(
      "Running in background",
    );
  });

  it("lets the turn go if a finished task never wakes Claude", async () => {
    const { turn } = await startTurn("s1");
    let settled = false;
    void turn.then(() => {
      settled = true;
    });
    emitBackgroundBash();

    vi.useFakeTimers();
    try {
      emitBashFinished();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops background commands when the turn is stopped", async () => {
    const { events, turn } = await startTurn("s1");
    emitBackgroundBash("b7");

    await cancelClaudeTurn("s1");
    await turn;
    const requests = parse().flatMap((m) => {
      const request = m.request as Record<string, unknown> | undefined;
      return request ? [request] : [];
    });
    expect(requests).toContainEqual({ subtype: "stop_task", task_id: "b7" });
    expect(requests.at(-1)).toEqual({ subtype: "interrupt" });
    expect(events.some((event) => event.type === "message.completed")).toBe(
      true,
    );
  });
});

describe("claude plan permissions", () => {
  it("answers residual plan-mode permissions without prompting the user", async () => {
    const { events, turn } = await startTurn("s1", {
      runtimeMode: "auto",
      intent: "plan",
    });

    emit({
      type: "control_request",
      request_id: "read_1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Read",
        input: { file_path: "/repo/src/App.tsx" },
      },
    });
    emit({
      type: "control_request",
      request_id: "write_1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Write",
        input: { file_path: "/repo/src/new.ts" },
      },
    });

    await waitFor(
      () =>
        parse().filter((message) => message.type === "control_response")
          .length >= 2,
      "plan permission responses",
    );
    const responses = parse().filter(
      (message) => message.type === "control_response",
    );
    const read = responses.find(
      (message) =>
        (message.response as Record<string, unknown>)?.request_id === "read_1",
    );
    const write = responses.find(
      (message) =>
        (message.response as Record<string, unknown>)?.request_id === "write_1",
    );
    expect(
      (
        (read?.response as Record<string, unknown>)?.response as Record<
          string,
          unknown
        >
      )?.behavior,
    ).toBe("allow");
    expect(
      (
        (write?.response as Record<string, unknown>)?.response as Record<
          string,
          unknown
        >
      )?.behavior,
    ).toBe("deny");
    expect(events.some((event) => event.type === "approval.requested")).toBe(
      false,
    );

    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
  });

  it("leaves the captured plan ready to build after a subagent explored for it", async () => {
    const { events, turn } = await startTurn("s1", { intent: "plan" });
    let settled = false;
    void turn.then(() => {
      settled = true;
    });

    emitInlineSubagent();
    emit({
      type: "control_request",
      request_id: "exit_1",
      request: {
        subtype: "can_use_tool",
        tool_name: "ExitPlanMode",
        tool_use_id: "toolu_exit",
        input: { plan: "# Plan\n\nRewrite the auth module." },
      },
    });
    await waitFor(
      () =>
        parse().some(
          (message) =>
            (message.response as Record<string, unknown>)?.request_id ===
            "exit_1",
        ),
      "exit plan mode response",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });

    // The turn must end for the session to stop being busy; until it does, the
    // plan's Build control stays disabled however the plan block itself reads.
    await turn;
    expect(settled).toBe(true);

    let session = newSession("claude", "/repo");
    for (const event of events) session = applyHarnessEvent(session, event);
    const plan = session.blocks.find((block) => block.role === "plan");
    expect(plan?.text).toContain("Rewrite the auth module.");
    expect(plan?.streaming).toBeFalsy();
    expect(plan?.plan?.status).toBe("ready");
  });
});

describe("claude manual compaction", () => {
  it("runs the built-in command and requires a compact boundary", async () => {
    const { turn } = await startTurn("s1");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
    sent.length = 0;

    const events: HarnessEvent[] = [];
    const compact = compactClaudeContext({
      sessionId: "s1",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      runtimeMode: "supervised",
      onEvent: (event) => events.push(event),
    });
    await waitFor(
      () => parse().some((message) => message.type === "user"),
      "compact command",
    );
    expect(parse().find((message) => message.type === "user")).toMatchObject({
      message: { content: [{ type: "text", text: "/compact" }] },
    });

    emit({
      type: "assistant",
      session_id: "sess_1",
      message: { content: [{ type: "text", text: "not transcript output" }] },
    });
    emit({
      type: "system",
      subtype: "compact_boundary",
      session_id: "sess_1",
    });
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await compact;

    expect(events).toContainEqual({
      type: "status",
      text: "Compacted context",
    });
    expect(events.some((event) => event.type === "message.delta")).toBe(false);
  });
});

describe("claude slash commands", () => {
  /** Send one prompt as the first turn of a fresh session. */
  async function sendCommand(
    text: string,
    modelSettings: Record<string, string> = {},
  ) {
    const events: HarnessEvent[] = [];
    const turn = sendClaudeTurn({
      sessionId: "s1",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      modelSettings,
      runtimeMode: "supervised",
      text,
      attachments: [],
      onEvent: (event) => events.push(event),
    });
    await waitFor(() => parse().length > 0, "initialize");
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await waitFor(() => parse().some((m) => m.type === "user"), "command");
    return { events, turn };
  }

  /** Claude answers a built-in command itself, without a model call. */
  function emitCommandReply(text: string, init: Record<string, unknown> = {}) {
    emit({ type: "system", subtype: "init", session_id: "sess_1", ...init });
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: {
        model: "<synthetic>",
        content: [{ type: "text", text }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    emit({
      type: "result",
      subtype: "success",
      num_turns: 0,
      session_id: "sess_1",
      result: text,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  }

  it("sends a command as typed and shows Claude's reply as the answer", async () => {
    const { events, turn } = await sendCommand("/advisor opus", {
      effort: "ultrathink",
    });
    expect(parse().find((m) => m.type === "user")).toMatchObject({
      message: { content: [{ type: "text", text: "/advisor opus" }] },
    });

    emitCommandReply("Advisor set to Opus 5.5");
    await turn;

    expect(events).toContainEqual({
      type: "message.delta",
      text: "Advisor set to Opus 5.5",
    });
    expect(events.some((event) => event.type === "context")).toBe(false);
    expect(events.some((event) => event.type === "session.configChanged")).toBe(
      false,
    );
  });

  it("offers the commands a running session reports, and its later changes", async () => {
    const onCommands = vi.fn();
    claudeCommandProvider.subscribe!({ cwd: "/repo" }, onCommands);
    const { turn } = await startTurn("s1");
    emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "monocode_2",
        response: {
          commands: [
            { name: "advisor", description: "", argumentHint: "[opus|off]" },
          ],
        },
      },
    });

    await expect(
      claudeCommandProvider.discover({ cwd: "/repo", sessionId: "s1" }),
    ).resolves.toMatchObject([{ name: "advisor", inputHint: "[opus|off]" }]);
    expect(spawned).toHaveLength(1);

    emit({
      type: "system",
      subtype: "commands_changed",
      commands: [{ name: "advisor" }, { name: "new-skill" }],
    });
    expect(onCommands).toHaveBeenLastCalledWith([
      expect.objectContaining({ name: "advisor" }),
      expect.objectContaining({ name: "new-skill" }),
    ]);

    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
  });

  const asRequest = (message: Record<string, unknown>) =>
    message.request as Record<string, unknown> | undefined;

  const askedForSettings = () =>
    parse().find((m) => asRequest(m)?.subtype === "get_settings");

  /** Claude's answer to the `get_settings` request a settings command ends with. */
  async function emitApplied(applied: Record<string, unknown> | null) {
    await waitFor(() => !!askedForSettings(), "get_settings");
    const requestId = askedForSettings()!.request_id;
    emit({
      type: "control_response",
      response: applied
        ? {
            subtype: "success",
            request_id: requestId,
            response: { effective: {}, sources: [], applied },
          }
        : {
            subtype: "error",
            request_id: requestId,
            error: "Unsupported control request subtype: get_settings",
          },
    });
  }

  const configChanges = (events: HarnessEvent[]) =>
    events.filter((event) => event.type === "session.configChanged");

  it.each([
    // The old model's wide window must not carry over to the next launch.
    { reported: "claude-opus-5-5", model: "claude:opus-5-5", context: "200k" },
    {
      reported: "claude-opus-5-5[1m]",
      model: "claude:opus-5-5",
      context: "1m",
    },
    // Claude reports some models by their dated id.
    {
      reported: "claude-haiku-4-5-20251001",
      model: "claude:haiku-4.5",
      context: "200k",
    },
  ])(
    "moves MonoCode's model to the one /model switched Claude to: $reported",
    async ({ reported, model, context }) => {
      const { events, turn } = await sendCommand("/model x", { context: "1m" });
      let done = false;
      void turn.then(() => (done = true));
      emitCommandReply("Set model for this session only");
      await waitFor(() => !!askedForSettings(), "get_settings");
      // The turn stays open until the selector has been told.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(done).toBe(false);

      await emitApplied({ model: reported, effort: "high" });
      await turn;
      expect(configChanges(events)).toEqual([
        { type: "session.configChanged", model, modelSettings: { context } },
      ]);
    },
  );

  it("asks for the new model's window after /model switches it", async () => {
    const { events, turn } = await sendCommand("/model opus");
    emitCommandReply("Set model to Opus 5.5");
    await emitApplied({ model: "claude-opus-5-5[1m]", effort: "high" });
    await turn;

    const probes = () =>
      parse().filter((m) => asRequest(m)?.subtype === "get_context_usage");
    await waitFor(() => probes().length === 2, "second get_context_usage");
    emit({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: probes()[1]!.request_id,
        response: { totalTokens: 50_000, maxTokens: 1_000_000 },
      },
    });
    // Only the window: the level is still the one the switch turn reported.
    expect(events.filter((event) => event.type === "context")).toEqual([
      { type: "context", window: 1_000_000 },
    ]);
  });

  it("keeps MonoCode's model when Claude is still on it or does not say", async () => {
    const same = await sendCommand("/model sonnet");
    emitCommandReply("Set model to `Sonnet 5`");
    await emitApplied({ model: "claude-sonnet-5[1m]", effort: "max" });
    await same.turn;
    expect(configChanges(same.events)).toEqual([]);

    sent.length = 0;
    const events: HarnessEvent[] = [];
    const old = sendClaudeTurn({
      sessionId: "s1",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      modelSettings: {},
      runtimeMode: "supervised",
      text: "/model opus",
      attachments: [],
      onEvent: (event) => events.push(event),
    });
    await waitFor(() => parse().some((m) => m.type === "user"), "command");
    emitCommandReply("Set model to `Opus 5.5`");
    await emitApplied(null);
    await old;
    expect(configChanges(events)).toEqual([]);
  });

  it.each([
    { text: "/effort max", applied: { effort: "max" }, effort: "max" },
    { text: "/effort auto", applied: { effort: "medium" }, effort: "medium" },
    {
      text: "/effort ultracode on",
      applied: { effort: "xhigh", ultracode: true },
      effort: "ultracode",
    },
    // Nothing to move: already selected, refused, or not offered for the model.
    { text: "/effort high", applied: { effort: "high" }, effort: null },
    { text: "/effort bogus", applied: { effort: "medium" }, effort: null },
    { text: "/effort turbo", applied: { effort: "turbo" }, effort: null },
  ])(
    "moves MonoCode's effort to what $text applied",
    async ({ text, applied, effort }) => {
      // The live catalog is what tells MonoCode which levels a model offers.
      setHarnessModels("claude", CLAUDE_MODEL_CATALOG);
      try {
        const { events, turn } = await sendCommand(text, { effort: "high" });
        emitCommandReply("Set effort level (this session only)");
        await emitApplied({ model: "claude-opus-5-5", ...applied });
        await turn;

        expect(configChanges(events)).toEqual(
          effort
            ? [{ type: "session.configChanged", modelSettings: { effort } }]
            : [],
        );
      } finally {
        resetHarnessModelOverlays();
      }
    },
  );

  it.each([
    { from: "claude:sonnet", reported: "claude-opus-5-5", to: "claude:opus" },
    { from: "claude:opus", reported: "claude-haiku-4-5-20251001", to: "claude:haiku" },
    { from: "claude:sonnet", reported: "claude-sonnet-5-5", to: null },
    { from: "claude:sonnet-5", reported: "claude-sonnet-5", to: null },
  ])(
    "matches the aliases Claude lists to the model it runs: $from -> $reported",
    async ({ from, reported, to }) => {
      // The shape `list_models` returns: current models only as aliases.
      setHarnessModels(
        "claude",
        modelsFromClaudeListModels([
          { value: "default", resolvedModel: "claude-opus-5-5" },
          { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus" },
          { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet" },
          { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku" },
          { value: "claude-sonnet-5", resolvedModel: "claude-sonnet-5" },
        ]),
      );
      try {
        const events: HarnessEvent[] = [];
        const turn = sendClaudeTurn({
          sessionId: "s1",
          cwd: "/repo",
          model: from,
          modelSettings: {},
          runtimeMode: "supervised",
          text: "/model x",
          attachments: [],
          onEvent: (event) => events.push(event),
        });
        await waitFor(() => parse().length > 0, "initialize");
        emit({ type: "system", subtype: "init", session_id: "sess_1" });
        await waitFor(() => parse().some((m) => m.type === "user"), "command");
        emitCommandReply("Set model for this session only");
        await emitApplied({ model: reported, effort: "high" });
        await turn;

        expect(configChanges(events).map((event) => event.model)).toEqual(
          to ? [to] : [],
        );
      } finally {
        resetHarnessModelOverlays();
      }
    },
  );

  it("follows a /model sent mid-turn once Claude has run it", async () => {
    const { events, turn } = await startTurn("s1");
    await steerClaudeTurn({
      sessionId: "s1",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      text: "/model opus",
    });

    // The turn that was running ends first; the command has not run yet.
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
    expect(askedForSettings()).toBeUndefined();

    emitCommandReply("Set model to `Opus 5.5` for this session only");
    await emitApplied({ model: "claude-opus-5-5", effort: "high" });
    expect(configChanges(events)).toMatchObject([{ model: "claude:opus-5-5" }]);
  });

  it("does not ask what was applied for a bare /model", async () => {
    const { events, turn } = await sendCommand("/model");
    emitCommandReply("Current model: Sonnet 5");
    await turn;

    expect(askedForSettings()).toBeUndefined();
    expect(configChanges(events)).toEqual([]);
  });

  it("ends a settings turn even if Claude never says what it applied", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const events: HarnessEvent[] = [];
      const turn = sendClaudeTurn({
        sessionId: "s1",
        cwd: "/repo",
        model: "claude:claude-sonnet-5",
        modelSettings: {},
        runtimeMode: "supervised",
        text: "/effort max",
        attachments: [],
        onEvent: (event) => events.push(event),
      });
      await vi.waitFor(() => expect(parse().length).toBeGreaterThan(0));
      emit({ type: "system", subtype: "init", session_id: "sess_1" });
      await vi.waitFor(() =>
        expect(parse().some((m) => m.type === "user")).toBe(true),
      );
      emitCommandReply("Set effort level to max (this session only)");
      await vi.waitFor(() => expect(askedForSettings()).toBeDefined());

      await vi.advanceTimersByTimeAsync(3_001);
      await turn;
      expect(configChanges(events)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says so when /clear starts a new conversation", async () => {
    const { events, turn } = await sendCommand("/clear");
    emit({
      type: "conversation_reset",
      new_conversation_id: "conv_2",
      trigger: "clear",
      session_id: "sess_1",
    });
    emit({ type: "system", subtype: "init", session_id: "sess_2" });
    emit({
      type: "result",
      subtype: "success",
      num_turns: 0,
      session_id: "sess_2",
      result: "",
    });
    await turn;

    expect(events).toContainEqual({
      type: "status",
      text: "Started a new conversation",
    });
    expect(events).toContainEqual({
      type: "session.providerBound",
      providerSessionId: "sess_2",
    });
  });
});
