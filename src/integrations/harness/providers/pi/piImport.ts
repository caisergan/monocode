import { taskListFromToolInput } from "../../../../features/sessions/model/taskList";
import {
  HARNESS_TITLE,
  newSession,
  type Session,
} from "../../../../features/sessions/model/session";
import {
  recordTimestamp,
  TranscriptReplay,
  type TranscriptImportInput,
} from "../../core/transcriptImport";
import type { HarnessEvent } from "../../core/types";
import {
  asRecord,
  contextFromUsage,
  isPiThinkingLevel,
  previewFromTool,
  stringField,
  textFromContent,
  toolKindFromName,
  toolTitle,
} from "./piProtocol";
import { piSubagentEvents } from "./piSubagents";

type PiEntry = Record<string, unknown>;

/** Entry types that only carry the session's header or title. */
const DETACHED_TYPES = new Set(["session", "title"]);

/**
 * Entries on the conversation's current branch, oldest first. Pi and omp
 * append every entry with a `parentId`, so a rewind or fork leaves the old
 * branch in the file; the last entry written is the leaf being continued.
 */
export function activePiChain(entries: PiEntry[]): PiEntry[] {
  const byId = new Map<string, PiEntry>();
  let leaf: PiEntry | undefined;
  for (const entry of entries) {
    const id = stringField(entry, "id");
    const type = stringField(entry, "type");
    if (!id || !type || DETACHED_TYPES.has(type)) continue;
    byId.set(id, entry);
    leaf = entry;
  }
  const chain: PiEntry[] = [];
  const seen = new Set<string>();
  let current = leaf;
  while (current) {
    const id = stringField(current, "id");
    if (!id || seen.has(id)) break;
    seen.add(id);
    chain.push(current);
    const parent = stringField(current, "parentId");
    current = parent ? byId.get(parent) : undefined;
  }
  return chain.reverse();
}

/** The user's prompt: its text as typed, and how many images it attached. */
export function piUserPrompt(
  message: Record<string, unknown>,
): { text: string; imageCount: number } | null {
  // omp tags who wrote a user message; only the person's own count.
  const attribution = stringField(message, "attribution");
  if (attribution && attribution !== "user") return null;
  const content = message.content;
  let imageCount = 0;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const row = asRecord(block);
      const type = stringField(row, "type");
      if (type === "image") imageCount += 1;
      if (type === "text") parts.push(stringField(row, "text") ?? "");
    }
    text = parts.join("\n");
  }
  text = text.trim();
  if (!text && imageCount === 0) return null;
  return { text, imageCount };
}

/** The session's name: the latest rename, else omp's title slot. */
function transcriptTitle(entries: PiEntry[]): string | undefined {
  let slot: string | undefined;
  let named: string | undefined;
  for (const entry of entries) {
    const type = stringField(entry, "type");
    if (type === "title") slot = stringField(entry, "title")?.trim() || slot;
    if (type === "title_change") {
      named = stringField(entry, "title")?.trim() || named;
    }
    if (type === "session_info") {
      named = stringField(entry, "name")?.trim() || named;
    }
  }
  return named ?? slot;
}

/** The model and thinking level the conversation last ran with. */
function lastModel(
  harness: "pi" | "omp",
  chain: PiEntry[],
): { model?: string; thinking?: string } {
  let model: string | undefined;
  let thinking: string | undefined;
  for (const entry of chain) {
    const type = stringField(entry, "type");
    if (type === "thinking_level_change") {
      thinking = stringField(entry, "thinkingLevel") ?? thinking;
    }
    const message = asRecord(entry.message);
    if (type !== "message" || stringField(message, "role") !== "assistant") {
      continue;
    }
    const provider = stringField(message, "provider");
    const modelId = stringField(message, "model");
    if (provider && modelId) model = `${harness}:${provider}/${modelId}`;
  }
  return {
    ...(model ? { model } : {}),
    ...(isPiThinkingLevel(thinking) ? { thinking } : {}),
  };
}

type ImportedTool = {
  name: string;
  input: Record<string, unknown>;
  title: string;
};

export type PiImportInput = TranscriptImportInput & {
  harness: "pi" | "omp";
};

/**
 * Rebuild a MonoCode session from a Pi or omp session file. The chat keeps
 * the agent's session id, so the next turn resumes it (`--session` for Pi,
 * `--resume` for omp) from the folder it ran in.
 */
