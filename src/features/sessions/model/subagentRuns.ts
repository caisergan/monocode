import {
  isTerminalSession,
  type AgentRunUsage,
  type Block,
  type SessionSurface,
} from "./session";
import {
  isSubagentBlock,
  subagentBrief,
  subagentModelName,
  subagentName,
  toolCallState,
} from "./transcriptActivity";

/** Where a delegated run stands, as the dock and its sheet tell it. */
export type SubagentRunState = "running" | "done" | "failed" | "stopped";

/**
 * One run as the sidebar lists it under its session: who it is and where it
 * stands. Its steps and tokens are left out on purpose, since they change with
 * every stream tick and the sidebar must not redraw for them; the run's sheet
 * reads those from the block itself.
 */
export type SubagentSummary = {
  /** The Agent call's block, which is also how its sheet is opened. */
  id: string;
  name: string;
  /** The whole brief the run was named from, for the row's tooltip. */
  brief: string;
  /** Agent type and model, e.g. "code-reviewer · Sonnet 5.5". */
  kind?: string;
  state: SubagentRunState;
  startedAt?: number;
  endedAt?: number;
  /** Provider-measured run time, once the run has reported it. */
  durationMs?: number;
};

type RunTiming = Pick<SubagentSummary, "startedAt" | "endedAt" | "durationMs">;

/**
 * Every delegated run of the latest turn, in the order they started. Walks
 * back from the end and stops at the message that opened the turn, so a long
 * session costs only its last turn. A message sent into a running turn
 * belongs to that turn and is walked past.
 */
export function latestTurnSubagents(blocks: readonly Block[]): Block[] {
  const runs: Block[] = [];
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block.role === "user" && !block.sentAt && !block.internal) break;
    if (isSubagentBlock(block)) runs.push(block);
  }
  return runs.reverse();
}

/**
 * `live` is whether the session is still working. A run left pending once the
 * session has stopped never reported back, so it reads as stopped.
 */
export function subagentRunState(
  block: Block,
  live: boolean,
): SubagentRunState {
  const state = toolCallState(block);
  if (state === "pending") return live ? "running" : "stopped";
  if (block.agentRun?.stopped) return "stopped";
  return state === "rejected" ? "failed" : "done";
}

/** The latest turn's runs as the sidebar lists them, in the order they started. */
export function latestTurnSubagentSummaries(
  blocks: readonly Block[],
  live: boolean,
): SubagentSummary[] {
  return latestTurnSubagents(blocks).map((block) => {
    const run = block.agentRun;
    const kind = [run?.agentType, subagentModelName(block)]
      .filter(Boolean)
      .join(" · ");
    return {
      id: block.id,
      name: subagentName(block),
      brief: subagentBrief(block),
      ...(kind ? { kind } : {}),
      state: subagentRunState(block, live),
      ...(run?.startedAt != null ? { startedAt: run.startedAt } : {}),
      ...(run?.endedAt != null ? { endedAt: run.endedAt } : {}),
      ...(run?.usage?.durationMs != null
        ? { durationMs: run.usage.durationMs }
        : {}),
    };
  });
}

