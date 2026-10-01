import {
  newSession,
  type Session,
} from "../../../../features/sessions/model/session";
import type { TranscriptSlice } from "../../core/terminalSync";
import {
  recordTimestamp,
  TranscriptReplay,
  type TranscriptImportInput,
  type TranscriptImportTarget,
} from "../../core/transcriptImport";
import type { HarnessEvent } from "../../core/types";
import { asRecord, mapCodexNotification, stringField } from "./codexProtocol";

type CodexRecord = Record<string, unknown>;

/**
 * A record's place in the rollout. Resuming a conversation appends to the same
 * file and the reader drops the same records every time, so the position, with
 * the record's own timestamp as a check, is a stable cursor.
 */
function recordId(records: CodexRecord[], index: number): string {
  return `${index}:${stringField(records[index], "timestamp") ?? ""}`;
}

/** The last record, which a terminal session keeps as its cursor. */
export function codexLastRecordId(records: CodexRecord[]): string | undefined {
  return records.length > 0 ? recordId(records, records.length - 1) : undefined;
}

/**
 * Where the records after `afterRecord` start, or `undefined` when the cursor
 * is no longer in this rollout (it was rewritten).
 */
function startAfter(
  records: CodexRecord[],
  afterRecord: string | undefined,
): number | undefined {
  if (!afterRecord) return 0;
  const index = Number.parseInt(afterRecord, 10);
  if (!Number.isInteger(index) || index < 0 || index >= records.length) {
    return undefined;
  }
  return recordId(records, index) === afterRecord ? index + 1 : undefined;
}

export type CodexImportInput = TranscriptImportInput;

/** Rebuild a MonoCode session from a whole Codex rollout. */
export function codexTranscriptToSession({
  records,
  ...target
}: CodexImportInput): Session {
  return replayCodex(records, 0, target).session;
}

/**
 * The rollout after `afterRecord`, as blocks. A cursor that is no longer in
 * the file, or a rollback of more turns than came after it, replays everything.
 */
export function codexTranscriptSlice(
  records: CodexRecord[],
  afterRecord: string | undefined,
  cwd: string,
): TranscriptSlice {
  const start = startAfter(records, afterRecord);
  let replayed = start === undefined ? undefined : replayCodex(records, start, { cwd });
  const rewound = !replayed || replayed.rolledBackPastStart;
  if (rewound) replayed = replayCodex(records, 0, { cwd });
  return {
    blocks: replayed!.session.blocks,
    rewound,
    ...(replayed!.session.context
      ? { contextUsed: replayed!.session.context.used }
      : {}),
    ...(replayed!.session.context?.window
      ? { contextWindow: replayed!.session.context.window }
      : {}),
  };
}

type Replayed = { session: Session; rolledBackPastStart: boolean };

const SHELL_TOOLS = new Set([
  "exec_command",
  "shell",
  "shell_command",
  "local_shell",
  "container.exec",
]);

/** Call ids that a `*_end` event describes in full. */
function eventCallIds(records: CodexRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    if (stringField(record, "type") !== "event_msg") continue;
    const payload = asRecord(record.payload);
    const type = stringField(payload, "type");
    if (
      type === "exec_command_end" ||
      type === "patch_apply_end" ||
      type === "mcp_tool_call_end" ||
      type === "web_search_end"
    ) {
      const id = stringField(payload, "call_id");
      if (id) ids.add(id);
    }
  }
  return ids;
}

