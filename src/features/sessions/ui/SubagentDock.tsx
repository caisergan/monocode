import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert } from "../../../shared/ui/icons";
import { Popover } from "../../../shared/ui/Popover";
import { ProjectMascot } from "../../projects/ui/ProjectMascot";
import { contextRatio, formatTokens } from "../model/contextUsage";
import { formatLiveElapsed } from "../model/liveAgents";
import type { Block } from "../model/session";
import {
  subagentElapsedMs,
  subagentRunState,
  subagentTokenTotals,
  visibleSubagents,
  type SubagentRunState,
} from "../model/subagentRuns";
import { subagentModelName, subagentName } from "../model/transcriptActivity";

/** Chips that fit beside the totals before the rest fold into "+N". */
const CHIP_LIMIT = 3;
/** How long finished runs stay up once the turn is over. */
const LINGER_MS = 2_000;
/** Matches the card's height transition in index.css. */
const EXIT_MS = 260;
/** Hovering this long over a chip opens its peek. */
const PEEK_DELAY_MS = 280;

/**
 * The delegated runs of the turn, docked on the composer the way the usage
 * limit notice is: a tab of the same shape, so a glance down shows who is
 * still working without scrolling the transcript back to where they started.
 * A click opens a run's sheet.
 */
export function SubagentDock({
  runs,
  live,
  selectedId,
  onOpen,
}: {
  runs: Block[];
  /** The session is still working, so pending runs are running. */
  live: boolean;
  /** The run whose sheet is open. */
  selectedId?: string;
  onOpen: (blockId: string, origin: HTMLElement | null) => void;
}) {
  // An open sheet stands on the card, so the card stays while it is open.
  const shown = useLingeringRuns(runs, live || selectedId != null);
  const cardRef = useRef<HTMLDivElement>(null);
  const now = useSecondClock(shown.runs.some((run) => isRunning(run, live)));
  if (!shown.rendered) return null;

  const { visible, hidden } = visibleSubagents(
    shown.runs,
    live,
    CHIP_LIMIT,
    selectedId,
  );
  const working = shown.runs.filter((run) => isRunning(run, live)).length;
  const totals = subagentTokenTotals(shown.runs);
  const label =
    working > 0
      ? `${working} ${working === 1 ? "agent" : "agents"} working`
      : `${shown.runs.length === 1 ? "Agent" : "Agents"} done`;

  return (
    <div
      className="subagent-dock px-2 text-content/55"
      data-open={shown.open}
      data-attached={selectedId != null && shown.open}
      data-subagent-dock
    >
      <div>
        <section
          ref={cardRef}
          aria-label="Subagents"
          className="@container relative z-0 flex h-8 min-w-0 items-center gap-1 rounded-t-[10px] border border-b-0 border-content/10 bg-content/5 pr-2 pl-2.5 text-[12px]"
        >
          <span className="sr-only" aria-live="polite">
            {label}
          </span>
          <span
            aria-hidden
            className={`size-1.5 shrink-0 rounded-full transition-colors duration-300 ${
              working > 0
                ? "bg-accent shadow-[0_0_8px_var(--color-accent)] motion-safe:animate-pulse"
                : "bg-content/25"
            }`}
          />
          <span
            aria-hidden
            className="mr-1 ml-1 hidden shrink-0 text-content/85 @[52rem]:inline"
          >
            {label}
          </span>
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            {visible.map((run) => (
              <SubagentChip
                key={run.id}
                run={run}
                live={live}
                now={now}
                selected={run.id === selectedId}
                onOpen={() => onOpen(run.id, cardRef.current)}
              />
            ))}
            {hidden.length > 0 ? (
              <button
                type="button"
                title={hidden.map((run) => subagentName(run)).join("\n")}
                aria-label={`${hidden.length} more agents`}
                onClick={() => onOpen(hidden[0].id, cardRef.current)}
                className="subagent-chip flex h-6 shrink-0 items-center rounded-md px-1.5 tabular-nums transition-colors hover:bg-content/10 hover:text-content"
              >
                +{hidden.length}
              </button>
            ) : null}
          </div>
          {totals ? <DockTokens totals={totals} /> : null}
        </section>
      </div>
    </div>
  );
}

