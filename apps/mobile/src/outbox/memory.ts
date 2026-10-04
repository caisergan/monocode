// The outbox without SQLite, for when the encrypted cache can't be opened.
// Commands still go out in order; they just don't survive a restart.

import { outboxSessionKey, type OutboxEntry, type OutboxPatch, type OutboxState } from "../storage/repo";
import type { OutboxStore } from "./engine";

export class MemoryOutbox implements OutboxStore {
  private rows = new Map<string, OutboxEntry>();

  async put(entry: OutboxEntry): Promise<void> {
    this.rows.set(entry.commandId, entry);
  }

  async list(filter: { env?: string; sessionKey?: string; states?: readonly OutboxState[] } = {}): Promise<OutboxEntry[]> {
    return [...this.rows.values()]
      .filter(
        (entry) =>
          (filter.env === undefined || entry.hostEnv === filter.env) &&
          (filter.sessionKey === undefined || outboxSessionKey(entry) === filter.sessionKey) &&
          (!filter.states || filter.states.includes(entry.state)),
      )
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async update(commandId: string, patch: OutboxPatch): Promise<OutboxEntry | undefined> {
    const entry = this.rows.get(commandId);
    if (!entry) return undefined;
    const next = { ...entry, ...patch };
    this.rows.set(commandId, next);
    return next;
  }

  async rewriteSession(env: string, localSessionId: string, sessionId: string): Promise<number> {
    let count = 0;
    for (const entry of this.rows.values()) {
      if (entry.hostEnv !== env || outboxSessionKey(entry) !== localSessionId) continue;
      const command = entry.command as OutboxEntry["command"] & { sessionId?: string };
      this.rows.set(entry.commandId, {
        ...entry,
        localSessionId: undefined,
        command: command.sessionId === localSessionId ? ({ ...command, sessionId } as OutboxEntry["command"]) : command,
      });
      count++;
    }
    return count;
  }

  async delete(commandId: string): Promise<boolean> {
    return this.rows.delete(commandId);
  }
}
