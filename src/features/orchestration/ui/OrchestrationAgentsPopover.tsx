import { useContext, useEffect, useRef, useState, type RefObject } from "react";
import { Popover } from "../../../shared/ui/Popover";
import { HarnessIcon } from "../../sessions/ui/HarnessIcon";
import { sessionDisplayTitle, type HarnessId } from "../../sessions/model/session";
import {
  orchestrationTaskLabel,
  orchestrationTaskTone,
  type OrchestrationSummary,
} from "../model/orchestrationSummary";
import {
  groupPastWorkersByDay,
  loadPastWorkers,
  type PastOrchestrationWorker,
} from "../model/pastWorkers";
import { OrchestrationWorkers } from "./OrchestrationActions";

/**
 * Every agent a lead has run: the current run, then the agents of runs it
 * has since replaced. The card shows only the current run; this is where the
 * earlier ones stay reachable. Any row opens that agent beside its lead.
 */
export function OrchestrationAgentsPopover({
  anchor,
  leadId,
  summary,
  onDismiss,
}: {
  anchor: RefObject<HTMLElement | null>;
  leadId: string;
  summary: OrchestrationSummary;
  onDismiss: () => void;
}) {
  const workers = useContext(OrchestrationWorkers);
  const [past, setPast] = useState<PastOrchestrationWorker[] | null>(null);
  const [error, setError] = useState<string>();
  const surface = useRef<HTMLDivElement>(null);
  // Card controls stop pointerdown so a press cannot start a drag, which
  // hides it from the popover's own outside check. Capture sees it first, so
  // another card's icon closes this list instead of opening a second one.
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (surface.current?.contains(target) || anchor.current?.contains(target))
      )
        return;
      onDismiss();
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [anchor, onDismiss]);
  useEffect(() => {
    let cancelled = false;
    loadPastWorkers(leadId)
      .then((list) => {
        if (!cancelled) setPast(list);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [leadId]);
  const done = summary.tasks.filter(
    (task) => task.status === "completed",
  ).length;
  const open = (sessionId: string, title: string, harness: HarnessId) => {
    workers.openDetails?.({ sessionId, leadId, title, harness });
    onDismiss();
  };
  const row =
    "flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-content/10 disabled:hover:bg-transparent";
  const heading =
    "px-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-content/40";
  return (
    <Popover
      anchor={anchor}
      side="right"
      align="end"
      width={272}
      maxHeight={420}
      role="dialog"
      aria-label="Agents"
      data-orchestration-agents
      className="overflow-y-auto p-2"
      ref={surface}
      onDismiss={(reason) => {
        if (reason === "escape") onDismiss();
      }}
    >
      <div className="flex items-center justify-between gap-3 px-1">
        <span className="text-[11px] font-semibold text-content/85">
          Agents
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-content/45">
          {done}/{summary.tasks.length} done
        </span>
      </div>
      <p className={heading}>This run</p>
      <div className="flex flex-col gap-px">
        {summary.tasks.map((task) => {
          const label = orchestrationTaskLabel(task, summary);
          return (
            <button
              key={task.sessionId}
              type="button"
              data-orchestration-agent-link={task.sessionId}
              className={row}
              disabled={!workers.openDetails}
              title={`Open ${task.title}`}
              onClick={() => open(task.sessionId, task.title, task.harness)}
            >
              <HarnessIcon
                harness={task.harness}
                className="size-3.5 shrink-0 opacity-75"
              />
              <span className="min-w-0 flex-1 truncate text-[11px] text-content/75">
                {task.title}
              </span>
              <span
                className={`shrink-0 text-[10px] ${orchestrationTaskTone(task, label)}`}
              >
                {label}
              </span>
            </button>
          );
        })}
      </div>
      {error ? (
        <p className="px-1 pt-2 text-[11px] text-red-400">
          Could not load earlier agents: {error}
        </p>
      ) : past === null ? (
        <p className="px-1 pt-2 text-[11px] text-content/40">
          Loading earlier agents…
        </p>
      ) : past.length === 0 ? (
        <p className="px-1 pt-2 text-[11px] text-content/40">
          No earlier agents.
        </p>
      ) : (
        groupPastWorkersByDay(past).map((group) => (
          <div key={group.label}>
            <p className={heading}>Earlier · {group.label}</p>
            <div className="flex flex-col gap-px">
              {group.workers.map((worker) => {
                const title = sessionDisplayTitle(worker.title, worker.harness);
                return (
                  <button
                    key={worker.sessionId}
                    type="button"
                    data-orchestration-agent-link={worker.sessionId}
                    className={row}
                    disabled={!workers.openDetails}
                    title={`Open ${title}`}
                    onClick={() =>
                      open(worker.sessionId, title, worker.harness)
                    }
                  >
                    <HarnessIcon
                      harness={worker.harness}
                      className="size-3.5 shrink-0 opacity-75"
                    />
                    <span className="min-w-0 flex-1 truncate text-[11px] text-content/75">
                      {title}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-content/45">
                      {new Date(worker.updatedAt).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))
      )}
    </Popover>
  );
}