function SubagentChip({
  run,
  live,
  now,
  selected,
  onOpen,
}: {
  run: Block;
  live: boolean;
  now: number;
  selected: boolean;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [peek, setPeek] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const name = subagentName(run);
  const state = subagentRunState(run, live);
  const elapsed = subagentElapsedMs(run, now, state === "running");

  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={`${name}, ${subagentStateLabel(state)}. Open its work`}
        aria-pressed={selected}
        onClick={() => {
          setPeek(false);
          onOpen();
        }}
        onMouseEnter={() => {
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setPeek(true), PEEK_DELAY_MS);
        }}
        onMouseLeave={() => {
          window.clearTimeout(timer.current);
          setPeek(false);
        }}
        className={`subagent-chip group flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 transition-colors duration-200 hover:bg-content/10 hover:text-content ${
          selected ? "bg-content/10 text-content" : ""
        }`}
      >
        <SubagentFace name={name} state={state} />
        <span
          className={`min-w-0 max-w-[13rem] truncate transition-colors duration-300 ${
            state === "failed"
              ? "text-red-400"
              : state === "running"
                ? "text-content/80"
                : "text-content/50 group-hover:text-content/80"
          }`}
        >
          {name}
        </span>
        <SubagentRunMark state={state} elapsed={elapsed} />
      </button>
      {peek ? <SubagentPeek anchor={ref} run={run} state={state} /> : null}
    </>
  );
}

/** The run's face: hopping while it works, faded once it has stopped. */
export function SubagentFace({
  name,
  state,
  className = "size-3.5",
}: {
  name: string;
  state: SubagentRunState;
  className?: string;
}) {
  return (
    <ProjectMascot
      project={name}
      active={state === "running"}
      className={`${className} shrink-0 transition-colors duration-300 ${
        state === "failed"
          ? "text-red-400"
          : state === "running"
            ? "text-content/75"
            : "text-content/40"
      }`}
    />
  );
}

/**
 * Time while it runs, a tick once it is done. Swapping the two re-keys the
 * mark so the new one fades in rather than replacing the old in place.
 */
export function SubagentRunMark({
  state,
  elapsed,
}: {
  state: SubagentRunState;
  elapsed?: number;
}) {
  if (state === "running") {
    return elapsed != null ? (
      <span className="shrink-0 text-[11px] tabular-nums text-content/40">
        {formatLiveElapsed(0, elapsed)}
      </span>
    ) : null;
  }
  if (state === "failed") {
    return (
      <CircleAlert
        key="failed"
        aria-hidden
        className="subagent-mark size-3 shrink-0 text-red-400"
        strokeWidth={2}
      />
    );
  }
  if (state === "stopped") {
    return (
      <span
        key="stopped"
        className="subagent-mark shrink-0 text-[11px] text-content/35"
      >
        stopped
      </span>
    );
  }
  return (
    <Check
      key="done"
      aria-hidden
      className="subagent-mark size-3 shrink-0 text-content/40"
      strokeWidth={2}
    />
  );
}

