import type {
  AgentRunUsage,
  AgentStepKind,
  Block,
  ToolPreview,
} from "../../../../features/sessions/model/session";
import { readHarnessTextRange } from "../../core/child";
import {
  assistantMessageId,
  assistantTextBlocks,
  assistantThinkingBlocks,
  assistantToolUses,
  previewFromTool,
  toolKindFromName,
  toolResultsFromUserMessage,
  toolTitle,
} from "./claudeProtocol";

/**
 * Claude writes every subagent's conversation to its own JSONL file, and hands
 * the path over as the task's `outputFile`. The parent's stream mirrors the
 * subagent's messages too, but with the usage each one had when its first
 * content block landed — output counts there are a fraction of the real ones.
 * The file has every request's final usage, so it is what the run's tokens
 * are counted from, and what its context view is read from.
 */

export type RequestUsage = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
};

export type ClaudeSubagentTranscript = {
  /** The transcript file; the resolved path once it has been read. */
  path: string;
  /** Bytes already read. The file only ever grows while the run works. */
  offset: number;
  /** Each request's usage by message id; later records carry later counts. */
  requests: Map<string, RequestUsage>;
  lastRequestId?: string;
  model?: string;
  /** The conversation itself, kept only by readers that show it. */
  blocks?: Block[];
  /**
   * What the run did since its trail last took it, kept only by readers that
   * mirror the trail. A workflow's agents say nothing on the parent's stream,
   * so their file is the only place their steps can come from.
   */
  steps?: ClaudeTranscriptStep[];
  /** The brief the run was given, read along with the trail. */
  brief?: string;
  tools: Map<
    string,
    { index: number; name: string; input: Record<string, unknown> }
  >;
  /** The read in flight, so overlapping polls share it. */
  reading?: Promise<boolean>;
};

/** One step on a run's trail, as the parent's stream would have mirrored it. */
export type ClaudeTranscriptStep = {
  /** The ids the stream uses, so a step seen both ways stays one step. */
  stepId: string;
  kind: AgentStepKind;
  text: string;
  toolKind?: string;
  status?: string;
  detail?: string;
  preview?: ToolPreview;
};

/** The most of the conversation a context view holds on to. */
const MAX_CONTEXT_BLOCKS = 600;
const MAX_CONTEXT_TEXT = 20_000;
const MAX_TOOL_OUTPUT = 4_000;

export function claudeSubagentTranscript(
  path: string,
  options: { blocks?: boolean; trail?: boolean } = {},
): ClaudeSubagentTranscript {
  return {
    path,
    offset: 0,
    requests: new Map(),
    tools: new Map(),
    ...(options.blocks ? { blocks: [] } : {}),
    ...(options.trail ? { steps: [] } : {}),
  };
}

/**
 * Read whatever the run has written since the last read. Resolves true when
 * anything new arrived.
 */
export function readClaudeSubagentTranscript(
  transcript: ClaudeSubagentTranscript,
): Promise<boolean> {
  transcript.reading ??= readNewLines(transcript).finally(() => {
    transcript.reading = undefined;
  });
  return transcript.reading;
}

async function readNewLines(
  transcript: ClaudeSubagentTranscript,
): Promise<boolean> {
  let changed = false;
  for (;;) {
    const range = await readHarnessTextRange(
      transcript.path,
      transcript.offset,
    );
    transcript.path = range.path;
    if (range.size < transcript.offset) {
      // The file was replaced; start it over rather than read past its end.
      resetTranscript(transcript);
      continue;
    }
    if (range.text) {
      changed = feedClaudeSubagentTranscript(transcript, range.text) || changed;
    }
    const advanced = range.nextOffset > transcript.offset;
    transcript.offset = range.nextOffset;
    if (!advanced || transcript.offset >= range.size) return changed;
  }
}

function resetTranscript(transcript: ClaudeSubagentTranscript): void {
  transcript.offset = 0;
  transcript.requests.clear();
  transcript.tools.clear();
  transcript.lastRequestId = undefined;
  if (transcript.blocks) transcript.blocks = [];
  // Read again from the top, the steps come back under the same ids.
  if (transcript.steps) transcript.steps = [];
}

/** Take in complete JSONL lines. Returns true when anything was recorded. */
export function feedClaudeSubagentTranscript(
  transcript: ClaudeSubagentTranscript,
  text: string,
): boolean {
  let changed = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        continue;
      rec = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (rec.type === "assistant") {
      changed = noteAssistant(transcript, rec) || changed;
    } else if (rec.type === "user" && rec.isMeta !== true) {
      changed = noteUser(transcript, rec) || changed;
    }
  }
  return changed;
}

