import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { GlassBackdrop } from "../../../app/shell/GlassBackdrop";
import { subagentConversation } from "../../../integrations/harness";
import { Square, X } from "../../../shared/ui/icons";
import { contextRatio, formatTokens } from "../model/contextUsage";
import { formatLiveElapsed } from "../model/liveAgents";
import { allModels } from "../model/models";
import type { Block } from "../model/session";
import {
  subagentElapsedMs,
  subagentRunState,
  type SubagentRunState,
} from "../model/subagentRuns";
import { subagentModelName, subagentName } from "../model/transcriptActivity";
import { AgentMarkdown } from "./AgentMarkdown";
import { AgentTranscript, SubagentTrail } from "./AgentTranscript";
import { MeterRing } from "./ContextMeter";
import { SubagentFace, useSecondClock } from "./SubagentDock";

type View = "activity" | "context";

const OPEN_MOTION = {
  duration: 320,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
};
const CLOSE_MOTION = {
  duration: 200,
  easing: "cubic-bezier(0.4, 0, 0.2, 1)",
  fill: "forwards" as const,
};
/** The sheet rises out of the subagent card below it and sinks back in. */
const FOLDED = "inset(100% 0px 0px 0px round 10px 10px 0px 0px)";
const UNFOLDED = "inset(0px 0px 0px 0px round 10px 10px 0px 0px)";
/** How long "Stopping…" waits for the run to end before allowing a retry. */
const STOP_RETRY_MS = 8_000;
/** How often an open running run's own conversation is read again. */
const CONVERSATION_POLL_MS = 1_500;

function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * One delegated run, opened from its chip: who it is, what it costs, how full
 * its window is, and either the trail of what it did or the conversation it
 * is having. It stands on the subagent card, whose chips switch between runs,
 * so the composer stays where it was and the turn can be steered meanwhile.
 */
