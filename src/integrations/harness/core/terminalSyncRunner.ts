import {
  listAgentSessions,
  readAgentSession,
  statAgentSession,
} from "../../../platform/tauri/agentSessions";
import {
  sessionWorkCwd,
  type HarnessId,
  type Session,
  type TerminalSync,
} from "../../../features/sessions/model/session";
import {
  claudeLastRecordId,
  claudeTranscriptSlice,
} from "../providers/claude/claudeImport";
import {
  codexLastRecordId,
  codexTranscriptSlice,
} from "../providers/codex/codexImport";
import { applyTranscriptSlice, type TranscriptSlice } from "./terminalSync";
import { supportsTerminalSurface, type TerminalHarness } from "./terminalLaunch";

type Records = Record<string, unknown>[];

/** How one agent's saved transcript maps onto a session's blocks. */
type TranscriptAdapter = {
  slice(
    records: Records,
    afterRecord: string | undefined,
    cwd: string,
  ): TranscriptSlice;
  lastRecordId(records: Records): string | undefined;
};

const adapters: Record<TerminalHarness, TranscriptAdapter> = {
  claude: { slice: claudeTranscriptSlice, lastRecordId: claudeLastRecordId },
  codex: { slice: codexTranscriptSlice, lastRecordId: codexLastRecordId },
};

function adapterFor(harness: HarnessId) {
  return supportsTerminalSurface(harness)
    ? { harness, adapter: adapters[harness] }
    : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Where a session's transcript stands when it moves to the terminal: every
 * block it has is kept, and the CLI's records up to now are already in them.
 * A conversation the CLI has not saved yet has no records to account for.
 * Throws when a transcript exists but cannot be read, because a cursor without
 * it would replay the whole conversation on top of the blocks already shown.
 */
export async function initialTerminalSync(
  session: Session,
): Promise<TerminalSync> {
  const base: TerminalSync = {
    prefixBlocks: session.blocks.length,
    syncedSize: 0,
    startedAt: Date.now(),
  };
  const found = adapterFor(session.harness);
  const id = session.providerSessionId;
  if (!found || !id) return base;
  const cwd = sessionWorkCwd(session);
  const account = session.providerAccountId;
  const stat = await statAgentSession(found.harness, cwd, id, account);
  if (!stat) return base;
  const records = await readAgentSession(found.harness, cwd, id, account);
  const afterRecord = found.adapter.lastRecordId(records);
  return {
    ...base,
    ...(afterRecord ? { afterRecord } : {}),
    syncedSize: stat.size,
  };
}

function sameFolder(a: string, b: string): boolean {
  const trim = (path: string) => path.replace(/[\\/]+$/, "");
  return trim(a) === trim(b);
}

/**
 * Codex names its own conversations, so a session started with a bare `codex`
 * has no id until the first prompt saves one. It is the newest conversation in
 * the session's folder saved since the CLI started, leaving out every one that
 * belongs to another MonoCode session.
 */
async function discoverCodexConversation(
  session: Session,
): Promise<string | undefined> {
  const startedAt = session.terminalSync?.startedAt;
  if (!startedAt) return undefined;
  const cwd = sessionWorkCwd(session);
  const listing = await listAgentSessions({
    harnesses: ["codex"],
    cwd,
    // A little slack for a file system clock that is not quite ours.
    since: startedAt - 2000,
    limit: 10,
    ...(session.providerAccountId
      ? { providerAccountId: session.providerAccountId }
      : {}),
  });
  return listing.sessions.find(
    (candidate) => !candidate.monocodeSessionId && sameFolder(candidate.cwd, cwd),
  )?.id;
}

/**
 * Reads what the CLI has written since the last sync into the session. Returns
 * the session with those blocks, or null when there is nothing new. A
 * transcript that cannot be read comes back as the same session carrying the
 * reason, so the pane can say so instead of silently going stale.
 */
export async function syncTerminalSession(
  session: Session,
): Promise<Session | null> {
  const found = adapterFor(session.harness);
  if (session.surface !== "terminal" || !session.terminalSync || !found) {
    return null;
  }
  let current = session;
  const sync = session.terminalSync;
  const cwd = sessionWorkCwd(session);
  const account = session.providerAccountId;
  try {
    if (!current.providerSessionId) {
      const discovered =
        found.harness === "codex"
          ? await discoverCodexConversation(current)
          : undefined;
      if (!discovered) return null;
      current = { ...current, providerSessionId: discovered };
    }
    const id = current.providerSessionId!;
    const stat = await statAgentSession(found.harness, cwd, id, account);
    if (!stat) return current === session ? null : current;
    if (stat.size === sync.syncedSize && !sync.error && current === session) {
      return null;
    }
    const records = await readAgentSession(found.harness, cwd, id, account);
    return applyTranscriptSlice(
      current,
      sync,
      found.adapter.slice(records, sync.afterRecord, cwd),
      stat.size,
    );
  } catch (error) {
    const message = errorText(error);
    if (sync.error === message) return null;
    return { ...current, terminalSync: { ...sync, error: message } };
  }
}
