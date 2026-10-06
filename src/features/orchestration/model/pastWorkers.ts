import { invoke } from "@tauri-apps/api/core";
import type { HarnessId } from "../../sessions/model/session";

/**
 * A worker a lead ran in an earlier run. A lead keeps only its latest run, so
 * these stay attached to it through the worker index rather than the run.
 */
export type PastOrchestrationWorker = {
  sessionId: string;
  title: string;
  harness: HarnessId;
  model: string;
  branch?: string | null;
  worktreeCwd?: string | null;
  updatedAt: number;
};

export const loadPastWorkers = (leadId: string) =>
  invoke<PastOrchestrationWorker[]>("control_past_workers", { leadId });

/** Earlier workers grouped by the local day they last worked, newest first. */
export function groupPastWorkersByDay(
  workers: readonly PastOrchestrationWorker[],
  now = Date.now(),
): { label: string; workers: PastOrchestrationWorker[] }[] {
  const dayKey = (time: number) => new Date(time).toDateString();
  const today = dayKey(now);
  const yesterday = dayKey(now - 86_400_000);
  const groups = new Map<string, PastOrchestrationWorker[]>();
  for (const worker of [...workers].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const key = dayKey(worker.updatedAt);
    groups.set(key, [...(groups.get(key) ?? []), worker]);
  }
  return [...groups].map(([key, list]) => ({
    label:
      key === today
        ? "Today"
        : key === yesterday
          ? "Yesterday"
          : new Date(list[0].updatedAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            }),
    workers: list,
  }));
}
