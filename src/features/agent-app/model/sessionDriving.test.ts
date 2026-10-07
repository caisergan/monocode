// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  newSession,
  type Block,
  type Session,
} from "../../sessions/model/session";
import { handleAgentApp, type AgentAppHost } from "./agentApp";
import { createChangeFeed } from "./changeFeed";
import {
  addOperatorWatch,
  collectOperatorNotices,
  markOperatorWatchesSeen,
  operatorWakePrompt,
  type OperatorWatch,
} from "./operatorWatches";
import { appSessionState, turnState } from "./sessionState";

vi.mock("../../../integrations/harness/core/availability", () => ({
  isHarnessAvailable: (id: string) => id === "codex",
}));

const turn = (id: string, text: string, extra: Partial<Block> = {}): Block => ({
  id,
  role: "user",
  text,
  startedAt: 1,
  ...extra,
});
const reply = (id: string, text: string): Block => ({
  id,
  role: "assistant",
  text,
});
const approval = (requestId: number): Block => ({
  id: `approval-${requestId}`,
  role: "approval",
  text: "Run tests",
  approval: { requestId },
  tool: { title: "Run tests", detail: "npm test" },
});

function fixture() {
  const feed = createChangeFeed();
  const source: Session = {
    ...newSession("codex", "/tmp/project", "codex:test"),
    id: "lead",
  };
  const sessions = new Map<string, Session>();
  const add = (id: string, patch: Partial<Session> = {}) => {
    sessions.set(id, {
      ...newSession("codex", source.cwd, "codex:test"),
      id,
      ...patch,
    });
  };
  /** Change a session the way the app does, waking any waiter. */
  const update = (
    id: string,
    patch: (session: Session) => Partial<Session>,
  ) => {
    const session = sessions.get(id)!;
    sessions.set(id, { ...session, ...patch(session) });
    feed.bump();
  };
  const watches: OperatorWatch[] = [];
  const host: AgentAppHost = {
    start: vi.fn(async (launch, id) => {
      add(id, {
        busy: !launch.draft,
        blocks: [turn("launch", launch.prompt, { appRequestId: id })],
      });
    }),
    sessions: vi.fn(async () =>
      [...sessions.values()].map((session) => ({
        id: session.id,
        title: session.title,
        harness: session.harness,
        model: session.model,
        busy: !!session.busy,
        state: appSessionState(session),
        hasDraft: false,
        archived: false,
      })),
    ),
    session: vi.fn(async (id) => sessions.get(id) ?? null),
    send: vi.fn(async (id, prompt, requestId) => {
      const turnId = `turn-${requestId}`;
      update(id, (session) => ({
        busy: true,
        blocks: [
          ...session.blocks,
          turn(turnId, prompt, { appRequestId: requestId }),
        ],
      }));
      return { alreadySubmitted: false, turnId };
    }),
    draft: vi.fn(async () => ({ alreadySaved: false, draft: true })),
    steer: vi.fn(async () => {}),
    respond: vi.fn(),
    answer: vi.fn(),
    revision: () => feed.revision(),
    changed: (since, timeoutMs) => feed.changed(since, timeoutMs),
    watch: vi.fn((watch) => watches.push(watch)),
    seen: vi.fn(),
    worktrees: vi.fn(async () => ({ worktrees: [], defaultRoot: "/tmp" })),
    createWorktree: vi.fn(),
    notes: vi.fn(async () => []),
    note: vi.fn(async () => null),
    saveNote: vi.fn(),
    stop: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    isMono: () => false,
    agentFiles: vi.fn(),
    readAgentFile: vi.fn(),
    writeAgentFile: vi.fn(),
  };
  const call = (action: string, input: Record<string, unknown>, id = "r1") =>
    handleAgentApp(source, id, action, input, host) as Promise<
      Record<string, unknown>
    >;
  return { source, sessions, add, update, host, call, watches };
}

