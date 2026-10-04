import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { Block } from "../src/features/sessions/model/session";
import type {
  CommandReceipt,
  HostProject,
  HostSession,
  HostSessionSummary,
  RemoteProvider,
  SessionSync,
} from "../src/features/connections/model/protocol";
import type { LinkedWorkItem } from "../src/features/sessions/model/session";
import { sessionNeedsInput } from "../src/features/sessions/model/session";
import {
  compareInboxItems,
  lastAssistantText,
  pendingApproval,
  pendingQuestionSummary,
  sessionAttention,
} from "@monocode/core/summary";
import { olderBlocks, truncateBlock, windowMeta, windowStart } from "@monocode/core/window";
import type {
  InboxItem,
  SessionListItem,
  SyncWindow,
  TruncatedBlock,
  WindowedSync,
} from "@monocode/core/wire";
import { DeviceStore, migrateDevices, type Principal } from "./devices";
import { HostError } from "./errors";

const CACHED_SESSIONS = 32;
const INBOX_RECENT_MS = 7 * 86_400_000;
const MUTATION_RECEIPT_MS = 86_400_000;

/** JSON with object keys sorted at every depth, so equal params hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, (item as Record<string, unknown>)[key]]),
        )
      : item,
  );
}

/** Phone-facing fields kept beside the desktop summary (`sessions.phone`). */
export type PhoneSummary = Pick<
  InboxItem,
  "attention" | "approval" | "question" | "lastText" | "finishedAt" | "queueLength" | "branch"
>;

export type SessionChange = {
  sessionId: string;
  projectId: string;
  revision: number;
  deleted?: boolean;
  /** An Agents-relevant field changed (status, attention, title, …). */
  inbox: boolean;
};

export class HostStore {
  readonly db: DatabaseSync;
  readonly environmentId: string;
  readonly attachmentDir: string;
  // This process is the only session writer, so recently used snapshots are
  // served from memory instead of re-parsing whole transcripts. Callers must
  // treat returned values as immutable.
  private cache = new Map<string, HostSession>();
  readonly devices: DeviceStore;
  private listeners = new Set<(change: SessionChange) => void>();
  /** Changes made inside the open transaction, announced after COMMIT. */
  private pending: SessionChange[] | undefined;
  /** Bumped whenever an Agents-relevant field changes; phones compare it. */
  inboxRevision = 0;
  /** Keyed mutations still running; a duplicate waits for the first. */
  private mutations = new Map<
    string,
    { deviceId: string; method: string; hash: string; result: Promise<unknown> }
  >();
  private inboxKeys = new Map<string, string>();

