// Session blocks to transcript rows, with the desktop's grouping (turns,
// activity trails, the work fold) from @monocode/core. Rows of unchanged
// blocks are reused by identity, so a streamed delta rebuilds only its turn.

import type { Block } from "@monocode/core/session";
import {
  foldableWork,
  foldedBlocks,
  groupTurnItems,
  groupTurns,
  isNoticeBlock,
  needsApproval,
  proseSummary,
  resolveToolCallDisplay,
  toolCallLabel,
  toolCallState,
  workSummaryLine,
  type TurnItem,
} from "@monocode/core/transcript";
import type { RowSpec, TextRun } from "@transcript";
import { hash, markdownRows } from "./markdown";
import type { PendingMark } from "./optimistic";

export type RowOptions = {
  /** The session is running: its last turn is live. */
  live: boolean;
  cwd?: string;
  /** Fold rows the person opened. */
  open: ReadonlySet<string>;
  /** Approvals being sent: their buttons read "Sending…". */
  sending?: ReadonlySet<number>;
  /** Show the "Load earlier messages" row. */
  hasOlder?: boolean;
  /** An older page is on its way. */
  loadingOlder?: boolean;
  /** Outbox state under user bubbles, by block id (11 §11.16). */
  pending?: ReadonlyMap<string, PendingMark>;
  /** Settled plans offer Build (the host has `sessions.plan`, the session is idle). */
  canBuild?: boolean;
};