describe("session state", () => {
  it("reports blocked before working, and queued follow-ups as working", () => {
    const base = { ...newSession("codex", "/repo"), id: "s" };
    expect(appSessionState(base)).toBe("idle");
    expect(appSessionState({ ...base, busy: true })).toBe("working");
    expect(
      appSessionState({ ...base, busy: true, blocks: [approval(3)] }),
    ).toBe("blocked");
    expect(
      appSessionState({
        ...base,
        queuedMessages: [{ id: "q", text: "next", attachments: [] }],
      }),
    ).toBe("working");
    expect(appSessionState({ ...base, usageLimit: {} })).toBe("usageLimited");
  });

  it("treats a turn as finished once a later turn starts, but not after a steer", () => {
    const session = {
      ...newSession("codex", "/repo"),
      id: "s",
      busy: true,
      blocks: [
        turn("t1", "first"),
        { id: "steer", role: "user" as const, text: "also check X" },
        reply("a1", "working on it"),
      ],
    };
    expect(turnState(session, "t1")).toBe("working");
    const later = {
      ...session,
      blocks: [...session.blocks, turn("t2", "second")],
    };
    expect(turnState(later, "t1")).toBe("idle");
    expect(turnState(later, "t2")).toBe("working");
    expect(() => turnState(session, "missing")).toThrow("turnId");
  });
});