function replayCodex(
  records: CodexRecord[],
  from: number,
  target: TranscriptImportTarget,
): Replayed {
  const covered = eventCallIds(records);
  let model: string | undefined;
  for (const record of records) {
    if (stringField(record, "type") === "turn_context") {
      model = stringField(asRecord(record.payload), "model") ?? model;
    }
  }
  const replay = new TranscriptReplay(newSession("codex", target.cwd, model), target);
  const emit = (event: HarnessEvent) => replay.emit(event);
  let rolledBackPastStart = false;
  let lastAssistantText = "";
  // Tool calls seen as model calls, waiting for their output record.
  const calls = new Map<string, Record<string, unknown>>();

  const item = (method: "item/started" | "item/completed", body: Record<string, unknown>) => {
    for (const event of mapCodexNotification(method, { item: body }).events) {
      emit(event);
    }
  };
  const tool = (body: Record<string, unknown>) => {
    item("item/started", { ...body, status: "inProgress" });
    item("item/completed", body);
  };
  const say = (text: string) => {
    if (!text.trim() || text === lastAssistantText) return;
    lastAssistantText = text;
    emit({ type: "message.delta", text });
    emit({ type: "message.completed" });
  };

  for (let index = from; index < records.length; index += 1) {
    const record = records[index];
    const type = stringField(record, "type");
    const payload = asRecord(record.payload);
    const at = recordTimestamp(record);
    if (!payload) continue;

    if (type === "event_msg") {
      const event = stringField(payload, "type");
      if (event === "user_message") {
        replay.prompt(
          stringField(payload, "message") ?? "",
          listLength(payload.images) + listLength(payload.local_images),
          at,
        );
        lastAssistantText = "";
      } else if (event === "item_completed") {
        const body = asRecord(payload.item);
        const kind = stringField(body, "type");
        if (kind === "UserMessage") {
          const parts = Array.isArray(body?.content) ? body.content : [];
          const text = parts
            .map((part) => stringField(asRecord(part), "text") ?? "")
            .filter(Boolean)
            .join("\n");
          const images = parts.filter((part) => {
            const partType = stringField(asRecord(part), "type") ?? "";
            return /image/i.test(partType);
          }).length;
          replay.prompt(text, images, at);
          lastAssistantText = "";
        } else if (replay.inTurn && kind === "AgentMessage") {
          replay.touch(at);
          const parts = Array.isArray(body?.content) ? body.content : [];
          say(
            parts
              .map((part) => stringField(asRecord(part), "text") ?? "")
              .join(""),
          );
        } else if (replay.inTurn && kind === "Reasoning") {
          const summary = Array.isArray(body?.summary) ? body.summary : [];
          const text = summary
            .map((part) =>
              typeof part === "string" ? part : (stringField(asRecord(part), "text") ?? ""),
            )
            .filter(Boolean)
            .join("\n");
          if (text) {
            emit({ type: "reasoning.delta", text });
            emit({ type: "reasoning.completed" });
          }
        }
      } else if (event === "turn_aborted") {
        replay.interrupt();
      } else if (event === "context_compacted") {
        replay.compacted();
      } else if (event === "thread_rolled_back") {
        const turns = Number(payload.num_turns);
        if (Number.isFinite(turns) && turns > 0) {
          replay.closeTurn();
          const blocks = replay.session.blocks;
          const users = blocks.flatMap((block, at) => (block.role === "user" ? [at] : []));
          if (users.length < turns) rolledBackPastStart = true;
          const keep = users.length >= turns ? users[users.length - turns] : 0;
          replay.session = { ...replay.session, blocks: blocks.slice(0, keep) };
        }
      } else if (replay.inTurn) {
        replay.touch(at);
        if (event === "agent_message") {
          say(stringField(payload, "message") ?? "");
        } else if (event === "agent_reasoning") {
          const text = stringField(payload, "text");
          if (text) {
            emit({ type: "reasoning.delta", text });
            emit({ type: "reasoning.completed" });
          }
        } else if (event === "exec_command_end") {
          tool(commandItem(payload));
        } else if (event === "patch_apply_end") {
          tool(patchItem(payload));
        } else if (event === "mcp_tool_call_end") {
          tool(mcpItem(payload));
        } else if (event === "web_search_end") {
          tool({
            type: "webSearch",
            id: stringField(payload, "call_id") ?? `search-${index}`,
            query: stringField(payload, "query") ?? "Search",
            status: "completed",
          });
        } else if (event === "token_count") {
          const info = asRecord(payload.info);
          const used = numberField(asRecord(info?.last_token_usage), "total_tokens");
          if (used !== undefined) {
            replay.context(used, numberField(info, "model_context_window"));
          }
        }
      }
      continue;
    }

    if (type !== "response_item" || !replay.inTurn) continue;
    const kind = stringField(payload, "type");
    const callId = stringField(payload, "call_id");
    if (!callId || covered.has(callId)) continue;
    if (kind === "function_call" || kind === "custom_tool_call") {
      replay.touch(at);
      const body = modelCallItem(payload, callId);
      calls.set(callId, body);
      item("item/started", { ...body, status: "inProgress" });
    } else if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      const body = calls.get(callId);
      if (!body) continue;
      replay.touch(at);
      calls.delete(callId);
      item("item/completed", {
        ...body,
        status: "completed",
        aggregatedOutput: outputText(payload.output),
      });
    }
  }
  return {
    session: replay.finish("codex", undefined),
    rolledBackPastStart,
  };
}

function listLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function numberField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `["/bin/zsh", "-lc", "git status"]` is the command `git status`. */
function shellCommand(command: unknown): string {
  if (typeof command === "string") return command;
  if (!Array.isArray(command)) return "";
  const parts = command.filter((part): part is string => typeof part === "string");
  const flag = parts.findIndex((part) => /^-\w*c$/.test(part));
  return flag >= 0 && flag < parts.length - 1
    ? parts.slice(flag + 1).join(" ")
    : parts.join(" ");
}

function commandItem(payload: Record<string, unknown>): Record<string, unknown> {
  const failed =
    stringField(payload, "status") === "failed" ||
    (numberField(payload, "exit_code") ?? 0) !== 0;
  return {
    type: "commandExecution",
    id: stringField(payload, "call_id") ?? "",
    command: shellCommand(payload.command) || "Shell",
    cwd: stringField(payload, "cwd"),
    aggregatedOutput: stringField(payload, "aggregated_output") ?? "",
    status: failed ? "failed" : "completed",
  };
}

function patchItem(payload: Record<string, unknown>): Record<string, unknown> {
  const changes = asRecord(payload.changes) ?? {};
  return {
    type: "fileChange",
    id: stringField(payload, "call_id") ?? "",
    status: payload.success === false ? "failed" : "completed",
    changes: Object.entries(changes).map(([path, change]) => {
      const row = asRecord(change);
      const content = stringField(row, "content");
      return {
        path,
        diff:
          stringField(row, "unified_diff") ??
          (content
            ? `@@ -0,0 +1,${content.split("\n").length} @@\n${content
                .split("\n")
                .map((line) => `+${line}`)
                .join("\n")}`
            : undefined),
      };
    }),
  };
}

function mcpItem(payload: Record<string, unknown>): Record<string, unknown> {
  const invocation = asRecord(payload.invocation);
  const result = asRecord(payload.result);
  return {
    type: "mcpToolCall",
    id: stringField(payload, "call_id") ?? "",
    server: stringField(invocation, "server") ?? "mcp",
    tool: stringField(invocation, "tool") ?? "tool",
    arguments: invocation?.arguments,
    status: result && "Err" in result ? "failed" : "completed",
  };
}

/**
 * A model call with no event of its own: shell commands, patches and the
 * script runner. What is not recognized keeps its name.
 */
function modelCallItem(
  payload: Record<string, unknown>,
  callId: string,
): Record<string, unknown> {
  const name = stringField(payload, "name") ?? "tool";
  const raw = stringField(payload, "arguments") ?? stringField(payload, "input") ?? "";
  if (SHELL_TOOLS.has(name)) {
    const args = parseJson(raw);
    const command = shellCommand(args?.cmd ?? args?.command);
    return { type: "commandExecution", id: callId, command: command || "Shell" };
  }
  if (name === "apply_patch") {
    const paths = [...raw.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(
      (match) => match[1].trim(),
    );
    return {
      type: "fileChange",
      id: callId,
      changes: paths.map((path) => ({ path })),
    };
  }
  if (name === "exec") {
    // The code-mode runner: its script calls `tools.exec_command({cmd: "…"})`.
    const cmd = /cmd\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1];
    return {
      type: "commandExecution",
      id: callId,
      command: cmd ? cmd.replace(/\\"/g, '"') : "Run script",
    };
  }
  return {
    type: "mcpToolCall",
    id: callId,
    server: stringField(payload, "namespace") ?? "codex",
    tool: name,
    arguments: parseJson(raw) ?? undefined,
  };
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/** A tool's output as text: a string, `{output}` JSON, or a list of text parts. */
function outputText(output: unknown): string {
  if (typeof output === "string") {
    const parsed = parseJson(output);
    return typeof parsed?.output === "string" ? parsed.output : output;
  }
  if (Array.isArray(output)) {
    return output
      .map((part) => stringField(asRecord(part), "text") ?? "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
