import { describe, expect, it } from "vitest";
import type { UserQuestion } from "@monocode/core/session";
import type { OutboxEntry } from "../../storage/repo";
import { optimisticBlocks, pendingMarks, sendingApprovals } from "../../transcript/optimistic";
import { composeCommand, leadingMode, slashCommands, slashMatches, type ComposeInput } from "../command";
import { autoResolveText, buildReply, questionComplete, questionOptions, toggleOption, type Answers } from "../question";

const base: ComposeInput = {
  commandId: "c1",
  sessionId: "s1",
  text: "hello",
  attachments: [],
  mode: "default",
  queue: false,
  running: false,
  capabilities: { queue: true },
};

describe("composer commands", () => {
  it("sends when idle and queues while running", () => {
    expect(composeCommand(base)).toEqual({ command: { type: "send", commandId: "c1", sessionId: "s1", text: "hello" } });
    expect(composeCommand({ ...base, queue: true, running: true, mode: "plan" })).toEqual({
      command: { type: "queue", commandId: "c1", sessionId: "s1", text: "hello", intent: "plan" },
    });
    expect(composeCommand({ ...base, queue: true, running: true, capabilities: { queue: false } })).toEqual({
      error: "Wait for the agent to finish, or stop it.",
    });
  });

  it("reads a leading /plan, /draft or a bare /compact", () => {
    expect(leadingMode("/plan fix it")).toEqual({ mode: "plan", rest: "fix it" });
    expect(leadingMode("/planet")).toEqual({ rest: "/planet" });
    expect(composeCommand({ ...base, text: "/plan fix it" })).toMatchObject({ command: { type: "send", intent: "plan", text: "fix it" } });
    expect(composeCommand({ ...base, text: "/draft later" })).toMatchObject({ command: { type: "draft", text: "later" } });
    expect(composeCommand({ ...base, text: "/compact" })).toEqual({ command: { type: "compact", commandId: "c1", sessionId: "s1" } });
    expect(composeCommand({ ...base, text: "/compact", running: true })).toMatchObject({ error: expect.any(String) });
  });

  it("sends files without text", () => {
    const file = { id: "f", name: "a.jpg", mimeType: "image/jpeg", kind: "image" as const, size: 3 };
    expect(composeCommand({ ...base, text: " ", attachments: [file] })).toMatchObject({ command: { type: "send", text: "", attachments: [file] } });
    expect(composeCommand({ ...base, text: " " })).toMatchObject({ error: expect.any(String) });
  });

  it("filters the slash picker by capability and prefix", () => {
    const all = slashCommands({ plan: true, draft: true });
    expect(all.map((command) => command.name)).toEqual(["/plan", "/draft", "/compact"]);
    expect(slashCommands({ plan: false, draft: false }).map((command) => command.name)).toEqual(["/compact"]);
    expect(slashMatches("/", all)?.length).toBe(3);
    expect(slashMatches("/co", all)?.map((command) => command.name)).toEqual(["/compact"]);
    expect(slashMatches("/x", all)).toEqual([]);
    expect(slashMatches("/plan now", all)).toBeUndefined();
    expect(slashMatches("hi", all)).toBeUndefined();
  });
});

describe("question form", () => {
  const single: UserQuestion = {
    id: "q1",
    prompt: "Which database?",
    multiSelect: false,
    allowCustom: true,
    options: [
      { id: "pg", label: "Postgres" },
      { id: "sqlite", label: "SQLite" },
    ],
  };
  const multi: UserQuestion = { id: "q2", prompt: "Targets?", multiSelect: true, allowCustom: false, options: [{ id: "ios", label: "iOS" }, { id: "web", label: "Web" }] };
  const empty: Answers = { selected: {}, custom: {} };

  it("adds Other for free text and needs its text", () => {
    expect(questionOptions(single).map((option) => option.label)).toEqual(["Postgres", "SQLite", "Other"]);
    const other = toggleOption(empty, single, "__custom__");
    expect(questionComplete(single, other)).toBe(false);
    expect(questionComplete(single, { ...other, custom: { q1: "Mongo" } })).toBe(true);
  });

  it("toggles single and multi choices", () => {
    let answers = toggleOption(empty, single, "pg");
    answers = toggleOption(answers, single, "sqlite");
    expect(answers.selected.q1).toEqual(["sqlite"]);
    answers = toggleOption(answers, multi, "ios");
    answers = toggleOption(answers, multi, "web");
    answers = toggleOption(answers, multi, "ios");
    expect(answers.selected.q2).toEqual(["web"]);
  });

  it("replies with the answered questions, or a skip", () => {
    expect(buildReply([single, multi], empty)).toEqual({ kind: "skipped" });
    const answers = toggleOption(toggleOption(empty, single, "__custom__"), multi, "web");
    expect(buildReply([single, multi], { ...answers, custom: { q1: " Mongo " } })).toEqual({
      kind: "answered",
      answers: { q1: ["__custom__"], q2: ["web"] },
      custom: { q1: "Mongo" },
    });
  });

  it("counts down to the host's deadline", () => {
    expect(autoResolveText(undefined, 0)).toBeUndefined();
    expect(autoResolveText(14_000, 100)).toBe("Continues without an answer in 14s");
    expect(autoResolveText(0, 5_000)).toBe("Continues without an answer in 0s");
  });
});

describe("optimistic transcript", () => {
  const entry = (extra: Partial<OutboxEntry>): OutboxEntry => ({
    commandId: "c1",
    hostEnv: "h1",
    command: { type: "send", commandId: "c1", sessionId: "s1", text: "hi" },
    createdAt: 5,
    expiresAt: 10,
    attempts: 0,
    state: "pending",
    ...extra,
  });

  it("shows sends and a create's first message until their blocks arrive", () => {
    const create = entry({
      commandId: "k1",
      command: { type: "create", commandId: "k1", projectId: "p", harness: "claude", model: "m", runtimeMode: "supervised", initial: { text: "first" } },
    });
    const approve = entry({ commandId: "a1", command: { type: "approve", commandId: "a1", sessionId: "s1", runId: "r", requestId: 4, decision: "allow" } });
    const blocks = optimisticBlocks([create, entry({}), approve], new Set());
    expect(blocks.map((block) => [block.id, block.text])).toEqual([
      ["k1", "first"],
      ["c1", "hi"],
    ]);
    expect(optimisticBlocks([entry({})], new Set(["c1"]))).toEqual([]);
    expect([...sendingApprovals([approve])]).toEqual([4]);
  });

  it("labels Sending…, Waiting for the machine, and Not sent", () => {
    expect(pendingMarks([entry({})], "mac", true).get("c1")).toEqual({ label: "Sending…" });
    expect(pendingMarks([entry({})], "mac", false).get("c1")).toEqual({ label: "Waiting for mac" });
    expect(pendingMarks([entry({ state: "acked" })], "mac", false).get("c1")).toEqual({ label: "Sending…" });
    expect(pendingMarks([entry({ state: "failed", error: { code: "offline", message: "x", retryable: false, data: { expired: true } } })], "mac", true).get("c1")).toEqual({
      label: "Not sent",
      failed: { commandId: "c1", text: "Not sent. mac was unreachable." },
    });
  });
});