  constructor(path: string) {
    this.attachmentDir = join(dirname(path), "attachments");
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, cwd TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, signature TEXT NOT NULL, receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (session_id TEXT NOT NULL REFERENCES sessions(id), revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id, revision));
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);`);
    const columns = this.db.prepare("PRAGMA table_info(sessions)").all();
    if (!columns.some((column) => column.name === "summary"))
      this.db.exec("ALTER TABLE sessions ADD COLUMN summary TEXT");
    if (!columns.some((column) => column.name === "phone"))
      this.db.exec("ALTER TABLE sessions ADD COLUMN phone TEXT");
    migrateDevices(this.db);
    this.devices = new DeviceStore(this.db);
    this.db
      .prepare("INSERT OR IGNORE INTO metadata VALUES ('environmentId', ?)")
      .run(randomUUID());
    this.environmentId = String(
      this.db
        .prepare("SELECT value FROM metadata WHERE key='environmentId'")
        .get()!.value,
    );
  }

  /** Called after a session change is committed. */
  onChange(listener: (change: SessionChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(change: SessionChange): void {
    if (change.inbox) this.inboxRevision++;
    if (this.pending) this.pending.push(change);
    else this.announce([change]);
  }

  private announce(changes: SessionChange[]): void {
    for (const change of changes)
      for (const listener of this.listeners) {
        try {
          listener(change);
        } catch (error) {
          console.error("Session change listener failed:", error);
        }
      }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    const outer = this.pending;
    this.pending = [];
    try {
      const value = fn();
      this.db.exec("COMMIT");
      const changes = this.pending;
      this.pending = outer;
      this.announce(changes);
      return value;
    } catch (error) {
      this.pending = outer;
      this.cache.clear();
      this.inboxKeys.clear();
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        console.error("Could not roll back host transaction:", rollbackError);
      }
      throw error;
    }
  }

  project(id: string): HostProject {
    const row = this.db.prepare("SELECT * FROM projects WHERE id=?").get(id);
    if (!row) throw new Error("Project is not registered on this machine");
    return row as unknown as HostProject;
  }

  projects(): HostProject[] {
    return this.db
      .prepare("SELECT * FROM projects ORDER BY name")
      .all() as unknown as HostProject[];
  }

  addProject(cwd: string, name: string): HostProject {
    this.db
      .prepare("INSERT OR IGNORE INTO projects VALUES (?, ?, ?)")
      .run(randomUUID(), cwd, name);
    return this.db
      .prepare("SELECT * FROM projects WHERE cwd=?")
      .get(cwd) as unknown as HostProject;
  }

  private remember(value: HostSession): HostSession {
    this.cache.delete(value.session.id);
    this.cache.set(value.session.id, value);
    if (this.cache.size > CACHED_SESSIONS)
      this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  private find(id: string): HostSession | undefined {
    const cached = this.cache.get(id);
    if (cached) return this.remember(cached);
    const row = this.db
      .prepare("SELECT snapshot FROM sessions WHERE id=?")
      .get(id);
    return row
      ? this.remember(JSON.parse(String(row.snapshot)) as HostSession)
      : undefined;
  }

  session(id: string): HostSession {
    const value = this.find(id);
    if (!value) throw new Error("Session not found on this machine");
    return value;
  }

  summaries(projectId: string): HostSessionSummary[] {
    return this.db
      .prepare("SELECT id, summary FROM sessions WHERE project_id=?")
      .all(projectId)
      .map((row) => {
        const cached = row.summary
          ? (JSON.parse(String(row.summary)) as HostSessionSummary)
          : undefined;
        if (
          cached?.model &&
          cached.needsInput !== undefined &&
          cached.providerSessionId !== undefined
        )
          return cached;
        const fresh = summary(this.session(String(row.id)));
        this.db.prepare("UPDATE sessions SET summary=? WHERE id=?").run(
          JSON.stringify(fresh),
          String(row.id),
        );
        return fresh;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  sync(id: string, revision?: number): SessionSync {
    const value = this.session(id);
    const { blockRevisions, ...snapshot } = value;
    if (revision === value.revision) return { kind: "unchanged", revision };
    if (revision === undefined || revision > value.revision || !blockRevisions)
      return { kind: "snapshot", value: snapshot };
    const {
      session: { blocks, ...session },
      ...rest
    } = snapshot;
    return {
      kind: "delta",
      base: revision,
      value: { ...rest, session },
      blockIds: blocks.map((block) => block.id),
      blocks: blocks.filter(
        (block) => (blockRevisions[block.id] ?? value.revision) > revision,
      ),
    };
  }

  /** `sessions.sync` for phones: only the blocks from the window's anchor to
   * the end, each cut to `maxBlockChars` (spec 06 §6.7). */
  windowedSync(
    id: string,
    revision: number | undefined,
    window: SyncWindow,
    maxBlockChars?: number,
  ): WindowedSync {
    const value = this.session(id);
    const { blockRevisions, ...snapshot } = value;
    const all = value.session.blocks;
    const { start, reset } = windowStart(all, window);
    const meta = windowMeta(all, start);
    const cut = (block: Block): TruncatedBlock =>
      maxBlockChars ? truncateBlock(block, maxBlockChars) : block;
    if (revision === value.revision && !reset)
      return { kind: "unchanged", revision, window: meta };
    const blocks = all.slice(start);
    if (revision === undefined || revision > value.revision || !blockRevisions || reset)
      return {
        kind: "snapshot",
        value: { ...snapshot, session: { ...snapshot.session, blocks: blocks.map(cut) } },
        window: meta,
      };
    const { blocks: _omitted, ...session } = snapshot.session;
    return {
      kind: "delta",
      base: revision,
      value: { ...snapshot, session },
      blockIds: blocks.map((block) => block.id),
      blocks: blocks
        .filter((block) => (blockRevisions[block.id] ?? value.revision) > revision)
        .map(cut),
      window: meta,
    };
  }

  /** The `turns` turns that end just before block `before`. */
  olderBlocks(id: string, before: string, turns: number, maxBlockChars?: number) {
    const value = this.session(id);
    const older = olderBlocks(value.session.blocks, before, turns);
    return {
      blocks: older.blocks.map((block) =>
        maxBlockChars ? truncateBlock(block, maxBlockChars) : block,
      ),
      hasOlder: older.olderTurns > 0,
      olderTurns: older.olderTurns,
      revision: value.revision,
    };
  }

  block(id: string, blockId: string): { block: Block; revision: number } {
    const value = this.session(id);
    const block = value.session.blocks.find((item) => item.id === blockId);
    if (!block) throw new Error("Session not found on this machine");
    return { block, revision: value.revision };
  }

  private phoneSummary(id: string, row?: { phone?: unknown }): PhoneSummary {
    if (typeof row?.phone === "string") return JSON.parse(row.phone) as PhoneSummary;
    const fresh = phoneSummary(this.session(id));
    this.db
      .prepare("UPDATE sessions SET phone=? WHERE id=?")
      .run(JSON.stringify(fresh), id);
    return fresh;
  }

  /** One page of a project's sessions, newest first, pinned on top. */
  page(
    projectId: string,
    options: { archived?: "exclude" | "only" | "include"; limit?: number; cursor?: string } = {},
  ): { items: SessionListItem[]; cursor?: string } {
    const project = this.project(projectId);
    const archived = options.archived ?? "exclude";
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
    const after = options.cursor
      ? (JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) as [number, number, string])
      : undefined;
    const rows = this.db
      .prepare("SELECT id, phone FROM sessions WHERE project_id=?")
      .all(projectId) as { id: string; phone?: string }[];
    const phone = new Map(rows.map((row) => [row.id, row]));
    const key = (item: HostSessionSummary): [number, number, string] => [
      item.pinned ? 1 : 0,
      item.updatedAt,
      item.id,
    ];
    const ordered = this.summaries(projectId)
      .filter((item) =>
        archived === "include" ? true : archived === "only" ? !!item.archived : !item.archived,
      )
      .sort((a, b) => {
        const [ap, au, ai] = key(a);
        const [bp, bu, bi] = key(b);
        return bp - ap || bu - au || (ai < bi ? -1 : ai > bi ? 1 : 0);
      });
    const startIndex = after
      ? ordered.findIndex((item) => {
          const [p, u, i] = key(item);
          return p < after[0] || (p === after[0] && (u < after[1] || (u === after[1] && i > after[2])));
        })
      : 0;
    const slice = startIndex < 0 ? [] : ordered.slice(startIndex, startIndex + limit);
    const items = slice.map((item) => {
      const extra = this.phoneSummary(item.id, phone.get(item.id));
      return {
        ...item,
        repo: project.name,
        worktreeCwd: item.cwd && item.cwd !== project.cwd ? item.cwd : undefined,
        ...(extra.branch ? { branch: extra.branch } : {}),
        ...(extra.lastText ? { lastText: extra.lastText } : {}),
        ...(extra.finishedAt ? { finishedAt: extra.finishedAt } : {}),
        ...(extra.queueLength ? { queueLength: extra.queueLength } : {}),
      };
    });
    const last = slice[slice.length - 1];
    const more = startIndex >= 0 && startIndex + limit < ordered.length;
    return {
      items,
      ...(more && last
        ? { cursor: Buffer.from(JSON.stringify(key(last))).toString("base64url") }
        : {}),
    };
  }

  /** Every session that is running, needs input, or changed this week,
   * across projects, most urgent first (spec 06 §6.10). */
  inbox(limit = 200): { revision: number; items: InboxItem[]; truncated: boolean } {
    const cap = Math.max(1, Math.min(200, Math.floor(limit)));
    const names = new Map(this.projects().map((project) => [project.id, project]));
    const rows = this.db
      .prepare("SELECT id, project_id, phone FROM sessions")
      .all() as { id: string; project_id: string; phone?: string }[];
    const phone = new Map(rows.map((row) => [row.id, row]));
    const since = Date.now() - INBOX_RECENT_MS;
    const items: InboxItem[] = [];
    for (const projectId of new Set(rows.map((row) => row.project_id))) {
      const project = names.get(projectId);
      if (!project) continue;
      for (const summary of this.summaries(projectId)) {
        if (summary.status !== "running" && !summary.needsInput && summary.updatedAt < since)
          continue;
        const extra = this.phoneSummary(summary.id, phone.get(summary.id));
        items.push({
          sessionId: summary.id,
          projectId,
          projectName: project.name,
          title: summary.title,
          harness: summary.harness,
          ...(summary.model ? { model: summary.model } : {}),
          ...(summary.runtimeMode ? { runtimeMode: summary.runtimeMode } : {}),
          status: summary.status,
          ...(summary.runId ? { runId: summary.runId } : {}),
          attention: extra.attention,
          needsInput: !!summary.needsInput,
          ...(extra.approval ? { approval: extra.approval } : {}),
          ...(extra.question ? { question: extra.question } : {}),
          ...(extra.lastText ? { lastText: extra.lastText } : {}),
          updatedAt: summary.updatedAt,
          ...(extra.finishedAt ? { finishedAt: extra.finishedAt } : {}),
          ...(extra.branch ? { branch: extra.branch } : {}),
          ...(summary.cwd && summary.cwd !== project.cwd ? { worktreeCwd: summary.cwd } : {}),
          ...(summary.pinned ? { pinned: true } : {}),
          ...(summary.archived ? { archived: true } : {}),
          revision: summary.revision,
          ...(extra.queueLength ? { queueLength: extra.queueLength } : {}),
        });
      }
    }
    items.sort(compareInboxItems);
    return { revision: this.inboxRevision, items: items.slice(0, cap), truncated: items.length > cap };
  }

  sessions(projectId?: string): HostSession[] {
    const rows = projectId
      ? this.db
          .prepare("SELECT snapshot FROM sessions WHERE project_id=?")
          .all(projectId)
      : this.db.prepare("SELECT snapshot FROM sessions").all();
    return rows
      .map((row) => JSON.parse(String(row.snapshot)) as HostSession)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Returns the saved value, stamped with per-block change revisions. */
  save(input: HostSession, event: unknown): HostSession {
    const previous = this.find(input.session.id);
    const value = {
      ...input,
      // Older snapshots have no creation time. Preserve their last recorded
      // timestamp when they are first written by this version of the host.
      createdAt:
        input.createdAt ?? previous?.createdAt ?? previous?.updatedAt ?? input.updatedAt,
      blockRevisions: blockRevisions(previous, input),
    };
    const phone = phoneSummary(value);
    this.db
      .prepare(
        "INSERT INTO sessions (id, project_id, snapshot, summary, phone) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot, summary=excluded.summary, phone=excluded.phone",
      )
      .run(
        value.session.id,
        value.projectId,
        JSON.stringify(value),
        JSON.stringify(summary(value)),
        JSON.stringify(phone),
      );
    this.db
      .prepare("INSERT INTO events VALUES (?, ?, ?)")
      .run(value.session.id, value.revision, JSON.stringify(event));
    this.db
      .prepare("DELETE FROM events WHERE session_id=? AND revision<?")
      .run(value.session.id, value.revision - 2_000);
    const key = inboxKey(value, phone);
    const before = this.inboxKeys.get(value.session.id) ?? (previous && inboxKey(previous));
    this.inboxKeys.set(value.session.id, key);
    this.changed({
      sessionId: value.session.id,
      projectId: value.projectId,
      revision: value.revision,
      inbox: before !== key,
    });
    return this.remember(value);
  }

  updateSession(
    id: string,
    patch: { title?: string; archived?: boolean; pinned?: boolean; linkedWorkItem?: LinkedWorkItem | null },
  ): HostSessionSummary {
    return this.transaction(() => {
      const current = this.session(id);
      if (patch.title !== undefined && (!patch.title.trim() || patch.title.length > 200))
        throw new Error("Invalid session title");
      const next = this.save(
        {
          ...current,
          revision: current.revision + 1,
          archived: patch.archived ?? current.archived,
          pinned: patch.pinned ?? current.pinned,
          session: {
            ...current.session,
            ...(patch.title === undefined ? {} : { title: patch.title.trim() }),
            ...(patch.linkedWorkItem === undefined
              ? {}
              : { linkedWorkItem: patch.linkedWorkItem ?? undefined }),
          },
        },
        { type: "session.metadata", patch },
      );
      return summary(next);
    });
  }

  deleteSession(id: string): void {
    this.transaction(() => {
      const current = this.session(id);
      if (current.status === "running")
        throw new Error("Stop this session before deleting it");
      this.db.prepare("DELETE FROM events WHERE session_id=?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
      this.cache.delete(id);
      this.inboxKeys.delete(id);
      this.changed({
        sessionId: id,
        projectId: current.projectId,
        revision: current.revision,
        deleted: true,
        inbox: true,
      });
    });
  }

  receipt(id: string, signature: string): CommandReceipt | undefined {
    const row = this.db.prepare("SELECT * FROM receipts WHERE id=?").get(id);
    if (!row) return undefined;
    if (row.signature !== signature)
      throw new Error("Command ID was already used with a different payload");
    return JSON.parse(String(row.receipt)) as CommandReceipt;
  }

  recordReceipt(signature: string, receipt: CommandReceipt): void {
    this.db
      .prepare("INSERT INTO receipts VALUES (?, ?, ?)")
      .run(receipt.commandId, signature, JSON.stringify(receipt));
  }

  events(
    id: string,
    after: number,
  ): { snapshot?: HostSession; events?: unknown[]; revision: number } {
    const snapshot = this.session(id);
    const rows = this.db
      .prepare(
        "SELECT revision, payload FROM events WHERE session_id=? AND revision>? ORDER BY revision",
      )
      .all(id, after);
    if (
      after > snapshot.revision ||
      (after < snapshot.revision && Number(rows[0]?.revision) !== after + 1)
    ) {
      return { snapshot, revision: snapshot.revision };
    }
    return {
      events: rows.map((row) => ({
        revision: row.revision,
        event: JSON.parse(String(row.payload)),
      })),
      revision: snapshot.revision,
    };
  }

  /** Runs a keyed mutation once (spec 06 §6.8, 09 §9.7). The same key with
   * the same method and params returns the stored result for 24 h; anything
   * else under that key is a conflict. Failures are not stored. */
  async withMutationReceipt<T>(
    key: string,
    deviceId: string,
    method: string,
    params: unknown,
    run: () => T | Promise<T>,
  ): Promise<T> {
    if (typeof key !== "string" || !key || key.length > 128 || key.includes("\0"))
      throw new HostError("invalid_params", "Invalid idempotency key");
    const hash = createHash("sha256").update(canonicalJson(params ?? {})).digest("hex");
    const conflict = () =>
      new HostError(
        "idempotency_conflict",
        "Idempotency key was already used with a different request",
      );
    const row = this.db
      .prepare(
        "SELECT device_id, method, params_hash, result FROM mutation_receipts WHERE key=? AND created_at>=?",
      )
      .get(key, Date.now() - MUTATION_RECEIPT_MS) as
      | { device_id: string; method: string; params_hash: string; result: string }
      | undefined;
    if (row) {
      if (row.device_id !== deviceId || row.method !== method || row.params_hash !== hash)
        throw conflict();
      return JSON.parse(row.result) as T;
    }
    const pending = this.mutations.get(key);
    if (pending) {
      if (pending.deviceId !== deviceId || pending.method !== method || pending.hash !== hash)
        throw conflict();
      return pending.result as Promise<T>;
    }
    const result = Promise.resolve()
      .then(run)
      .then((value) => {
        this.db
          .prepare("INSERT OR REPLACE INTO mutation_receipts VALUES (?, ?, ?, ?, ?, ?)")
          .run(key, deviceId, method, hash, JSON.stringify(value ?? null), Date.now());
        return value;
      })
      .finally(() => this.mutations.delete(key));
    this.mutations.set(key, { deviceId, method, hash, result });
    return result;
  }

  issueDevice(name: string): { id: string; token: string } {
    return this.devices.issueDesktop(name);
  }

  revokeDevice(id: string): boolean {
    return this.devices.revoke(id);
  }

  /** Lets a desktop revoke only the credential it is using. */
  revokeToken(token: string): boolean {
    return this.devices.revokeToken(token);
  }

  authenticated(token: string): boolean {
    return !!this.devices.byToken(token);
  }

  deviceByToken(token: string): Principal | undefined {
    return this.devices.byToken(token);
  }

  close(): void {
    this.db.close();
  }
}

export function phoneSummary(value: HostSession): PhoneSummary {
  const attention = sessionAttention(value);
  const lastText = lastAssistantText(value.session.blocks);
  // Snapshots written before `finishedAt` existed fall back to the last
  // turn's recorded duration.
  const turn = [...value.session.blocks].reverse().find((block) => block.role === "user" && !block.draft);
  const finishedAt =
    value.status === "running"
      ? undefined
      : (value.finishedAt ??
        (turn?.startedAt && turn.durationMs !== undefined
          ? turn.startedAt + turn.durationMs
          : undefined));
  const approval = pendingApproval(value);
  const question = pendingQuestionSummary(value);
  const queueLength = value.session.queuedMessages?.length;
  return {
    attention,
    ...(approval ? { approval } : {}),
    ...(question ? { question } : {}),
    ...(lastText ? { lastText } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(queueLength ? { queueLength } : {}),
    ...(value.session.branch ? { branch: value.session.branch } : {}),
  };
}

/** The Agents row's inputs, except the live text preview: phones refetch the
 * list when this changes, not on every streamed token. */
function inboxKey(value: HostSession, phone = phoneSummary(value)): string {
  return JSON.stringify([
    value.status,
    value.session.title,
    value.archived,
    value.pinned,
    value.session.model,
    value.session.runtimeMode,
    phone.attention,
    phone.approval?.requestId,
    phone.question?.requestId,
    phone.finishedAt,
    phone.queueLength,
    phone.branch,
  ]);
}

export function summary(value: HostSession): HostSessionSummary {
  return {
    projectId: value.projectId,
    revision: value.revision,
    runId: value.runId,
    status: value.status,
    updatedAt: value.updatedAt,
    id: value.session.id,
    cwd: value.session.cwd,
    title: value.session.title,
    harness: value.session.harness as RemoteProvider,
    model: value.session.model,
    runtimeMode: value.session.runtimeMode,
    providerSessionId: value.session.providerSessionId ?? null,
    createdAt: value.createdAt ?? value.updatedAt,
    archived: value.archived,
    pinned: value.pinned,
    linkedWorkItem: value.session.linkedWorkItem,
    needsInput: sessionNeedsInput(value.session),
    draft: value.session.blocks.some((block) => block.role === "user" && block.draft),
  };
}

/** Unchanged blocks keep their previous stamp. Identity is the fast path;
 * values re-read from disk fall back to a structural comparison. */
export function blockRevisions(
  previous: HostSession | undefined,
  next: HostSession,
): Record<string, number> {
  const before = new Map(
    previous?.session.blocks.map((block) => [block.id, block]),
  );
  const revisions: Record<string, number> = {};
  for (const block of next.session.blocks) {
    const old = before.get(block.id);
    const stamp = previous?.blockRevisions?.[block.id];
    revisions[block.id] =
      old &&
      stamp !== undefined &&
      (old === block || JSON.stringify(old) === JSON.stringify(block))
        ? stamp
        : next.revision;
  }
  return revisions;
}