export function piTranscriptToSession({
  harness,
  records,
  ...target
}: PiImportInput): Session {
  const chain = activePiChain(records);
  const { model, thinking } = lastModel(harness, chain);
  const replay = new TranscriptReplay(newSession(harness, target.cwd), target);
  const emit = (event: HarnessEvent) => replay.emit(event);
  // As the live adapter reports it: the model the session ran on, even one
  // MonoCode's catalog doesn't list.
  if (model || thinking) {
    emit({
      type: "session.configChanged",
      ...(model ? { model } : {}),
      ...(thinking ? { modelSettings: { thinking } } : {}),
    });
  }
  const tools = new Map<string, ImportedTool>();
  // Pi retries a failed request on its own, and the retry carries the real
  // answer; a failure only shows when nothing after it in the turn succeeded.
  let failure: string | undefined;
  const reportFailure = () => {
    if (failure === undefined) return;
    replay.closeTurn();
    replay.notice(failure, "error");
    failure = undefined;
  };

  for (const entry of chain) {
    const type = stringField(entry, "type");
    const at = recordTimestamp(entry);

    if (type === "compaction") {
      reportFailure();
      replay.compacted();
      continue;
    }
    if (type !== "message") continue;
    const message = asRecord(entry.message);
    const role = stringField(message, "role");
    if (!message) continue;

    if (role === "user") {
      const prompt = piUserPrompt(message);
      if (!prompt) continue;
      reportFailure();
      replay.prompt(prompt.text, prompt.imageCount, at);
      continue;
    }
    if (!replay.inTurn) continue;
    replay.touch(at);

    if (role === "toolResult") {
      const callId = stringField(message, "toolCallId");
      const tool = callId ? tools.get(callId) : undefined;
      if (!callId || !tool) continue;
      const isError = message.isError === true;
      const output = textFromContent(message.content);
      emit({
        type: "tool.updated",
        callId,
        title: tool.title,
        kind: toolKindFromName(tool.name),
        status: isError ? "failed" : "completed",
        detail: output || undefined,
        preview: previewFromTool(tool.name, tool.input, output),
      });
      if (toolKindFromName(tool.name) === "agent") {
        const result = { details: message.details, content: message.content };
        for (const event of piSubagentEvents(
          callId,
          tool.input,
          result,
          true,
          isError,
        )) {
          emit(event);
        }
      }
      continue;
    }

    if (role !== "assistant") continue;
    replay.context(contextFromUsage(message)?.used);
    const content = Array.isArray(message.content) ? message.content : [];
    const thinkingText = content
      .map((block) => asRecord(block))
      .filter((block) => stringField(block, "type") === "thinking")
      .map((block) => stringField(block, "thinking") ?? "")
      .join("")
      .trim();
    if (thinkingText) {
      emit({ type: "reasoning.delta", text: thinkingText });
      emit({ type: "reasoning.completed" });
    }
    const text = content
      .map((block) => asRecord(block))
      .filter((block) => stringField(block, "type") === "text")
      .map((block) => stringField(block, "text") ?? "")
      .join("");
    if (text.trim()) {
      emit({ type: "message.delta", text });
      emit({ type: "message.completed" });
    }
    for (const block of content) {
      const call = asRecord(block);
      if (stringField(call, "type") !== "toolCall") continue;
      const id = stringField(call, "id");
      const name = stringField(call, "name");
      if (!id || !name) continue;
      const input = asRecord(call?.arguments) ?? {};
      const tool: ImportedTool = { name, input, title: toolTitle(name, input) };
      tools.set(id, tool);
      emit({
        type: "tool.started",
        callId: id,
        title: tool.title,
        kind: toolKindFromName(name),
        status: "pending",
        preview: previewFromTool(name, input),
      });
      const items = taskListFromToolInput(name, input);
      if (items) emit({ type: "tasks.updated", items });
    }

    const stopReason = stringField(message, "stopReason");
    if (stopReason === "error") {
      const reason = stringField(message, "errorMessage")?.trim();
      failure = reason
        ? `${HARNESS_TITLE[harness]} stopped with an error: ${reason}`
        : `${HARNESS_TITLE[harness]} stopped with an error.`;
      continue;
    }
    failure = undefined;
    if (stopReason === "aborted") replay.interrupt();
  }

  reportFailure();
  return replay.finish(harness, transcriptTitle(records));
}
