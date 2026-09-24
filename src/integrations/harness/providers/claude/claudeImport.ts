import {
  appendUser,
  applyHarnessEvent,
  stopStreaming,
} from "../../core/apply";
import { isAgentToolName } from "../../core/preview";
import type { HarnessEvent } from "../../core/types";
import {
  newSession,
  titleFromPrompt,
  formatSessionTitle,
  type Session,
} from "../../../../features/sessions/model/session";
import {
  asRecord,
  assistantTextBlocks,
  assistantThinkingBlocks,
  assistantToolUses,
  contextUsedFromAssistant,
  extractExitPlanModePlan,
  isTodoTool,
  previewFromTool,
  stringField,
  taskListFromTodos,
  toolKindFromName,
  toolResultsFromUserMessage,
  toolTitle,
} from "./claudeProtocol";

type ClaudeRecord = Record<string, unknown>;

const INTERRUPTED_BY_USER = "Interrupted by user.";
const COMPACTED = "Conversation compacted.";

/**
 * Records on the conversation's current branch, oldest first. Claude keeps
 * rewound and retried branches in the same file, linked by `parentUuid`; a
 * compaction restarts the chain and points back through `logicalParentUuid`.
 */
export function activeClaudeChain(records: ClaudeRecord[]): ClaudeRecord[] {
  const byId = new Map<string, ClaudeRecord>();
  let leaf: ClaudeRecord | undefined;
  for (const record of records) {
    const id = stringField(record, "uuid");
    if (id) byId.set(id, record);
    const type = stringField(record, "type");
    if (
      id &&
      (type === "user" || type === "assistant") &&
      record.isSidechain !== true
    ) {
      leaf = record;
    }
  }
  if (!leaf) return [];
  const chain: ClaudeRecord[] = [];
  const seen = new Set<string>();
  let current: ClaudeRecord | undefined = leaf;
  while (current) {
    const id = stringField(current, "uuid");
    if (!id || seen.has(id)) break;
    seen.add(id);
    chain.push(current);
    const parent: string | undefined =
      stringField(current, "parentUuid") ??
      stringField(current, "logicalParentUuid");
    current = parent ? byId.get(parent) : undefined;
  }
  return chain.reverse();
}

type UserEntry =
  | { kind: "prompt"; text: string; imageCount: number }
  | { kind: "interrupt" }
  | { kind: "skip" };

function unwrapTag(text: string, tag: string): string | undefined {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match?.[1]?.trim();
}

/** What a non-tool-result user record means for the transcript. */
export function classifyClaudeUserRecord(record: ClaudeRecord): UserEntry {
  if (record.isMeta === true || record.isCompactSummary === true) {
    return { kind: "skip" };
  }
  const content = asRecord(record.message)?.content;
  let text = "";
  let imageCount = 0;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const row = asRecord(block);
      const type = stringField(row, "type");
      if (type === "tool_result") return { kind: "skip" };
      if (type === "image") imageCount += 1;
      if (type === "text" && typeof row?.text === "string") {
        parts.push(row.text);
      }
    }
    text = parts.join("\n");
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("[Request interrupted")) return { kind: "interrupt" };
  if (
    trimmed.startsWith("<local-command-") ||
    trimmed.startsWith("<task-notification>") ||
    trimmed.startsWith("<system-reminder>")
  ) {
    return { kind: "skip" };
  }
  const command = unwrapTag(trimmed, "command-name");
  if (command) {
    const args = unwrapTag(trimmed, "command-args");
    return {
      kind: "prompt",
      text: args ? `${command} ${args}` : command,
      imageCount: 0,
    };
  }
  if (!trimmed && imageCount === 0) return { kind: "skip" };
  return { kind: "prompt", text: trimmed, imageCount };
}

