import { describe, expect, it } from "vitest";
import { groupPastWorkersByDay } from "./pastWorkers";

const worker = (sessionId: string, updatedAt: number) => ({
  sessionId,
  title: sessionId,
  harness: "claude" as const,
  model: "claude:test",
  updatedAt,
});

describe("groupPastWorkersByDay", () => {
  it("groups by local day, newest first, naming today and yesterday", () => {
    const now = new Date(2026, 9, 6, 18, 0).getTime();
    const groups = groupPastWorkersByDay(
      [
        worker("older", new Date(2026, 9, 4, 12, 0).getTime()),
        worker("morning", new Date(2026, 9, 6, 7, 0).getTime()),
        worker("evening", new Date(2026, 9, 6, 17, 0).getTime()),
        worker("yesterday", new Date(2026, 9, 5, 23, 0).getTime()),
      ],
      now,
    );
    expect(groups.map((group) => group.label)).toEqual([
      "Today",
      "Yesterday",
      new Date(2026, 9, 4).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
    ]);
    expect(groups[0].workers.map((entry) => entry.sessionId)).toEqual([
      "evening",
      "morning",
    ]);
  });
});