export function subagentSummariesEqual(
  a: readonly SubagentSummary[],
  b: readonly SubagentSummary[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((run, index) => {
    const other = b[index];
    return (
      run.id === other.id &&
      run.name === other.name &&
      run.brief === other.brief &&
      run.kind === other.kind &&
      run.state === other.state &&
      run.startedAt === other.startedAt &&
      run.endedAt === other.endedAt &&
      run.durationMs === other.durationMs
    );
  });
}

/**
 * Summaries by the blocks they were read from. A session's blocks are replaced
 * whenever they change, so only the sessions that are streaming are read again
 * on each update; the rest cost a lookup.
 */
const summariesRead = new WeakMap<
  readonly Block[],
  { live: boolean; runs: SubagentSummary[] }
>();

/**
 * The sidebar's runs for every session with any in its latest turn, finished
 * ones included so a tree can show how its runs ended before it folds. A
 * session keeps its previous array while nothing the tree shows has changed,
 * and the map itself is kept while no session's has, so a run streaming its
 * steps or tokens leaves the sidebar and its cards alone.
 */
export function subagentSummariesBySession(
  sessions: readonly {
    id: string;
    blocks: readonly Block[];
    busy?: boolean;
    surface?: SessionSurface;
  }[],
  previous: ReadonlyMap<string, readonly SubagentSummary[]>,
): ReadonlyMap<string, readonly SubagentSummary[]> {
  const next = new Map<string, readonly SubagentSummary[]>();
  let changed = false;
  for (const session of sessions) {
    // A session in the agent's own CLI has no pane to open a run's sheet in.
    if (isTerminalSession(session)) continue;
    const live = !!session.busy;
    let read = summariesRead.get(session.blocks);
    if (read?.live !== live) {
      read = { live, runs: latestTurnSubagentSummaries(session.blocks, live) };
      summariesRead.set(session.blocks, read);
    }
    const { runs } = read;
    if (runs.length === 0) continue;
    const kept = previous.get(session.id);
    if (kept && subagentSummariesEqual(kept, runs)) {
      next.set(session.id, kept);
    } else {
      next.set(session.id, runs);
      changed = true;
    }
  }
  return changed || next.size !== previous.size ? next : previous;
}

/** How long the run has worked, or worked for, when the app knows. */
export function subagentElapsedMs(
  block: Block,
  now: number,
  running: boolean,
): number | undefined {
  const run = block.agentRun;
  return elapsedMs(
    {
      startedAt: run?.startedAt,
      endedAt: run?.endedAt,
      durationMs: run?.usage?.durationMs,
    },
    now,
    running,
  );
}

/** The same, for a run the sidebar lists. */
export function subagentSummaryElapsedMs(
  run: SubagentSummary,
  now: number,
): number | undefined {
  return elapsedMs(run, now, run.state === "running");
}

function elapsedMs(
  timing: RunTiming,
  now: number,
  running: boolean,
): number | undefined {
  if (!running && timing.durationMs != null) return timing.durationMs;
  if (timing.startedAt == null) return undefined;
  const end = timing.endedAt ?? (running ? now : undefined);
  if (end == null) return undefined;
  const elapsed = end - timing.startedAt;
  // A run replayed from an import starts and ends in the same instant.
  return elapsed >= 1_000 ? elapsed : undefined;
}

/** Tokens across several runs, for the dock's running total. */
export function subagentTokenTotals(
  blocks: readonly Block[],
): Pick<AgentRunUsage, "uncached" | "cacheRead" | "output"> | undefined {
  let found = false;
  const totals = { uncached: 0, cacheRead: 0, output: 0 };
  for (const block of blocks) {
    const usage = block.agentRun?.usage;
    if (!usage) continue;
    found = true;
    totals.uncached += usage.uncached;
    totals.cacheRead += usage.cacheRead;
    totals.output += usage.output;
  }
  return found ? totals : undefined;
}

/**
 * The runs that get a chip of their own when not all fit. Order never
 * changes under the reader; what gives way first is the oldest finished run,
 * so work still going stays in view.
 */
export function visibleSubagents(
  blocks: readonly Block[],
  live: boolean,
  limit: number,
  /** A run that must keep its chip, e.g. the one whose sheet is open. */
  keep?: string,
): { visible: Block[]; hidden: Block[] } {
  if (blocks.length <= limit) return { visible: [...blocks], hidden: [] };
  const drop = new Set<Block>();
  const excess = blocks.length - limit;
  for (const block of blocks) {
    if (drop.size === excess) break;
    if (block.id === keep) continue;
    if (subagentRunState(block, live) !== "running") drop.add(block);
  }
  for (const block of blocks) {
    if (drop.size === excess) break;
    if (block.id !== keep) drop.add(block);
  }
  return {
    visible: blocks.filter((block) => !drop.has(block)),
    hidden: blocks.filter((block) => drop.has(block)),
  };
}
