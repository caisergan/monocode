import {
  memo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ChevronDown, ChevronRight } from "../../../shared/ui/icons";
import { Popover } from "../../../shared/ui/Popover";
import {
  subagentSummaryElapsedMs,
  type SubagentSummary,
} from "../model/subagentRuns";
import {
  closeSubagentSheet,
  openSubagentSheet,
  shownSubagentSheet,
  subscribeSubagentSheets,
} from "../model/subagentSheets";
import {
  SubagentFace,
  SubagentRunMark,
  subagentStateLabel,
  useLingeringRuns,
  useSecondClock,
} from "./SubagentDock";

/** The tree's element id, so the card's toggle can name what it controls. */
export function subagentTreeId(sessionId: string): string {
  return `subagent-tree-${sessionId}`;
}

/**
 * A session's delegated runs, hanging off its card in the sidebar the way
 * files hang off a folder. Only the session in front unfolds it: it shows
 * while the session works and a moment after, as the dock does, and stays
 * while one of its runs is open or the user opened it from the card's count.
 * A row opens that run's sheet.
 */
export const SubagentTree = memo(function SubagentTree({
  sessionId,
  sessionTitle,
  runs,
  live,
  active,
  expanded,
  pinned = false,
  onOpenSession,
}: {
  sessionId: string;
  sessionTitle: string;
  runs: readonly SubagentSummary[];
  /** The session is still working, so its runs may be too. */
  live: boolean;
  /** The session is the one in front, whose open run is the one on screen. */
  active: boolean;
  /** Not folded away with the card's toggle. */
  expanded: boolean;
  /** Opened from the card's count, so it stays after the turn is over. */
  pinned?: boolean;
  onOpenSession: (sessionId: string) => void;
}) {
  const openId = useSyncExternalStore(
    subscribeSubagentSheets,
    () => shownSubagentSheet(sessionId),
    () => null,
  );
  const selectedId =
    active && runs.some((run) => run.id === openId) ? openId : null;
  const shown = useLingeringRuns(runs, live || pinned || selectedId != null);
  const now = useSecondClock(
    shown.runs.some((run) => run.state === "running"),
  );
  if (!shown.rendered) return null;
  const open = shown.open && expanded && active;

  return (
    <div
      className="subagent-tree"
      data-open={open}
      data-subagent-tree={sessionId}
      inert={!open || undefined}
    >
      <div>
        {/* The guide runs down from under the card's harness icon. */}
        <ul
          id={subagentTreeId(sessionId)}
          aria-label={`Subagents of ${sessionTitle}`}
          className="mr-[5px] ml-[17px] flex flex-col pb-1"
        >
          {shown.runs.map((run) => (
            <SubagentTreeRow
              key={run.id}
              sessionId={sessionId}
              run={run}
              now={now}
              selected={run.id === selectedId}
              onOpenSession={onOpenSession}
            />
          ))}
        </ul>
      </div>
    </div>
  );
});

function SubagentTreeRow({
  sessionId,
  run,
  now,
  selected,
  onOpenSession,
}: {
  sessionId: string;
  run: SubagentSummary;
  now: number;
  selected: boolean;
  onOpenSession: (sessionId: string) => void;
}) {
  const elapsed = subagentSummaryElapsedMs(run, now);
  return (
    // The guide and elbow stand still; only the row settles in.
    <li className="subagent-tree-item">
      <button
        type="button"
        data-subagent-run={run.id}
        aria-label={`${run.name}, ${subagentStateLabel(run.state)}. Open its work`}
        aria-pressed={selected}
        title={[run.brief, run.kind].filter(Boolean).join("\n")}
        onClick={() => {
          if (selected) {
            closeSubagentSheet(sessionId);
            return;
          }
          // The pane reads this as it mounts, so it goes first.
          openSubagentSheet(sessionId, run.id);
          onOpenSession(sessionId);
        }}
        onKeyDown={(event) => {
          // Focus stays here after a click; Esc should still fold the sheet.
          if (event.key !== "Escape" || !selected) return;
          event.preventDefault();
          closeSubagentSheet(sessionId);
        }}
        // An inset ring: the tree clips anything drawn past its rows.
        className={`subagent-chip group/run flex h-6 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-[12px] outline-none transition-colors duration-200 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/50 ${
          selected ? "bg-content/10" : "hover:bg-content/5"
        }`}
      >
        <SubagentFace name={run.name} state={run.state} />
        <span
          className={`min-w-0 flex-1 truncate transition-colors duration-300 ${
            run.state === "failed"
              ? "text-red-400"
              : selected
                ? "text-content"
                : run.state === "running"
                  ? "text-content/80 group-hover/run:text-content"
                  : "text-content/50 group-hover/run:text-content/80"
          }`}
        >
          {run.name}
        </span>
        <SubagentRunMark state={run.state} elapsed={elapsed} />
      </button>
    </li>
  );
}