/** A look at the run without opening it: what it is, what it is on, its cost. */
function SubagentPeek({
  anchor,
  run,
  state,
}: {
  anchor: React.RefObject<HTMLButtonElement | null>;
  run: Block;
  state: SubagentRunState;
}) {
  const agentRun = run.agentRun;
  const model = subagentModelName(run);
  const kind = [agentRun?.agentType, model].filter(Boolean).join(" · ");
  const latest = [...(agentRun?.steps ?? [])]
    .reverse()
    .find((step) => step.kind === "tool" && step.text);
  const usage = agentRun?.usage;
  const ratio = usage?.contextUsed
    ? contextRatio({ used: usage.contextUsed, window: usage.contextWindow })
    : null;
  return (
    <Popover
      anchor={anchor}
      side="top"
      align="start"
      className="pointer-events-none w-max max-w-[22rem] px-2.5 py-2"
    >
      <div className="truncate text-[12px] leading-4 text-content">
        {subagentName(run)}
      </div>
      {kind ? (
        <div className="truncate text-[11px] leading-4 text-content/50">
          {kind}
        </div>
      ) : null}
      {state === "running" && latest ? (
        <div className="mt-1.5 truncate text-[11px] leading-4 text-content/70">
          <span className="text-content/40">Now </span>
          {latest.text}
        </div>
      ) : null}
      {usage ? (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] leading-4 tabular-nums text-content/50">
          <span>↑{formatTokens(usage.uncached)}</span>
          <span>↓{formatTokens(usage.output)}</span>
          {usage.contextUsed ? (
            <span>
              {ratio != null
                ? `${Math.round(ratio * 100)}% context`
                : `${formatTokens(usage.contextUsed)} in context`}
            </span>
          ) : null}
        </div>
      ) : null}
    </Popover>
  );
}

/** What the turn's runs have spent between them, beside the chips. */
function DockTokens({
  totals,
}: {
  totals: { uncached: number; cacheRead: number; output: number };
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const detail = [
    `${formatTokens(totals.uncached)} uncached`,
    `${formatTokens(totals.cacheRead)} cached`,
    `${formatTokens(totals.output)} output`,
  ].join(" · ");
  return (
    <span
      ref={ref}
      role="img"
      aria-label={`Subagent tokens: ${detail}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="ml-1 flex shrink-0 items-center gap-1.5 text-[11px] leading-4 tabular-nums text-content/45"
    >
      <span>↑{formatTokens(totals.uncached)}</span>
      <span>↓{formatTokens(totals.output)}</span>
      {hovered ? (
        <Popover
          anchor={ref}
          side="top"
          align="end"
          className="pointer-events-none w-max px-2.5 py-1.5"
        >
          <div className="text-[12px] leading-4 text-content">
            Subagent tokens
          </div>
          <div className="text-[11px] leading-4 text-content/50">{detail}</div>
        </Popover>
      ) : null}
    </span>
  );
}

function isRunning(run: Block, live: boolean): boolean {
  return subagentRunState(run, live) === "running";
}

export function subagentStateLabel(state: SubagentRunState): string {
  return state === "running" ? "working" : state;
}

/**
 * The runs to draw, held a little past the end of the turn so the last tick
 * lands before the card folds away, then kept through the fold itself.
 */
export function useLingeringRuns<T>(runs: readonly T[], live: boolean) {
  const active = runs.length > 0 && live;
  const [held, setHeld] = useState<{ runs: readonly T[]; open: boolean }>({
    runs: active ? runs : [],
    open: active,
  });
  const showing = held.runs.length > 0;
  useEffect(() => {
    if (active) {
      setHeld({ runs, open: true });
      return;
    }
    if (!showing) return;
    // A new turn has begun without runs of its own: fold straight away. A
    // turn that is over shows its runs as they ended for a moment first.
    const linger = live ? 0 : LINGER_MS;
    if (!live) setHeld({ runs, open: true });
    const fold = window.setTimeout(
      () => setHeld((previous) => ({ ...previous, open: false })),
      linger,
    );
    const drop = window.setTimeout(
      () => setHeld({ runs: [], open: false }),
      linger + EXIT_MS,
    );
    return () => {
      window.clearTimeout(fold);
      window.clearTimeout(drop);
    };
  }, [active, live, runs, showing]);
  return {
    runs: held.runs,
    open: held.open,
    rendered: held.runs.length > 0,
  };
}

/** A clock for running elapsed times, stopped while nothing runs. */
export function useSecondClock(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [ticking]);
  return now;
}