/** Row actions that open sheets above the transcript. */
export const TOOL_ACTION = "tool";
export const ATTACHMENT_ACTION = "attachment:";
/** A failed outbox entry's row: Retry or Discard. */
export const OUTBOX_ACTION = "outbox:";
/** Build a reviewed plan. */
export const BUILD_ACTION = "build:";
/** A saved draft: Send or Remove. */
export const DRAFT_ACTION = "draft:";

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function clock(at: number): string {
  const date = new Date(at);
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours % 12 || 12}:${minutes} ${hours < 12 ? "AM" : "PM"}`;
}

const blockCache = new WeakMap<Block, { key: string; rows: RowSpec[] }>();

function memo(block: Block, key: string, build: () => RowSpec[]): RowSpec[] {
  const cached = blockCache.get(block);
  if (cached && cached.key === key) return cached.rows;
  const rows = build();
  blockCache.set(block, { key, rows });
  return rows;
}

function userRows(block: Block, mark?: PendingMark): RowSpec[] {
  return memo(block, `user|${mark?.label ?? ""}|${mark?.failed?.text ?? ""}`, () => {
    const images = block.attachments?.filter((attachment) => attachment.kind === "image") ?? [];
    const files = (block.attachments?.length ?? 0) - images.length;
    const attachments = files ? `${files} attachment${files > 1 ? "s" : ""}\n` : "";
    return [
      {
        id: block.id,
        v: hash(block.text + attachments + (mark?.label ?? ""), block.draft ? 1 : 0),
        k: "userBubble",
        runs: [{ t: attachments + block.text, s: "user" }],
        ...(mark ? { sub: [{ t: mark.label, s: mark.failed ? "trailFailed" : "meta" }] satisfies TextRun[] } : {}),
        status: block.draft ? "draft" : undefined,
        gap: 20,
        a11y: `You said: ${block.text}${mark ? `. ${mark.label}` : ""}`,
      },
      // The bubble has no buttons; a failed send gets a row that offers
      // Retry and Discard.
      ...(mark?.failed
        ? [
            {
              id: `${block.id}:outbox`,
              v: hash(mark.failed.text),
              k: "thinkingRow",
              runs: [
                { t: `${mark.failed.text} `, s: "trailFailed" },
                { t: "Retry · Discard", s: "trailTarget", chip: 1 },
              ],
              actions: [{ id: `${OUTBOX_ACTION}${mark.failed.commandId}`, label: "", variant: "secondary" }],
              gap: 0,
              a11y: `${mark.failed.text} Retry or discard`,
            } satisfies RowSpec,
          ]
        : []),
      // The host's draft (11 §11.16): its footer's Send and Remove.
      ...(block.draft && !mark
        ? [
            {
              id: `${block.id}:draft`,
              v: 1,
              k: "thinkingRow",
              runs: [
                { t: "Draft ", s: "trailVerb" },
                { t: "Send · Remove", s: "trailTarget", chip: 1 },
              ],
              actions: [{ id: `${DRAFT_ACTION}${block.id}`, label: "", variant: "secondary" }],
              gap: 0,
              a11y: "Draft. Send or remove",
            } satisfies RowSpec,
          ]
        : []),
      // Images open in a sheet (attachments.read); the native view has no
      // image rows yet.
      ...images.map(
        (image, index): RowSpec => ({
          id: `${block.id}:image:${image.id}`,
          v: hash(image.name, index),
          k: "thinkingRow",
          runs: [
            { t: "Image ", s: "trailVerb" },
            { t: image.name, s: "trailTarget", chip: 2 },
          ],
          actions: [{ id: `${ATTACHMENT_ACTION}${image.id}`, label: "", variant: "secondary" }],
          gap: index ? 0 : 4,
          a11y: `Image attachment ${image.name}`,
        }),
      ),
    ];
  });
}

function trailRow(block: Block, cwd: string | undefined, last: boolean): RowSpec {
  if (block.role === "reasoning") {
    const summary = proseSummary(block.text) || "Thinking";
    return {
      id: block.id,
      v: hash(summary, block.streaming ? 1 : 0),
      k: "thinkingRow",
      runs: [{ t: summary, s: "reasoning" }],
      anim: { pulse: !!block.streaming },
      actions: [{ id: TOOL_ACTION, label: "", variant: "secondary" }],
      gap: 0,
    };
  }
  if (block.role === "system") {
    return { id: block.id, v: hash(block.text, 3), k: "trailRow", last, runs: [{ t: block.text, s: "trailVerb" }] } as RowSpec;
  }
  const label = toolCallLabel(block, cwd);
  const state = toolCallState(block);
  const display = resolveToolCallDisplay(label, block.tool?.preview, cwd);
  const failed = state === "rejected";
  const runs: TextRun[] = display.action && display.target
    ? [
        { t: `${display.action} `, s: failed ? "trailFailed" : "trailVerb" },
        { t: display.isFile ? display.fileName : display.target, s: "trailTarget", chip: display.isFile ? 2 : 1 },
      ]
    : [{ t: label, s: failed ? "trailFailed" : "trailTarget" }];
  return {
    id: block.id,
    v: hash(JSON.stringify(runs), (failed ? 1 : 0) + (last ? 2 : 0)),
    k: "trailRow",
    runs,
    last,
    status: state,
    actions: [{ id: TOOL_ACTION, label: "", variant: "secondary" }],
    a11y: label,
  };
}

function approvalRow(block: Block, cwd: string | undefined, sending: boolean): RowSpec {
  const requestId = block.approval!.requestId;
  const preview = block.tool?.preview;
  const lines: TextRun[][] = (preview?.lines?.slice(0, 6) ?? []).map((line) => [
    { t: `${line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "} ${line.text}`, s: "code" },
  ]);
  if (!lines.length && preview?.output) lines.push(...preview.output.split("\n").slice(-6).map((text) => [{ t: text, s: "code" as const }]));
  if (!lines.length && block.tool?.detail) lines.push(...block.tool.detail.split("\n").slice(0, 6).map((text) => [{ t: text, s: "code" as const }]));
  const title = toolCallLabel(block, cwd);
  return {
    id: `${block.id}:approval`,
    v: hash(title + JSON.stringify(lines), sending ? 1 : 0),
    k: "approvalControls",
    runs: [{ t: title, s: "approvalTitle" }],
    lines,
    gap: 8,
    actions: sending
      ? [{ id: `noop:${requestId}`, label: "Sending…", variant: "secondary" }]
      : [
          { id: `deny:${requestId}`, label: "Deny", variant: "secondary" },
          { id: `allow:${requestId}`, label: "Allow", variant: "primary" },
        ],
    a11y: `Approval needed: ${title}`,
  };
}