function timestampMs(record: ClaudeRecord): number | undefined {
  const value = stringField(record, "timestamp");
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function lastModelId(chain: ClaudeRecord[]): string | undefined {
  for (let i = chain.length - 1; i >= 0; i--) {
    const record = chain[i];
    if (stringField(record, "type") !== "assistant") continue;
    const model = stringField(asRecord(record.message), "model");
    if (model && !model.startsWith("<")) return model;
  }
  return undefined;
}

function transcriptTitle(records: ClaudeRecord[]): string | undefined {
  let ai: string | undefined;
  let custom: string | undefined;
  for (const record of records) {
    const type = stringField(record, "type");
    if (type === "ai-title") ai = stringField(record, "aiTitle")?.trim() || ai;
    if (type === "custom-title") {
      custom = stringField(record, "customTitle")?.trim() || custom;
    }
  }
  return custom ?? ai;
}

type ImportedTool = {
  name: string;
  input: Record<string, unknown>;
  title: string;
};

export type ClaudeImportInput = {
  records: ClaudeRecord[];
  providerSessionId: string;
  cwd: string;
};

/**
 * Rebuild a MonoCode session from a Claude Code transcript. Every record is
 * replayed through the same events the live adapter emits, so an imported chat
 * renders exactly like one that ran here. `providerSessionId` makes the next
 * turn `--resume` the original Claude conversation.
 */
export function claudeTranscriptToSession({
  records,
  providerSessionId,
  cwd,
}: ClaudeImportInput): Session {
  const chain = activeClaudeChain(records);
  let session: Session = {
    ...newSession("claude", cwd, lastModelId(chain)),
    providerSessionId,
  };
  const tools = new Map<string, ImportedTool>();
  let firstPrompt: string | undefined;
  let turnStart: number | undefined;
  let turnEnd: number | undefined;
  let turnOpen = false;
  let lastContext: number | undefined;

  const emit = (event: HarnessEvent) => {
    session = applyHarnessEvent(session, event);
  };

  const closeTurn = () => {
    if (!turnOpen) return;
    turnOpen = false;
    const blocks = session.blocks.slice();
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].role !== "user") continue;
      blocks[i] = {
        ...blocks[i],
        ...(turnStart != null ? { startedAt: turnStart } : {}),
        ...(turnStart != null && turnEnd != null
          ? { durationMs: Math.max(0, turnEnd - turnStart) }
          : {}),
      };
      break;
    }
    session = stopStreaming({ ...session, blocks });
  };

  for (const record of chain) {
    if (record.isSidechain === true) continue;
    const type = stringField(record, "type");
    const at = timestampMs(record);

    if (type === "system") {
      if (stringField(record, "subtype") === "compact_boundary") {
        closeTurn();
        emit({ type: "status", text: COMPACTED });
      }
      continue;
    }

    if (type === "user") {
      const entry = classifyClaudeUserRecord(record);
      if (entry.kind === "prompt") {
        closeTurn();
        const text =
          entry.imageCount > 0
            ? `${entry.text}${entry.text ? "\n\n" : ""}_${entry.imageCount} image${entry.imageCount === 1 ? "" : "s"} not imported_`
            : entry.text;
        session = appendUser(session, text);
        firstPrompt ??= entry.text;
        turnOpen = true;
        turnStart = at;
        turnEnd = at;
        continue;
      }
      if (entry.kind === "interrupt") {
        if (turnOpen) {
          closeTurn();
          session = {
            ...session,
            blocks: [
              ...session.blocks,
              {
                id: crypto.randomUUID(),
                role: "system",
                text: INTERRUPTED_BY_USER,
                notice: "interrupt",
              },
            ],
          };
        }
        continue;
      }
      if (!turnOpen) continue;
      if (at != null) turnEnd = at;
      for (const result of toolResultsFromUserMessage(record)) {
        const tool = tools.get(result.toolUseId);
        if (!tool) continue;
        emit({
          type: "tool.updated",
          callId: result.toolUseId,
          title: tool.title,
          kind: toolKindFromName(tool.name),
          status: result.isError ? "failed" : "completed",
          detail: result.text || undefined,
          preview: previewFromTool(tool.name, tool.input, result.text),
        });
        if (isAgentToolName(tool.name) && result.text.trim() && !result.isError) {
          emit({
            type: "agent.step",
            callId: result.toolUseId,
            stepId: `${result.toolUseId}:report`,
            kind: "message",
            text: result.text,
          });
        }
      }
      continue;
    }

    if (type !== "assistant" || !turnOpen) continue;
    if (at != null) turnEnd = at;
    lastContext = contextUsedFromAssistant(record) ?? lastContext;

    const thinking = assistantThinkingBlocks(record).join("").trim();
    if (thinking) {
      emit({ type: "reasoning.delta", text: thinking });
      emit({ type: "reasoning.completed" });
    }
    const text = assistantTextBlocks(record).join("");
    if (text.trim()) {
      emit({ type: "message.delta", text });
      emit({ type: "message.completed" });
    }
    for (const use of assistantToolUses(record)) {
      const tool: ImportedTool = {
        name: use.name,
        input: use.input,
        title: toolTitle(use.name, use.input),
      };
      tools.set(use.id, tool);
      const agentModel = isAgentToolName(use.name)
        ? stringField(use.input, "model")
        : undefined;
      emit({
        type: "tool.started",
        callId: use.id,
        title: tool.title,
        kind: toolKindFromName(use.name),
        ...(agentModel ? { agentModel } : {}),
        status: isAgentToolName(use.name) ? "in_progress" : "pending",
        preview: previewFromTool(use.name, use.input),
      });
      if (use.name === "ExitPlanMode") {
        const plan = extractExitPlanModePlan(use.input);
        if (plan) emit({ type: "plan", text: plan });
      }
      if (isTodoTool(use.name)) {
        const items = taskListFromTodos(use.input);
        if (items) emit({ type: "tasks.updated", items });
      }
    }
  }
  closeTurn();

  if (lastContext !== undefined) emit({ type: "context", used: lastContext });
  const title = transcriptTitle(records);
  return {
    ...session,
    busy: false,
    title: title
      ? formatSessionTitle("claude", title)
      : titleFromPrompt(firstPrompt ?? "", "claude"),
  };
}