/**
 * How many runs the session's latest turn delegated, on its card, and the
 * switch that unfolds the tree beneath it. The face hops while any of them
 * works and gives way to a chevron under the pointer; while the tree is
 * folded or the session is in the back, hovering lists the runs.
 */
export function SubagentTreeToggle({
  sessionId,
  runs,
  expanded,
  onToggle,
}: {
  sessionId: string;
  runs: readonly SubagentSummary[];
  expanded: boolean;
  onToggle: (sessionId: string) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const count = runs.length;
  const working = runs.filter((run) => run.state === "running").length;
  const face = runs.find((run) => run.state === "running") ?? runs[0];
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <button
      ref={ref}
      type="button"
      data-no-drag
      data-tauri-drag-region="false"
      data-subagent-count
      aria-label={`${count} ${count === 1 ? "subagent" : "subagents"}${
        working > 0 ? `, ${working} running` : ""
      }`}
      aria-expanded={expanded}
      aria-controls={subagentTreeId(sessionId)}
      // The card takes the pointer on press for dragging; keep it off this.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        setHovered(false);
        onToggle(sessionId);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`group/subagents subagent-chip flex h-5 shrink-0 items-center gap-1 rounded-md px-1 text-[11px] tabular-nums outline-none hover:bg-content/10 hover:text-content focus-visible:ring-1 focus-visible:ring-accent/50 ${
        working > 0 ? "text-content/60" : "text-content/40"
      }`}
    >
      <span className="grid size-3 shrink-0 place-items-center">
        <SubagentFace
          name={face.name}
          state={working > 0 ? "running" : "done"}
          className="size-3 group-hover/subagents:hidden group-focus-visible/subagents:hidden"
        />
        <Chevron
          aria-hidden
          className="hidden size-3 group-hover/subagents:block group-focus-visible/subagents:block"
          strokeWidth={1.75}
        />
      </span>
      <span key={count} className="subagent-mark">
        {count}
      </span>
      {hovered && !expanded ? (
        <Popover
          anchor={ref}
          side="right"
          align="end"
          width={248}
          maxHeight={320}
          role="tooltip"
          className="pointer-events-none overflow-y-auto p-2.5"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] font-semibold text-content/85">
              Subagents
            </span>
            <span className="shrink-0 text-[10px] tabular-nums text-content/45">
              {working > 0 ? `${working} running` : `${count} finished`}
            </span>
          </div>
          <div className="mt-1.5 flex flex-col gap-0.5">
            {runs.map((run) => (
              <div
                key={run.id}
                className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-1"
              >
                <SubagentFace name={run.name} state={run.state} />
                <span
                  className={`min-w-0 flex-1 truncate text-[11px] ${
                    run.state === "failed"
                      ? "text-red-400"
                      : run.state === "running"
                        ? "text-content/75"
                        : "text-content/50"
                  }`}
                >
                  {run.name}
                </span>
                {run.state === "running" ? null : (
                  <SubagentRunMark state={run.state} />
                )}
              </div>
            ))}
          </div>
        </Popover>
      ) : null}
    </button>
  );
}