function noteAssistant(
  transcript: ClaudeSubagentTranscript,
  rec: Record<string, unknown>,
): boolean {
  const message = record(rec.message);
  if (!message) return false;
  const id = typeof message.id === "string" ? message.id : undefined;
  const model = typeof message.model === "string" ? message.model : undefined;
  if (model && model !== "<synthetic>") transcript.model = model;
  const usage = requestUsage(record(message.usage));
  if (id && usage) {
    mergeRequestUsage(transcript.requests, id, usage);
    transcript.lastRequestId = id;
  }
  const traced = noteAssistantTrail(transcript, rec);
  const blocks = transcript.blocks;
  if (!blocks) return Boolean(id && usage) || traced;
  const key = typeof rec.uuid === "string" ? rec.uuid : (id ?? "assistant");
  const content = Array.isArray(message.content) ? message.content : [];
  content.forEach((part, index) => {
    const row = record(part);
    if (!row) return;
    if (row.type === "thinking" && typeof row.thinking === "string") {
      const text = row.thinking.trim();
      if (text) {
        pushBlock(transcript, {
          id: `${key}:${index}`,
          role: "reasoning",
          text: capText(text, MAX_CONTEXT_TEXT),
        });
      }
    } else if (row.type === "text" && typeof row.text === "string") {
      const text = row.text.trim();
      if (text) {
        pushBlock(transcript, {
          id: `${key}:${index}`,
          role: "assistant",
          text: capText(text, MAX_CONTEXT_TEXT),
        });
      }
    }
  });
  for (const use of assistantToolUses(rec)) {
    if (transcript.tools.has(use.id)) continue;
    const title = toolTitle(use.name, use.input);
    const preview = previewFromTool(use.name, use.input);
    const index = pushBlock(transcript, {
      id: use.id,
      role: "tool",
      text: title,
      tool: {
        callId: use.id,
        title,
        kind: toolKindFromName(use.name),
        status: "in_progress",
        ...(preview ? { preview } : {}),
      },
    });
    transcript.tools.set(use.id, { index, name: use.name, input: use.input });
  }
  return true;
}

function noteUser(
  transcript: ClaudeSubagentTranscript,
  rec: Record<string, unknown>,
): boolean {
  const traced = noteUserTrail(transcript, rec);
  const blocks = transcript.blocks;
  if (!blocks) return traced;
  let changed = traced;
  const said = userText(rec);
  if (said.trim()) {
    // The first thing a run is told is the brief its parent wrote.
    pushBlock(transcript, {
      id: typeof rec.uuid === "string" ? rec.uuid : `user:${blocks.length}`,
      role: "user",
      text: capText(said.trim(), MAX_CONTEXT_TEXT),
    });
    changed = true;
  }
  for (const result of toolResultsFromUserMessage(rec)) {
    const tool = transcript.tools.get(result.toolUseId);
    const block = tool ? blocks[tool.index] : undefined;
    if (!tool || !block?.tool || block.id !== result.toolUseId) continue;
    const output = capText(result.text.trim(), MAX_TOOL_OUTPUT);
    const preview = previewFromTool(tool.name, tool.input, output);
    blocks[tool.index] = {
      ...block,
      tool: {
        ...block.tool,
        status: result.isError ? "failed" : "completed",
        ...(output ? { detail: output } : {}),
        ...(preview ? { preview } : {}),
      },
    };
    changed = true;
  }
  return changed;
}

/** What the user side of the conversation said in so many words. */
function userText(rec: Record<string, unknown>): string {
  const content = record(rec.message)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const row = record(part);
      return row?.type === "text" && typeof row.text === "string"
        ? [row.text]
        : [];
    })
    .join("\n");
}

/**
 * The steps in one assistant record: what it thought, what it said, and the
 * calls it made. Claude writes one content block per record, so a request's
 * thinking and its calls arrive as separate records under one message id.
 */
function noteAssistantTrail(
  transcript: ClaudeSubagentTranscript,
  rec: Record<string, unknown>,
): boolean {
  const steps = transcript.steps;
  if (!steps) return false;
  const before = steps.length;
  const messageId =
    assistantMessageId(rec) ??
    (typeof rec.uuid === "string" ? rec.uuid : undefined);
  if (messageId) {
    const thinking = assistantThinkingBlocks(rec).join("").trim();
    if (thinking) {
      steps.push({
        stepId: `${messageId}:thinking`,
        kind: "reasoning",
        text: thinking,
      });
    }
    const text = assistantTextBlocks(rec).join("").trim();
    if (text) {
      steps.push({ stepId: `${messageId}:text`, kind: "message", text });
    }
  }
  for (const use of assistantToolUses(rec)) {
    const preview = previewFromTool(use.name, use.input);
    steps.push({
      stepId: use.id,
      kind: "tool",
      text: toolTitle(use.name, use.input),
      toolKind: toolKindFromName(use.name),
      status: "in_progress",
      ...(preview ? { preview } : {}),
    });
  }
  return steps.length > before;
}

