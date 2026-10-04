import { describe, expect, it } from "vitest";
import type { HostCommand, Session } from "@monocode/core/session";
import type { OutboxEntry, OutboxState } from "../../storage/repo";
import { queueCardState, shouldQueue } from "../queue";

type Queue = Pick<Session, "queuedMessages" | "queueStatus" | "usageLimit">;

const item = (id: string, text = id, attachments = 0) => ({
  id,
  text,
  attachments: Array.from({ length: attachments }, (_, i) => ({ id: `${id}-${i}`, name: "a.png", mimeType: "image/png", kind: "image" as const, size: 1 })),
});

let at = 0;
const entry = (command: HostCommand, state: OutboxState = "pending"): OutboxEntry => ({
  commandId: command.commandId,
  hostEnv: "h1",
  command,
  createdAt: ++at,
  expiresAt: at + 1_000,
  attempts: 0,
  state,
});

describe("queue card", () => {
  it("is hidden with nothing queued", () => {
    expect(queueCardState({ status: "running", runId: "r", entries: [] })).toBeUndefined();
    expect(queueCardState({ session: { queuedMessages: [] }, status: "idle", entries: [] })).toBeUndefined();
  });

  it("lists the host's items; Steer only while a turn runs", () => {
    const session: Queue = { queuedMessages: [item("q1"), item("q2", "", 2)], queueStatus: "active" };
    const running = queueCardState({ session, status: "running", runId: "r", entries: [] });
    expect(running?.rows).toMatchObject([
      { id: "q1", text: "q1", attachments: 0, pending: false, canSteer: true, canEdit: true },
      { id: "q2", text: "", attachments: 2, canSteer: true },
    ]);
    expect(running?.paused).toBe(false);
    expect(queueCardState({ session, status: "idle", entries: [] })?.rows.every((row) => !row.canSteer)).toBe(true);
  });

  it("shows an unsent queue command as a pending row until the host has it", () => {
    const queued = entry({ type: "queue", commandId: "q3", sessionId: "s1", text: "later" });
    const before = queueCardState({ session: { queuedMessages: [item("q1")] }, status: "running", runId: "r", entries: [queued] });
    expect(before?.rows.map((row) => [row.id, row.pending, row.canEdit, row.canSteer])).toEqual([
      ["q1", false, true, true],
      ["q3", true, false, false],
    ]);
    // Once the host lists it, the host's row wins and there is no duplicate.
    const after = queueCardState({
      session: { queuedMessages: [item("q1"), item("q3", "later")] },
      status: "running",
      runId: "r",
      entries: [{ ...queued, state: "acked" }],
    });
    expect(after?.rows.map((row) => [row.id, row.pending])).toEqual([
      ["q1", false],
      ["q3", false],
    ]);
  });

  it("drops an acked queue command the host ran at once", () => {
    const ran = entry({ type: "queue", commandId: "q4", sessionId: "s1", text: "now" }, "acked");
    expect(queueCardState({ session: { queuedMessages: [] }, status: "running", runId: "r", entries: [ran] })).toBeUndefined();
  });

  it("offers Retry and Discard for a failed queue command", () => {
    const failed = entry({ type: "queue", commandId: "q5", sessionId: "s1", text: "x" }, "failed");
    expect(queueCardState({ status: "running", runId: "r", entries: [failed] })?.rows[0]).toMatchObject({ id: "q5", failedEntry: "q5" });
  });

  it("applies unsent edits, removals and steers", () => {
    const session: Queue = { queuedMessages: [item("q1"), item("q2"), item("q3")] };
    const entries = [
      entry({ type: "editQueued", commandId: "e1", sessionId: "s1", queuedId: "q1", text: "edited" }),
      entry({ type: "unqueue", commandId: "u1", sessionId: "s1", queuedId: "q2" }),
      entry({ type: "steer", commandId: "st", sessionId: "s1", queuedId: "q3", runId: "r" }),
    ];
    const state = queueCardState({ session, status: "running", runId: "r", entries });
    expect(state?.rows.map((row) => [row.id, row.text, row.pending, row.canSteer])).toEqual([
      ["q3", "q3", true, false],
      ["q1", "edited", true, true],
    ]);
    // A failed edit no longer overrides the host's text.
    const failedEdit = queueCardState({ session, status: "running", runId: "r", entries: [{ ...entries[0], state: "failed" }] });
    expect(failedEdit?.rows[0]).toMatchObject({ id: "q1", text: "q1", pending: false });
  });

  it("is paused until a resume is on its way", () => {
    const session: Queue = { queuedMessages: [item("q1")], queueStatus: "paused" };
    expect(queueCardState({ session, status: "idle", entries: [] })).toMatchObject({
      paused: true,
      pausedText: "Queue paused because you interrupted",
    });
    expect(queueCardState({ session: { ...session, usageLimit: {} }, status: "idle", entries: [] })?.pausedText).toBe(
      "Queue paused because the usage limit was reached",
    );
    const resume = entry({ type: "resumeQueue", commandId: "rq", sessionId: "s1" });
    expect(queueCardState({ session, status: "idle", entries: [resume] })?.paused).toBe(false);
  });

  it("queues while running, while items wait, or at a usage limit", () => {
    expect(shouldQueue(undefined, "idle")).toBe(false);
    expect(shouldQueue({ queuedMessages: [] }, "running")).toBe(true);
    expect(shouldQueue({ queuedMessages: [item("q1")] }, "idle")).toBe(true);
    expect(shouldQueue({ usageLimit: { resetsAt: 1 } }, "idle")).toBe(true);
  });
});
