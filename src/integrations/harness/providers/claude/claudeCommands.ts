import { normalizeProjectPath } from "../../../../features/projects/model/recents";
import {
  acquireHarnessBridge,
  killChild,
  resolveClaudeBinary,
  spawnChild,
  unwatchChild,
  watchChild,
  writeChild,
} from "../../core/child";
import type {
  NativeCommand,
  NativeCommandProvider,
} from "../../core/nativeCommands";
import {
  buildClaudeSpawnArgs,
  buildControlRequest,
  claudeCommandsFromRecord,
  parseControlResponse,
  parseJsonLine,
} from "./claudeProtocol";

const PROBE_TIMEOUT_MS = 8_000;
const PROBE_REQUEST_ID = "monocode_commands";
const PROBE_RETRY_MS = 30_000;

type Listener = (commands: NativeCommand[]) => void;

/**
 * Claude's slash commands by project folder. The list depends on the folder
 * (project skills, plugins, settings), not on the conversation, so every
 * session in a folder shares one entry.
 */
const knownByCwd = new Map<string, NativeCommand[]>();
const listenersByCwd = new Map<string, Set<Listener>>();
const probesByCwd = new Map<string, Promise<void>>();
const retryAtByCwd = new Map<string, number>();

/** A running session reports the list it actually has; it replaces a probe's. */
export function noteClaudeCommands(
  cwd: string,
  commands: NativeCommand[],
): void {
  const key = normalizeProjectPath(cwd);
  const previous = knownByCwd.get(key);
  knownByCwd.set(key, commands);
  if (previous && JSON.stringify(previous) === JSON.stringify(commands)) return;
  for (const listener of listenersByCwd.get(key) ?? []) listener(commands);
}

export const claudeCommandProvider: NativeCommandProvider = {
  rawSlashCommands: true,
  alongsideSkills: true,
  async discover(context) {
    const key = normalizeProjectPath(context.cwd);
    if (!knownByCwd.has(key)) await probe(key);
    return knownByCwd.get(key) ?? [];
  },
  subscribe(context, onCommands) {
    const key = normalizeProjectPath(context.cwd);
    let listeners = listenersByCwd.get(key);
    if (!listeners) listenersByCwd.set(key, (listeners = new Set()));
    listeners.add(onCommands);
    return () => {
      listeners.delete(onCommands);
      if (!listeners.size) listenersByCwd.delete(key);
    };
  },
};

/** One probe per folder at a time; a failed one is not retried right away. */
function probe(cwd: string): Promise<void> {
  const running = probesByCwd.get(cwd);
  if (running) return running;
  if (Date.now() < (retryAtByCwd.get(cwd) ?? 0)) return Promise.resolve();
  const started = probeCommands(cwd)
    .then((commands) => {
      // A session that started meanwhile already reported the better list.
      if (!knownByCwd.has(cwd)) noteClaudeCommands(cwd, commands);
    })
    .catch((error: unknown) => {
      retryAtByCwd.set(cwd, Date.now() + PROBE_RETRY_MS);
      console.debug("[monocode] claude commands", error);
    })
    .finally(() => {
      probesByCwd.delete(cwd);
    });
  probesByCwd.set(cwd, started);
  return started;
}

/**
 * Ask a throwaway Claude process for its command list. It only answers
 * `initialize`: no prompt is sent, no hooks run and nothing is saved.
 */
async function probeCommands(cwd: string): Promise<NativeCommand[]> {
  const { path } = await resolveClaudeBinary();
  const releaseBridge = await acquireHarnessBridge();
  const childId = `monocode-claude-commands-${crypto.randomUUID()}`;

  let listed: ((commands: NativeCommand[]) => void) | null = null;
  let failed: ((error: Error) => void) | null = null;
  const pending = new Promise<NativeCommand[]>((resolve, reject) => {
    listed = resolve;
    failed = reject;
  });
  // The timeout can fire while the spawn is still being awaited.
  pending.catch(() => undefined);
  const timer = setTimeout(
    () => failed?.(new Error("Claude Code command probe timed out")),
    PROBE_TIMEOUT_MS,
  );

  watchChild(
    childId,
    (line) => {
      const rec = parseJsonLine(line);
      if (!rec) return;
      const commands = claudeCommandsFromRecord(rec);
      if (commands) listed?.(commands);
      // An older Claude Code answers without a command list; do not wait on.
      else if (parseControlResponse(rec)?.requestId === PROBE_REQUEST_ID)
        listed?.([]);
    },
    () => failed?.(new Error("Claude Code command probe exited")),
  );

  try {
    await spawnChild(
      childId,
      path,
      buildClaudeSpawnArgs({ isolated: true, includePartialMessages: false }),
      cwd,
      undefined,
      "claude",
    );
    await writeChild(
      childId,
      JSON.stringify(
        buildControlRequest(PROBE_REQUEST_ID, { subtype: "initialize" }),
      ),
    );
    return await pending;
  } finally {
    clearTimeout(timer);
    unwatchChild(childId);
    await killChild(childId).catch(() => undefined);
    releaseBridge();
  }
}

/** Exported for tests. */
export function __claudeCommandsTestReset(): void {
  knownByCwd.clear();
  listenersByCwd.clear();
  probesByCwd.clear();
  retryAtByCwd.clear();
}