/** The brief, once, and how each call the run made came back. */
function noteUserTrail(
  transcript: ClaudeSubagentTranscript,
  rec: Record<string, unknown>,
): boolean {
  const steps = transcript.steps;
  if (!steps) return false;
  let changed = false;
  if (transcript.brief === undefined) {
    const said = userText(rec).trim();
    if (said) {
      transcript.brief = said;
      changed = true;
    }
  }
  for (const result of toolResultsFromUserMessage(rec)) {
    steps.push({
      stepId: result.toolUseId,
      kind: "tool",
      text: "",
      status: result.isError ? "failed" : "completed",
      ...(result.isError && result.text ? { detail: result.text } : {}),
    });
    changed = true;
  }
  return changed;
}

/**
 * Hand over the steps read since the last call, oldest first, with repeats of
 * a step merged the way the session merges them. Only the newest `limit` are
 * kept, since the session holds no more than that per run anyway.
 */
export function takeClaudeTranscriptSteps(
  transcript: ClaudeSubagentTranscript,
  limit: number,
): ClaudeTranscriptStep[] {
  const steps = transcript.steps;
  if (!steps?.length) return [];
  transcript.steps = [];
  const merged = new Map<string, ClaudeTranscriptStep>();
  for (const step of steps) {
    const prev = merged.get(step.stepId);
    merged.set(
      step.stepId,
      prev
        ? {
            ...prev,
            ...step,
            // A result names no call; keep the label the call announced.
            text: step.text || prev.text,
            ...((step.preview ?? prev.preview)
              ? { preview: step.preview ?? prev.preview }
              : {}),
          }
        : step,
    );
  }
  const list = [...merged.values()];
  return list.length > limit ? list.slice(list.length - limit) : list;
}

/** Append a block, dropping the oldest past the cap but never the brief. */
function pushBlock(transcript: ClaudeSubagentTranscript, block: Block): number {
  const blocks = transcript.blocks!;
  blocks.push(block);
  if (blocks.length > MAX_CONTEXT_BLOCKS) {
    const drop = blocks.length - MAX_CONTEXT_BLOCKS;
    blocks.splice(1, drop);
    for (const [id, tool] of transcript.tools) {
      if (tool.index <= drop) transcript.tools.delete(id);
      else tool.index -= drop;
    }
  }
  return blocks.length - 1;
}

/**
 * What the run has spent so far, counted the way the session totals are:
 * every prompt token not read from the cache is uncached input.
 */
export function claudeSubagentUsage(
  transcript: ClaudeSubagentTranscript,
): AgentRunUsage | undefined {
  return usageFromRequests(transcript.requests, transcript.lastRequestId);
}

export function usageFromRequests(
  requests: Map<string, RequestUsage>,
  lastId?: string,
): AgentRunUsage | undefined {
  if (requests.size === 0) return undefined;
  const usage: AgentRunUsage = {
    uncached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
  };
  for (const request of requests.values()) {
    usage.uncached += request.input + request.cacheWrite;
    usage.cacheRead += request.cacheRead;
    usage.cacheWrite += request.cacheWrite;
    usage.output += request.output;
  }
  const last = lastId ? requests.get(lastId) : undefined;
  if (last) {
    usage.contextUsed =
      last.input + last.cacheRead + last.cacheWrite + last.output;
  }
  return usage;
}

/** One request's usage from a mirrored assistant message, for the fallback. */
export function requestUsage(
  usage: Record<string, unknown> | null | undefined,
): RequestUsage | undefined {
  if (!usage) return undefined;
  return {
    input: count(usage.input_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
    output: count(usage.output_tokens),
  };
}

/** A request's records repeat its usage as it streams; keep the largest. */
export function mergeRequestUsage(
  requests: Map<string, RequestUsage>,
  id: string,
  next: RequestUsage,
): void {
  const prev = requests.get(id);
  requests.set(
    id,
    prev
      ? {
          input: Math.max(prev.input, next.input),
          cacheRead: Math.max(prev.cacheRead, next.cacheRead),
          cacheWrite: Math.max(prev.cacheWrite, next.cacheWrite),
          output: Math.max(prev.output, next.output),
        }
      : next,
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function capText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…`;
}