describe("driving other sessions", () => {
  it("lists state and the names this operator gave its sessions", async () => {
    const f = fixture();
    f.add("app-lead-reviewer", { busy: true });
    f.add("other");
    const listed = (await f.call("sessions.list", {})) as {
      sessions: { id: string; state: string; name?: string }[];
    };
    expect(listed.sessions).toEqual([
      expect.objectContaining({
        id: "app-lead-reviewer",
        name: "reviewer",
        state: "working",
      }),
      expect.not.objectContaining({ name: expect.anything() }),
    ]);
  });

  it("starts a named session, addresses it by name and refuses a duplicate name", async () => {
    const f = fixture();
    const started = await f.call(
      "sessions.start",
      { prompt: "Review the diff", name: "reviewer", notify: true },
      "start-1",
    );
    expect(started).toMatchObject({
      id: "app-lead-reviewer",
      name: "reviewer",
    });
    expect(f.watches).toEqual([
      {
        operatorId: "lead",
        sessionId: "app-lead-reviewer",
        appRequestId: "app-lead-reviewer",
        label: "reviewer",
      },
    ]);
    await expect(
      f.call(
        "sessions.start",
        { prompt: "Again", name: "reviewer" },
        "start-2",
      ),
    ).rejects.toThrow('already have a session named "reviewer"');
    await expect(
      f.call("sessions.start", { prompt: "Bad", name: "Reviewer" }, "start-3"),
    ).rejects.toThrow("name must start");
    const read = await f.call("sessions.read", {
      sessionId: "reviewer",
      turnId: "launch",
    });
    expect(read).toMatchObject({
      sessionId: "app-lead-reviewer",
      name: "reviewer",
      state: "working",
      turn: { turnId: "launch", user: { text: "Review the diff" } },
    });
  });

  it("refuses to send to a blocked or working session, but accepts a retry of a started turn", async () => {
    const f = fixture();
    f.add("app-lead-tests", { busy: true, blocks: [approval(7)] });
    await expect(
      f.call("sessions.send", { sessionId: "tests", prompt: "Go on" }),
    ).rejects.toThrow(
      /blocked on an approval .*requestId 7.*sessions\.respond/,
    );
    f.add("user-session", { busy: true });
    await expect(
      f.call("sessions.send", { sessionId: "user-session", prompt: "Go on" }),
    ).rejects.toThrow("sessions.wait");
    f.update("user-session", (session) => ({
      blocks: [turn("t1", "Go on", { appRequestId: "app-lead-retry" })],
      busy: session.busy,
    }));
    await f.call(
      "sessions.send",
      { sessionId: "user-session", prompt: "Go on" },
      "retry",
    );
    expect(f.host.send).toHaveBeenCalledWith(
      "user-session",
      "Go on",
      "app-lead-retry",
    );
  });

  it("sends with wait and returns the final message once that turn settles", async () => {
    const f = fixture();
    f.add("other", { blocks: [] });
    const pending = f.call(
      "sessions.send",
      { sessionId: "other", prompt: "Review it", wait: { timeoutSeconds: 5 } },
      "send-1",
    );
    await vi.waitFor(() => expect(f.host.send).toHaveBeenCalled());
    f.update("other", (session) => ({
      blocks: [...session.blocks, reply("a1", "Looks good")],
    }));
    f.update("other", () => ({ busy: false }));
    expect(await pending).toMatchObject({
      sessionId: "other",
      turnId: "turn-app-lead-send-1",
      matched: true,
      state: "idle",
      turn: { assistant: { text: "Looks good", truncated: false } },
    });
  });

  it("finds the turnId of a submission that lands after acceptance", async () => {
    const f = fixture();
    f.add("other", { blocks: [] });
    vi.mocked(f.host.send).mockImplementationOnce(
      async (id, prompt, requestId) => {
        setTimeout(() =>
          f.update(id, (session) => ({
            busy: true,
            blocks: [
              ...session.blocks,
              turn("late", prompt, { appRequestId: requestId }),
            ],
          })),
        );
        return { alreadySubmitted: false };
      },
    );
    expect(
      await f.call("sessions.send", { sessionId: "other", prompt: "Go" }),
    ).toEqual({
      sessionId: "other",
      submitted: true,
      alreadySubmitted: false,
      turnId: "late",
    });
  });

  it("waits on several sessions and returns when any settles, or reports a timeout", async () => {
    const f = fixture();
    f.add("a", { busy: true });
    f.add("b", { busy: true });
    const pending = f.call("sessions.wait", {
      sessionIds: ["a", "b"],
      timeoutSeconds: 5,
    });
    f.update("b", () => ({ busy: true, blocks: [approval(4)] }));
    const result = (await pending) as {
      matched: boolean;
      sessions: { sessionId: string; state: string; needsInput?: object }[];
    };
    expect(result.matched).toBe(true);
    expect(result.sessions).toEqual([
      expect.objectContaining({ sessionId: "a", state: "working" }),
      expect.objectContaining({
        sessionId: "b",
        state: "blocked",
        needsInput: expect.objectContaining({
          requestId: 4,
          detail: "npm test",
        }),
      }),
    ]);
    expect(
      await f.call("sessions.wait", { sessionId: "a", timeoutSeconds: 0 }),
    ).toMatchObject({ matched: false });
    await expect(
      f.call("sessions.wait", { sessionId: "a", timeoutSeconds: 60 }),
    ).rejects.toThrow("0 to 25");
    await expect(
      f.call("sessions.wait", { sessionIds: ["a"], turnId: "t" }),
    ).rejects.toThrow("turnId waits on one session");
  });

  it("steers only a running turn", async () => {
    const f = fixture();
    f.add("idle");
    await expect(
      f.call("sessions.steer", { sessionId: "idle", prompt: "Stop" }),
    ).rejects.toThrow("not running a turn");
    f.add("running", { busy: true });
    expect(
      await f.call("sessions.steer", {
        sessionId: "running",
        prompt: "Skip X",
      }),
    ).toEqual({ sessionId: "running", steered: true });
    expect(f.host.steer).toHaveBeenCalledWith("running", "Skip X");
  });

  it("decides approvals and questions only for sessions this operator started", async () => {
    const f = fixture();
    f.add("user-session", { busy: true, blocks: [approval(2)] });
    await expect(
      f.call("sessions.respond", {
        sessionId: "user-session",
        requestId: 2,
        decision: "allow",
      }),
    ).rejects.toThrow("Only sessions you started");
    f.add("app-lead-tests", { busy: true, blocks: [approval(5)] });
    await expect(
      f.call("sessions.respond", {
        sessionId: "tests",
        requestId: 4,
        decision: "allow",
      }),
    ).rejects.toThrow("Stale requestId");
    expect(
      await f.call("sessions.respond", {
        sessionId: "tests",
        requestId: 5,
        decision: "deny",
      }),
    ).toEqual({ sessionId: "app-lead-tests", decision: "deny" });
    expect(f.host.respond).toHaveBeenCalledWith("app-lead-tests", 5, "deny");
    f.add("app-lead-asker", {
      busy: true,
      pendingQuestion: {
        requestId: 9,
        questions: [
          {
            id: "q",
            prompt: "Which?",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          },
        ],
      } as unknown as Session["pendingQuestion"],
    });
    expect(
      await f.call("sessions.answer", {
        sessionId: "asker",
        requestId: 9,
        answers: { q: ["b"] },
      }),
    ).toEqual({ sessionId: "app-lead-asker", answered: true });
    expect(f.host.answer).toHaveBeenCalledWith("app-lead-asker", 9, {
      kind: "answered",
      answers: { q: ["b"] },
    });
  });
});