export function SubagentSheet({
  run,
  live,
  cwd,
  visible = true,
  conversationAvailable,
  canStop,
  onClose,
  onStop,
  onOpenFile,
  onOpenDiff,
}: {
  /** The open run; null closes the sheet. */
  run: Block | null;
  live: boolean;
  cwd?: string;
  visible?: boolean;
  /** The run's transcript is on this machine and can be read. */
  conversationAvailable: boolean;
  canStop: boolean;
  onClose: () => void;
  onStop: (callId: string) => void;
  onOpenFile?: (path: string) => void;
  onOpenDiff?: (path: string) => void;
}) {
  const open = run != null;
  const [shown, setShown] = useState<Block | null>(run);
  const [view, setView] = useState<View>("activity");
  const overlayRef = useRef<HTMLDivElement>(null);
  const glassRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const motionRef = useRef<Animation[] | null>(null);
  if (run && run !== shown) setShown(run);

  // Unfold on open, fold back on close, reversing mid-flight from wherever the
  // sheet is. Glass and content run the same motion side by side, since glass
  // must never sit inside an animating ancestor.
  useLayoutEffect(() => {
    const layers = [glassRef.current, contentRef.current].filter(
      (layer): layer is HTMLDivElement => layer != null,
    );
    if (!shown || layers.length === 0) return;
    const running = motionRef.current;
    if (reducedMotion() || typeof layers[0].animate !== "function") {
      running?.forEach((motion) => motion.cancel());
      motionRef.current = null;
      if (!open) setShown(null);
      return;
    }
    const style = running ? getComputedStyle(layers[0]) : null;
    const from =
      style?.clipPath && style.clipPath !== "none"
        ? style.clipPath
        : open
          ? FOLDED
          : UNFOLDED;
    running?.forEach((motion) => motion.cancel());
    const motions = layers.map((layer) =>
      layer.animate(
        open
          ? [
              { clipPath: from, opacity: running ? 1 : 0.4 },
              { clipPath: UNFOLDED, opacity: 1 },
            ]
          : [
              { clipPath: from, opacity: 1 },
              { clipPath: FOLDED, opacity: 0.4 },
            ],
        open ? OPEN_MOTION : CLOSE_MOTION,
      ),
    );
    motionRef.current = motions;
    motions[0].onfinish = () => {
      if (motionRef.current !== motions) return;
      motionRef.current = null;
      if (!open) setShown(null);
    };
    // Only opening and closing move the sheet; switching runs does not.
  }, [open, shown == null]);

  // Esc folds the sheet from anywhere in this pane.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!open || !visible || !overlay) return;
    const pane =
      overlay.closest("[data-session-drop]") ?? overlay.parentElement;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.isComposing) return;
      const target = event.target instanceof Node ? event.target : null;
      if (target !== document.body && !(target && pane?.contains(target))) {
        return;
      }
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, visible, onClose]);

  if (!shown) return null;
  const current = run ?? shown;
  const state = subagentRunState(current, live);

  return (
    <div
      ref={overlayRef}
      data-subagent-sheet
      data-state={open ? "open" : "closed"}
      inert={!open}
      className="absolute inset-0 z-30"
    >
      <div aria-hidden className="absolute inset-0" onMouseDown={onClose} />
      <div className="subagent-sheet absolute inset-x-0 bottom-0 mx-auto w-full max-w-4xl px-3.5">
        <section
          role="dialog"
          aria-label={`Subagent: ${subagentName(current)}`}
          className="relative isolate h-full"
        >
          <GlassBackdrop
            ref={glassRef}
            className="subagent-sheet-glass popover-backdrop"
          />
          <div
            ref={contentRef}
            className="relative z-[1] flex h-full min-h-0 flex-col font-sans text-sm text-content"
          >
            <RunHeader
              run={current}
              state={state}
              // Stopping goes by the run's task. A run without one of its own,
              // like an agent a workflow started, can't be stopped by itself.
              canStop={
                canStop && state === "running" && !!current.agentRun?.taskId
              }
              onStop={() => {
                const callId = current.tool?.callId;
                if (callId) onStop(callId);
              }}
              onClose={onClose}
            />
            <RunStats run={current} />
            <div
              role="tablist"
              aria-label="Subagent views"
              className="flex shrink-0 items-center gap-1 px-4 pt-2.5 pb-1"
            >
              <ViewTab
                selected={view === "activity"}
                onClick={() => setView("activity")}
              >
                Activity
              </ViewTab>
              <ViewTab
                selected={view === "context"}
                onClick={() => setView("context")}
              >
                Context
              </ViewTab>
            </div>
            <div
              key={`${current.id}:${view}`}
              className="subagent-sheet-body flex min-h-0 flex-1 flex-col"
            >
              {view === "activity" ? (
                <ActivityView
                  run={current}
                  live={live}
                  cwd={cwd}
                  onOpenFile={onOpenFile}
                  onOpenDiff={onOpenDiff}
                />
              ) : (
                <ContextView
                  run={current}
                  running={state === "running"}
                  available={conversationAvailable}
                  visible={visible && open}
                  cwd={cwd}
                  onOpenFile={onOpenFile}
                  onOpenDiff={onOpenDiff}
                />
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function RunHeader({
  run,
  state,
  canStop,
  onStop,
  onClose,
}: {
  run: Block;
  state: SubagentRunState;
  canStop: boolean;
  onStop: () => void;
  onClose: () => void;
}) {
  const name = subagentName(run);
  const [stopping, setStopping] = useState(false);
  // A stop the provider never acts on gives the button back after a while.
  useEffect(() => {
    if (!stopping) return;
    const timer = window.setTimeout(() => setStopping(false), STOP_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [stopping]);
  useEffect(() => setStopping(false), [run.id]);
  const now = useSecondClock(state === "running");
  const elapsed = subagentElapsedMs(run, now, state === "running");
  const tools =
    run.agentRun?.usage?.toolUses ??
    run.agentRun?.steps.filter((step) => step.kind === "tool").length;
  const meta = [
    run.agentRun?.agentType,
    subagentModelName(run),
    statusPhrase(state, elapsed),
    tools ? `${tools} ${tools === 1 ? "tool call" : "tool calls"}` : undefined,
  ].filter(Boolean);

  return (
    <header className="flex shrink-0 items-start gap-2.5 border-b border-content/8 px-4 pt-3.5 pb-3">
      <SubagentFace name={name} state={state} className="mt-0.5 size-4" />
      <div className="min-w-0 flex-1">
        <h2
          className={`truncate text-[14px] leading-5 ${
            state === "failed" ? "text-red-400" : "text-content"
          }`}
          title={name}
        >
          {name}
        </h2>
        <p className="truncate text-[12px] leading-4 text-content/45 tabular-nums">
          {meta.join(" · ")}
        </p>
      </div>
      {canStop ? (
        <button
          type="button"
          disabled={stopping}
          title="Stop this agent; the rest of the turn keeps going"
          onClick={() => {
            setStopping(true);
            onStop();
          }}
          className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-content/60 transition-colors hover:bg-content/10 hover:text-content disabled:pointer-events-none disabled:opacity-50"
        >
          <Square className="size-2.5 fill-current" strokeWidth={0} />
          {stopping ? "Stopping…" : "Stop"}
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Close"
        title="Close (Esc)"
        onClick={onClose}
        className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 transition-colors hover:bg-content/10 hover:text-content"
      >
        <X className="size-3.5" strokeWidth={1.75} />
      </button>
    </header>
  );
}

/** Tokens in, tokens out, what the cache served, and how full the window is. */
function RunStats({ run }: { run: Block }) {
  const usage = run.agentRun?.usage;
  if (!usage) {
    return (
      <p className="shrink-0 border-b border-content/8 px-4 py-2.5 text-[12px] text-content/40">
        No token counts from this agent yet.
      </p>
    );
  }
  const window = usage.contextWindow ?? modelWindow(run.agentRun?.model);
  const ratio =
    usage.contextUsed != null
      ? contextRatio({ used: usage.contextUsed, window })
      : null;
  return (
    <dl className="grid shrink-0 grid-cols-4 gap-3 border-b border-content/8 px-4 py-2.5">
      <Stat label="Input" title="Prompt tokens not read from the cache">
        ↑ {formatTokens(usage.uncached)}
      </Stat>
      <Stat label="Output">↓ {formatTokens(usage.output)}</Stat>
      <Stat label="Cached" title="Prompt tokens served from the cache">
        {formatTokens(usage.cacheRead)}
      </Stat>
      <Stat label="Context" title="Tokens in the agent's window now">
        {usage.contextUsed != null ? (
          <span className="flex items-center gap-1.5">
            {ratio != null ? <MeterRing ratio={ratio} /> : null}
            <span>
              {formatTokens(usage.contextUsed)}
              {window ? (
                <span className="text-content/40">
                  {" "}
                  / {formatTokens(window)}
                </span>
              ) : null}
            </span>
          </span>
        ) : (
          <span className="text-content/40">–</span>
        )}
      </Stat>
    </dl>
  );
}

function Stat({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-[11px] leading-4 text-content/40">{label}</dt>
      <dd className="truncate text-[13px] leading-5 tabular-nums text-content/85">
        {children}
      </dd>
    </div>
  );
}

function ViewTab({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={`h-7 rounded-md px-2.5 text-xs transition-colors ${
        selected
          ? "bg-content/10 text-content"
          : "text-content/50 hover:bg-content/5 hover:text-content/80"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The run's trail, kept at its newest step while it works unless the reader
 * has scrolled back to look at something earlier.
 */
function ActivityView({
  run,
  live,
  cwd,
  onOpenFile,
  onOpenDiff,
}: {
  run: Block;
  live: boolean;
  cwd?: string;
  onOpenFile?: (path: string) => void;
  onOpenDiff?: (path: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const steps = run.agentRun?.steps;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [steps, run.tool?.detail]);
  const empty =
    !steps?.length && !run.tool?.detail && !run.tool?.detailOmitted;
  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-1 pb-4"
    >
      {empty ? (
        <p className="py-2 text-[12px] text-content/40">
          Waiting for the agent's first step…
        </p>
      ) : (
        <SubagentTrail
          block={run}
          cwd={cwd}
          live={live}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
        />
      )}
    </div>
  );
}

/**
 * Everything in the run's window: the brief its parent wrote, then its own
 * conversation — thinking, calls and their output — read from the provider's
 * transcript. Without a readable transcript the brief is what there is.
 */
function ContextView({
  run,
  running,
  available,
  visible,
  cwd,
  onOpenFile,
  onOpenDiff,
}: {
  run: Block;
  running: boolean;
  available: boolean;
  visible: boolean;
  cwd?: string;
  onOpenFile?: (path: string) => void;
  onOpenDiff?: (path: string) => void;
}) {
  const path = available ? run.agentRun?.transcriptPath : undefined;
  const conversation = useConversation(path, running);
  const timed = useMemo(
    () => conversation && timeBrief(conversation, run, running),
    [conversation, run, running],
  );
  if (timed && timed.length > 0) {
    return (
      <div className="relative min-h-0 flex-1">
        <AgentTranscript
          blocks={timed}
          busy={running}
          visible={visible}
          cwd={cwd}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
        />
      </div>
    );
  }
  const prompt = run.agentRun?.prompt;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-1 pb-4">
      {prompt ? (
        <>
          <h3 className="pb-1 text-[11px] text-content/40">Brief</h3>
          <div className="rounded-lg border border-content/8 bg-content/3 px-3 py-2">
            <AgentMarkdown text={prompt} cwd={cwd} onOpenFile={onOpenFile} />
          </div>
        </>
      ) : null}
      <p className="pt-3 text-[12px] text-content/40">
        {path && conversation == null
          ? "Reading the agent's conversation…"
          : run.agentRun?.transcriptPath && !available
            ? "The agent's full conversation stays on the machine it ran on."
            : "This agent's provider doesn't share its full conversation."}
      </p>
    </div>
  );
}

/**
 * The run's conversation, read again while it is still going. Undefined until
 * the first read lands; null when there is nothing to read.
 */
function useConversation(
  path: string | undefined,
  running: boolean,
): Block[] | null | undefined {
  const [blocks, setBlocks] = useState<Block[] | null | undefined>(
    path ? undefined : null,
  );
  useEffect(() => {
    const reader = subagentConversation(path);
    if (!reader) {
      setBlocks(null);
      return;
    }
    setBlocks(undefined);
    let cancelled = false;
    let loaded = false;
    const pull = () =>
      reader
        .read()
        .then((changed) => {
          if (cancelled || (!changed && loaded)) return;
          loaded = true;
          setBlocks([...reader.blocks()]);
        })
        .catch(() => {
          if (!cancelled && !loaded) setBlocks(null);
        });
    void pull();
    const timer = running
      ? window.setInterval(pull, CONVERSATION_POLL_MS)
      : undefined;
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [path, running]);
  return blocks;
}

/**
 * The brief opens the run's one turn, so it carries the run's own start and,
 * once it is over, how long it took; otherwise the transcript would time the
 * turn from the moment the sheet was opened.
 */
function timeBrief(blocks: Block[], run: Block, running: boolean): Block[] {
  const brief = blocks[0];
  const startedAt = run.agentRun?.startedAt;
  if (brief?.role !== "user" || startedAt == null) return blocks;
  const elapsed = running ? undefined : subagentElapsedMs(run, 0, false);
  return [
    {
      ...brief,
      startedAt,
      ...(elapsed != null ? { durationMs: elapsed } : {}),
    },
    ...blocks.slice(1),
  ];
}

function statusPhrase(
  state: SubagentRunState,
  elapsed: number | undefined,
): string {
  const time = elapsed != null ? formatLiveElapsed(0, elapsed) : undefined;
  if (state === "running") return time ? `Working ${time}` : "Working";
  if (state === "failed") return time ? `Failed after ${time}` : "Failed";
  if (state === "stopped") return time ? `Stopped after ${time}` : "Stopped";
  return time ? `Finished in ${time}` : "Finished";
}

function modelWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  return allModels().find(
    (entry) => entry.id === model || entry.nativeId === model,
  )?.contextWindow;
}