function itemRows(item: TurnItem, options: RowOptions): RowSpec[] {
  if (item.type === "block") {
    const block = item.block;
    const buildable = !block.streaming && !!block.text.trim() && block.plan?.status !== "building" && block.plan?.status !== "built";
    if (block.role === "plan" && options.canBuild && buildable)
      return [
        ...memo(block, `md:${block.text.length}`, () => markdownRows(block.text, block.id)),
        {
          id: `${block.id}:build`,
          v: 1,
          k: "thinkingRow",
          runs: [
            { t: "Build ", s: "trailVerb" },
            { t: "this plan", s: "trailTarget", chip: 1 },
          ],
          actions: [{ id: `${BUILD_ACTION}${block.id}`, label: "", variant: "primary" }],
          gap: 6,
          a11y: "Build this plan",
        },
      ];
    if (block.role === "assistant" || block.role === "plan" || block.role === "tasks")
      return memo(block, `md:${block.text.length}`, () => markdownRows(block.text, block.id));
    if (block.role === "system" && isNoticeBlock(block))
      return [{ id: block.id, v: hash(block.text, 9), k: "notice", status: block.notice === "interrupt" ? "interrupt" : "error", runs: [{ t: block.text, s: "notice" }], gap: 8 }];
    if (block.role === "reasoning") return [trailRow(block, options.cwd, true)];
    return memo(block, "plain", () => markdownRows(block.text || block.role, block.id, "meta"));
  }
  const rows: RowSpec[] = [];
  item.blocks.forEach((block, index) => {
    rows.push(trailRow(block, options.cwd, index === item.blocks.length - 1));
    if (needsApproval(block)) rows.push(approvalRow(block, options.cwd, !!options.sending?.has(block.approval!.requestId)));
  });
  if (rows.length) rows[0] = { ...rows[0], gap: (rows[0].gap ?? 0) + 6 };
  return rows;
}

function turnRows(turn: Block[], live: boolean, options: RowOptions): RowSpec[] {
  const rows: RowSpec[] = [];
  const user = turn[0]?.role === "user" ? turn[0] : undefined;
  if (user) rows.push(...userRows(user, options.pending?.get(user.id)));
  const rest = user ? turn.slice(1) : turn;
  const items = groupTurnItems(rest, { settled: !live });
  const fold = live ? undefined : foldableWork(items);
  const turnId = user?.id ?? turn[0]?.id ?? "turn";
  if (live && !rest.some((block) => block.text.trim() || block.role === "tool")) {
    rows.push({ id: `${turnId}:thinking`, v: 1, k: "thinkingRow", runs: [{ t: "Thinking…", s: "reasoning" }], anim: { pulse: true }, gap: 10 });
  }
  items.forEach((item, index) => {
    if (fold && index === fold.start) {
      const foldId = `${turnId}:fold`;
      const open = options.open.has(foldId);
      const model = user?.turnModel?.name;
      const label =
        user?.durationMs !== undefined && model
          ? `${model} worked for ${formatDuration(user.durationMs)}`
          : workSummaryLine(foldedBlocks(items, fold));
      rows.push({ id: foldId, v: hash(label, open ? 1 : 0), k: "foldLine", open, runs: [{ t: label, s: "fold" }], gap: 8 });
      if (!open) return;
    } else if (fold && index > fold.start && index <= fold.end && !options.open.has(`${turnId}:fold`)) return;
    rows.push(...itemRows(item, options));
  });
  if (!live && user?.durationMs !== undefined && user.startedAt) {
    const text = `worked for ${formatDuration(user.durationMs)} · ${clock(user.startedAt + user.durationMs)}`;
    rows.push({ id: `${turnId}:footer`, v: hash(text), k: "turnFooter", runs: [{ t: text, s: "meta" }], gap: 2 });
  }
  return rows;
}

const turnCache = new WeakMap<Block, { blocks: Block[]; key: string; rows: RowSpec[] }>();

/** All rows for a session window. Each turn's rows are cached against its
 * blocks, so only the live turn is rebuilt while it streams. */
export function buildRows(blocks: Block[], options: RowOptions): RowSpec[] {
  const turns = groupTurns(blocks);
  const rows: RowSpec[] = [];
  if (options.hasOlder)
    rows.push({
      id: "older",
      v: options.loadingOlder ? 2 : 1,
      k: "loadOlder",
      label: options.loadingOlder ? "Loading earlier messages…" : "Load earlier messages",
    });
  turns.forEach((turn, index) => {
    const live = options.live && index === turns.length - 1;
    const head = turn[0];
    const mark = head ? options.pending?.get(head.id) : undefined;
    const key = `${live}|${options.open.has(`${head?.id}:fold`)}|${[...(options.sending ?? [])].join(",")}|${mark?.label ?? ""}|${mark?.failed?.text ?? ""}|${!!options.canBuild}`;
    const cached = head ? turnCache.get(head) : undefined;
    if (cached && cached.key === key && cached.blocks.length === turn.length && cached.blocks.every((block, i) => block === turn[i])) {
      rows.push(...cached.rows);
      return;
    }
    const built = turnRows(turn, live, options);
    if (head) turnCache.set(head, { blocks: turn, key, rows: built });
    rows.push(...built);
  });
  rows.push({ id: "end", v: 1, k: "spacer", h: 24 });
  return rows;
}