describe("operator notifications", () => {
  const watch: OperatorWatch = {
    operatorId: "lead",
    sessionId: "reviewer-id",
    appRequestId: "req",
    label: "reviewer",
  };
  const session = (patch: Partial<Session>): Session => ({
    ...newSession("codex", "/repo"),
    id: "reviewer-id",
    ...patch,
  });

  it("keeps a running turn, announces a block once and delivers the finished turn", () => {
    const running = session({
      busy: true,
      blocks: [turn("t1", "Review", { appRequestId: "req" })],
    });
    expect(collectOperatorNotices([watch], () => running).notices).toEqual([]);

    const blocked = { ...running, blocks: [...running.blocks, approval(3)] };
    const first = collectOperatorNotices([watch], () => blocked);
    expect(first.notices.map((notice) => notice.state)).toEqual(["blocked"]);
    expect(first.remaining[0].announcedRequestId).toBe(3);
    expect(
      collectOperatorNotices(first.remaining, () => blocked).notices,
    ).toEqual([]);

    const done = session({
      blocks: [
        turn("t1", "Review", { appRequestId: "req" }),
        reply("a", "Ship it"),
      ],
    });
    const finished = collectOperatorNotices(first.remaining, () => done);
    expect(finished.remaining).toEqual([]);
    const prompt = operatorWakePrompt(finished.notices);
    expect(prompt).toContain("reviewer (reviewer-id) finished turn t1");
    expect(prompt).toContain("Ship it");
    expect(
      collectOperatorNotices([watch], () => undefined).notices[0].state,
    ).toBe("closed");
  });

  it("stops watching a turn the operator already saw settle through a wait", () => {
    const other = { ...watch, sessionId: "other" };
    const running = session({
      busy: true,
      blocks: [turn("t1", "Review", { appRequestId: "req" })],
    });
    expect(markOperatorWatchesSeen([watch, other], "lead", running)).toEqual([
      watch,
      other,
    ]);
    const blocked = { ...running, blocks: [...running.blocks, approval(6)] };
    expect(
      markOperatorWatchesSeen([watch], "lead", blocked)[0].announcedRequestId,
    ).toBe(6);
    const done = { ...running, busy: false };
    expect(markOperatorWatchesSeen([watch, other], "lead", done)).toEqual([
      other,
    ]);
  });

  it("registers a watch once and caps how many one operator holds", () => {
    let watches = addOperatorWatch([], watch);
    expect(addOperatorWatch(watches, { ...watch })).toBe(watches);
    for (let i = 0; i < 40; i += 1)
      watches = addOperatorWatch(watches, { ...watch, appRequestId: `r${i}` });
    expect(watches).toHaveLength(32);
    expect(watches.some((entry) => entry.appRequestId === "req")).toBe(false);
  });
});

describe("change feed", () => {
  it("returns at once for a stale revision and otherwise waits for a change", async () => {
    const feed = createChangeFeed();
    const since = feed.revision();
    feed.bump();
    await feed.changed(since, 10_000);
    let resolved = false;
    const pending = feed
      .changed(feed.revision(), 10_000)
      .then(() => (resolved = true));
    await Promise.resolve();
    expect(resolved).toBe(false);
    feed.bump();
    await pending;
    expect(resolved).toBe(true);
  });
});
