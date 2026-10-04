import type { OrchestrationRun, TaskStatus } from "./orchestration";
import { sessionNeedsInput, type HarnessId, type Session } from "../../sessions/model/session";

/** Small history projection; never includes prompts, results or credentials. */
export type OrchestrationSummary = {
  status: OrchestrationRun["status"];
  live?: boolean;
  tasks: {
    sessionId: string;
    title: string;
    harness: HarnessId;
    model: string;
    status: TaskStatus;
    needsInput?: boolean;
    /** Stopped by a usage limit; continues at the reset. */
    usageLimited?: boolean;
    /** Where the worker writes, once it has a checkout of its own. */
    branch?: string;
    worktreeCwd?: string;
  }[];
};

export function summarizeOrchestration(
  run: OrchestrationRun,
  sessions: readonly Session[],
): OrchestrationSummary {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return {
    status: run.status,
    live: true,
    tasks: run.tasks.map(
      ({ sessionId, title, harness, model, status, usageLimit, workspace }) => ({
        sessionId,
        title,
        harness,
        model,
        status,
        needsInput:
          !!byId.get(sessionId) && sessionNeedsInput(byId.get(sessionId)!),
        ...(status === "running" && usageLimit ? { usageLimited: true } : {}),
        ...(workspace?.branch ? { branch: workspace.branch } : {}),
        ...(workspace?.kind === "worktree"
          ? { worktreeCwd: workspace.checkoutCwd }
          : {}),
      }),
    ),
  };
}

export function orchestrationTaskLabel(
  task: OrchestrationSummary["tasks"][number],
  summary: OrchestrationSummary,
): string {
  if (task.needsInput) return "Needs input";
  if (
    !summary.live &&
    ["running", "cancelling", "queued"].includes(task.status)
  )
    return "Saved";
  if (task.usageLimited && task.status === "running") return "Usage limit";
  if (summary.status === "paused" && task.status === "queued") return "Paused";
  return {
    queued: "Queued",
    running: "Working",
    cancelling: "Stopping",
    completed: "Done",
    failed: "Failed",
    blocked: "Needs review",
    interrupted: "Interrupted",
    cancelled: "Cancelled",
  }[task.status];
}
