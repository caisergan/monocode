import {
  memo,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ChevronDown, ChevronRight } from "../../../shared/ui/icons";
import { Popover } from "../../../shared/ui/Popover";
import { listSubagents } from "../model/subagentListing";
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
 * Lists the session's runs in the sidebar while `listed`, so the composer's
 * dock stands aside for it. Held by the card's row rather than by the tree,
 * so the dock is already away when the first run starts.
 */
export function useSubagentListing(sessionId: string, listed: boolean) {
  useEffect(
    () => (listed ? listSubagents(sessionId) : undefined),
    [sessionId, listed],
  );
}

/**
 * A session's delegated runs, hanging off its card in the sidebar the way
 * files hang off a folder. It shows while the session works and a moment
 * after, as the dock did, and stays while one of its runs is open in front.
 * A row opens that run's sheet, bringing its session forward when it is not.
 */
export const SubagentTree = memo(function SubagentTree({
  sessionId,
  sessionTitle,
  runs,
  live,
  active,
  expanded,
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
  onOpenSession: (sessionId: string) => void;
}) {
  const openId = useSyncExternalStore(
    subscribeSubagentSheets,
    () => shownSubagentSheet(sessionId),
    () => null,
  );
  const selectedId =
    active && runs.some((run) => run.id === openId) ? openId : null;
  const shown = useLingeringRuns(runs, live || selectedId != null);
  const now = useSecondClock(
    shown.runs.some((run) => run.state === "running"),
  );
  if (!shown.rendered) return null;
  const open = shown.open && expanded;

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
 * How many of the session's runs are working, on its card, and the switch
 * that folds the tree beneath it. The face gives way to a chevron under the
 * pointer, and while the tree is folded, hovering names who is working.
 */
export function SubagentTreeToggle({
  sessionId,
  names,
  expanded,
  onToggle,
}: {
  sessionId: string;
  /** Names of the runs still working. */
  names: readonly string[];
  expanded: boolean;
  onToggle: (sessionId: string) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const count = names.length;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <button
      ref={ref}
      type="button"
      data-no-drag
      data-tauri-drag-region="false"
      data-subagent-count
      aria-label={`${count} ${count === 1 ? "subagent" : "subagents"} running`}
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
      className="group/subagents subagent-chip flex h-5 shrink-0 items-center gap-1 rounded-md px-1 text-[11px] tabular-nums text-content/60 outline-none hover:bg-content/10 hover:text-content focus-visible:ring-1 focus-visible:ring-accent/50"
    >
      <span className="grid size-3 shrink-0 place-items-center">
        <SubagentFace
          name={names[0]}
          state="running"
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
              {count} running
            </span>
          </div>
          <div className="mt-1.5 flex flex-col gap-0.5">
            {names.map((name, index) => (
              <div
                key={`${index}:${name}`}
                className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-1"
              >
                <SubagentFace name={name} state="running" />
                <span className="min-w-0 flex-1 truncate text-[11px] text-content/75">
                  {name}
                </span>
              </div>
            ))}
          </div>
        </Popover>
      ) : null}
    </button>
  );
}
