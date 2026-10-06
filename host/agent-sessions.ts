import { createReadStream, statSync } from "node:fs";
import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  AgentSessionListing,
  AgentSessionSummary,
} from "../src/platform/tauri/agentSessions";

// Claude Code terminal sessions on this host, for import as host sessions.
// A port of the desktop's `src-tauri/src/agent_sessions` (Claude only): keep
// the record filtering and prompt rules in step with `claude.rs`.

const MAX_SESSION_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOOL_RESULT_CHARS = 16 * 1024;
const MAX_TOOL_INPUT_CHARS = 16 * 1024;
const MAX_PROMPT_PREVIEW_CHARS = 200;
const SUMMARY_HEAD_BYTES = 64 * 1024;
const SUMMARY_TAIL_BYTES = 256 * 1024;
const MAX_SUMMARY_TAIL_BYTES = 4 * 1024 * 1024;
const DEFAULT_LIST_LIMIT = 15;
const MAX_LIST_LIMIT = 200;
/** Searching looks through this many of the newest transcripts. */
const MAX_SUMMARIZED = 500;
const MIN_ID_QUERY_LEN = 6;
/** Claude caps the encoded project directory name and appends a hash. */
const MAX_ENCODED_DIR_LEN = 200;
const READ_CHUNK_BYTES = 64 * 1024;

/** Record keys the importer reads; `toolUseResult` duplicates tool output. */
const KEPT_KEYS = new Set([
  "type",
  "subtype",
  "uuid",
  "parentUuid",
  "logicalParentUuid",
  "isSidechain",
  "isMeta",
  "isCompactSummary",
  "timestamp",
  "cwd",
  "gitBranch",
  "message",
  "content",
  "aiTitle",
  "customTitle",
  "summary",
]);

/** All that is kept of a record the transcript doesn't show. */
const LINK_KEYS = new Set([
  "type",
  "uuid",
  "parentUuid",
  "logicalParentUuid",
  "isSidechain",
]);

type JsonRecord = Record<string, unknown>;

/** A host session already holding a Claude conversation. */
export type KnownAgentSession = { sessionId: string; projectId: string };

export type HostAgentSessionQuery = {
  /** The project's folder and its worktrees' folders. */
  scope: readonly string[];
  /** Claude conversations host sessions hold, keyed by Claude's session id. */
  known: ReadonlyMap<string, KnownAgentSession>;
  projectId: string;
  query?: string;
  limit?: number;
  since?: number;
  includeImported?: boolean;
};

/** `$CLAUDE_CONFIG_DIR/projects`, or `~/.claude/projects`. */
export function claudeProjectsRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  return join(base, "projects");
}

/** Claude names a project directory by replacing every non-alphanumeric
 * character of its cwd with `-`. */
export function encodeProjectDir(cwd: string): string {
  return trimSeparators(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

function trimSeparators(path: string): string {
  return path.replace(/[/\\]+$/, "");
}

export function sameCwd(left: string, right: string): boolean {
  return trimSeparators(left) === trimSeparators(right);
}

export function validSessionId(id: unknown): id is string {
  return (
    typeof id === "string" && id.length <= 128 && /^[A-Za-z0-9_-]+$/.test(id)
  );
}

async function subdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** Directories that can hold sessions for `cwd`. Encoding is lossy and long
 * names are truncated, so more than one can match; records carry the cwd. */
function dirsFor(names: readonly string[], cwd: string): string[] {
  const encoded = encodeProjectDir(cwd);
  if (encoded.length <= MAX_ENCODED_DIR_LEN)
    return names.filter((name) => name === encoded);
  const prefix = encoded.slice(0, MAX_ENCODED_DIR_LEN);
  return names.filter((name) => name.startsWith(prefix));
}

type Candidate = {
  path: string;
  id: string;
  updatedAt: number;
  sizeBytes: number;
};

async function candidates(
  root: string,
  scope: readonly string[],
): Promise<Candidate[]> {
  const names = await subdirs(root);
  const dirs = new Set(scope.flatMap((cwd) => dirsFor(names, cwd)));
  const found: Candidate[] = [];
  for (const dir of dirs) {
    const entries = await readdir(join(root, dir)).catch(() => []);
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      if (!validSessionId(id)) continue;
      const path = join(root, dir, name);
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile()) continue;
      found.push({
        path,
        id,
        updatedAt: Math.floor(info.mtimeMs),
        sizeBytes: info.size,
      });
    }
  }
  return found.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** What a transcript says about itself. */
type TranscriptInfo = {
  cwd: string;
  title?: string;
  firstPrompt: string;
  lastPrompt: string;
  gitBranch?: string;
};

// Listings repeat on every poll; a transcript is only re-read once it changes.
const infoCache = new Map<
  string,
  { updatedAt: number; sizeBytes: number; info: TranscriptInfo | null }
>();

async function cachedInfo(
  candidate: Candidate,
): Promise<TranscriptInfo | null> {
  const cached = infoCache.get(candidate.path);
  if (
    cached &&
    cached.updatedAt === candidate.updatedAt &&
    cached.sizeBytes === candidate.sizeBytes
  )
    return cached.info;
  const info = await transcriptInfo(candidate).catch(() => null);
  infoCache.set(candidate.path, {
    updatedAt: candidate.updatedAt,
    sizeBytes: candidate.sizeBytes,
    info,
  });
  return info;
}

class ClaudeScan {
  cwd?: string;
  gitBranch?: string;
  aiTitle?: string;
  customTitle?: string;
  /** Older Claude Code versions title a session with a `summary` record. */
  summaryTitle?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  tailPrompt = false;

  visit(line: string, inTail: boolean): void {
    if (
      line.includes('"type":"ai-title"') ||
      line.includes('"type":"custom-title"')
    ) {
      const record = parseRecord(line);
      if (!record) return;
      this.aiTitle = nonEmpty(record.aiTitle) ?? this.aiTitle;
      this.customTitle = nonEmpty(record.customTitle) ?? this.customTitle;
      return;
    }
    if (line.includes('"type":"summary"')) {
      const record = parseRecord(line);
      if (record?.type === "summary")
        this.summaryTitle = nonEmpty(record.summary) ?? this.summaryTitle;
      return;
    }
    if (!line.includes('"type":"user"') || line.includes('"tool_result"'))
      return;
    const record = parseRecord(line);
    if (record?.type !== "user") return;
    this.cwd ??= nonEmpty(record.cwd);
    this.gitBranch = nonEmpty(record.gitBranch) ?? this.gitBranch;
    const prompt = userPromptText(record);
    if (prompt === undefined) return;
    const preview = promptPreview(prompt);
    this.firstPrompt ??= preview;
    this.lastPrompt = preview;
    this.tailPrompt = inTail;
  }
}

/** Sessions without a real prompt (a cancelled `/resume`, say) give null:
 * there is nothing to continue. */
async function transcriptInfo(
  candidate: Candidate,
): Promise<TranscriptInfo | null> {
  let tailBytes = SUMMARY_TAIL_BYTES;
  for (;;) {
    const scan = new ClaudeScan();
    await visitSummaryLines(
      candidate.path,
      candidate.sizeBytes,
      tailBytes,
      (line, inTail) => scan.visit(line, inTail),
    );
    // A long run of tool output can push the last prompt out of the tail.
    if (
      scan.tailPrompt ||
      tailBytes >= MAX_SUMMARY_TAIL_BYTES ||
      candidate.sizeBytes <= SUMMARY_HEAD_BYTES + tailBytes
    ) {
      if (!scan.cwd || !scan.firstPrompt || !scan.lastPrompt) return null;
      const title = scan.customTitle ?? scan.aiTitle ?? scan.summaryTitle;
      return {
        cwd: scan.cwd,
        ...(title ? { title } : {}),
        firstPrompt: scan.firstPrompt,
        lastPrompt: scan.lastPrompt,
        ...(scan.gitBranch ? { gitBranch: scan.gitBranch } : {}),
      };
    }
    tailBytes *= 4;
  }
}

/** Lines from `start`, each with the offset just past it. */
async function* linesFrom(
  handle: FileHandle,
  start: number,
): AsyncGenerator<{ line: string; end: number }> {
  const buffer = Buffer.alloc(READ_CHUNK_BYTES);
  let pending: Buffer[] = [];
  let position = start;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    let from = 0;
    for (;;) {
      const newline = buffer.indexOf(10, from);
      if (newline < 0 || newline >= bytesRead) break;
      pending.push(buffer.subarray(from, newline + 1));
      yield {
        line: Buffer.concat(pending).toString("utf8"),
        end: position + newline + 1,
      };
      pending = [];
      from = newline + 1;
    }
    if (from < bytesRead) pending.push(Buffer.from(buffer.subarray(from, bytesRead)));
    position += bytesRead;
  }
  if (pending.length)
    yield { line: Buffer.concat(pending).toString("utf8"), end: position };
}

/** Feeds `visit` the first `SUMMARY_HEAD_BYTES` and the last `tailBytes` of
 * a transcript, line by line, flagging tail lines. Small transcripts are
 * read whole and count as tail. */
async function visitSummaryLines(
  path: string,
  size: number,
  tailBytes: number,
  visit: (line: string, inTail: boolean) => void,
): Promise<void> {
  const handle = await open(path, "r");
  try {
    const whole = size <= SUMMARY_HEAD_BYTES + tailBytes;
    let offset = 0;
    for await (const { line, end } of linesFrom(handle, 0)) {
      visit(line, whole);
      offset = end;
      if (!whole && offset >= SUMMARY_HEAD_BYTES) break;
    }
    if (whole) return;
    const tailStart = size - tailBytes;
    // The seek lands mid-line; that fragment is not a record.
    let skip = tailStart > offset;
    for await (const { line } of linesFrom(handle, Math.max(tailStart, offset))) {
      if (skip) {
        skip = false;
        continue;
      }
      visit(line, true);
    }
  } finally {
    await handle.close();
  }
}

function parseRecord(line: string): JsonRecord | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Text between `<tag>` and `</tag>`. */
function tagText(text: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const start = text.indexOf(open);
  if (start < 0) return undefined;
  const end = text.indexOf(`</${tag}>`, start + open.length);
  return end < 0 ? undefined : text.slice(start + open.length, end).trim();
}

/** Text the user actually typed, with slash commands shown as `/name args`.
 * Keep in step with `classifyClaudeUserRecord`. */
function userPromptText(record: JsonRecord): string | undefined {
  if (
    record.isSidechain === true ||
    record.isMeta === true ||
    record.isCompactSummary === true
  )
    return undefined;
  const message = record.message as JsonRecord | undefined;
  const content = message?.content;
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content))
    text = content
      .filter(
        (block): block is JsonRecord =>
          !!block && typeof block === "object" && (block as JsonRecord).type === "text",
      )
      .map((block) => block.text)
      .filter((value): value is string => typeof value === "string")
      .join("\n");
  else return undefined;
  const trimmed = text.trim();
  if (
    !trimmed ||
    trimmed.startsWith("[Request interrupted") ||
    trimmed.startsWith("<local-command-") ||
    trimmed.startsWith("<task-notification>") ||
    trimmed.startsWith("<system-reminder>")
  )
    return undefined;
  if (trimmed.startsWith("<command-")) {
    const name = tagText(trimmed, "command-name");
    if (name === undefined) return undefined;
    const args = tagText(trimmed, "command-args") ?? "";
    return `${name} ${args}`.trimEnd();
  }
  return text;
}

function promptPreview(prompt: string): string {
  return truncateChars(
    prompt.split(/\s+/).filter(Boolean).join(" "),
    MAX_PROMPT_PREVIEW_CHARS,
  );
}

function truncateChars(value: string, max: number): string {
  let count = 0;
  for (let index = 0; index < value.length; ) {
    if (count === max) return `${value.slice(0, index)}…`;
    index += (value.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
    count++;
  }
  return value;
}

/** Cap every string inside `value`, keeping its shape. */
function truncateStrings(value: unknown, max: number): unknown {
  if (typeof value === "string")
    return value.length > max ? truncateChars(value, max) : value;
  if (Array.isArray(value)) return value.map((item) => truncateStrings(item, max));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, truncateStrings(item, max)]),
    );
  return value;
}

function isId(query: string): boolean {
  return query.length >= MIN_ID_QUERY_LEN && /^[0-9a-f-]+$/.test(query);
}

function matchesQuery(summary: AgentSessionSummary, query: string): boolean {
  const folder = trimSeparators(summary.cwd).split(/[/\\]/).pop() ?? "";
  return (
    [summary.title ?? "", summary.firstPrompt, summary.lastPrompt, folder].some(
      (text) => text.toLowerCase().includes(query),
    ) ||
    (isId(query) && summary.id.toLowerCase().includes(query))
  );
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Newest first. Conversations host sessions already hold are skipped before
 * their transcript is opened, and counted instead. */
export async function listClaudeSessions(
  root: string,
  request: HostAgentSessionQuery,
): Promise<AgentSessionListing> {
  const limit = Math.min(
    MAX_LIST_LIMIT,
    Math.max(1, Math.floor(request.limit ?? DEFAULT_LIST_LIMIT)),
  );
  const query = request.query?.trim().toLowerCase() || undefined;
  const idQuery = query && isId(query) ? query : undefined;
  const [main] = request.scope;
  const listing: AgentSessionListing = {
    sessions: [],
    importedCount: 0,
    hasMore: false,
  };
  let summarized = 0;
  let full = false;
  for (const candidate of await candidates(root, request.scope)) {
    if (request.since !== undefined && candidate.updatedAt < request.since)
      break;
    const bound = request.known.get(candidate.id);
    const boundHere = bound?.projectId === request.projectId;
    if (bound && !(request.includeImported && boundHere)) {
      if (boundHere) listing.importedCount++;
      continue;
    }
    if (full) continue;
    if (
      summarized >= MAX_SUMMARIZED &&
      !(idQuery && candidate.id.toLowerCase().includes(idQuery))
    )
      continue;
    summarized++;
    const info = await cachedInfo(candidate);
    if (!info || !request.scope.some((cwd) => sameCwd(cwd, info.cwd))) continue;
    // A worktree removed since: its conversation cannot resume.
    if (!isDirectory(info.cwd)) continue;
    const summary: AgentSessionSummary = {
      harness: "claude",
      id: candidate.id,
      cwd: info.cwd,
      title: info.title ?? null,
      firstPrompt: info.firstPrompt,
      lastPrompt: info.lastPrompt,
      gitBranch: info.gitBranch ?? null,
      updatedAt: candidate.updatedAt,
      sizeBytes: candidate.sizeBytes,
      folder: "ok",
      project: main && !sameCwd(main, info.cwd) ? main : null,
      monocodeSessionId: bound?.sessionId ?? null,
    };
    if (query && !matchesQuery(summary, query)) continue;
    if (listing.sessions.length === limit) {
      listing.hasMore = true;
      full = true;
      continue;
    }
    listing.sessions.push(summary);
  }
  return listing;
}

/** The transcript of `sessionId`, which ran in `cwd`. */
async function findTranscript(
  root: string,
  cwd: string,
  sessionId: string,
): Promise<string | undefined> {
  for (const dir of dirsFor(await subdirs(root), cwd)) {
    const path = join(root, dir, `${sessionId}.jsonl`);
    if ((await stat(path).catch(() => undefined))?.isFile()) return path;
  }
  return undefined;
}

/** Transcript records with heavy payloads (images, raw tool output) removed. */
export async function readClaudeSession(
  root: string,
  cwd: string,
  sessionId: string,
): Promise<JsonRecord[]> {
  if (!validSessionId(sessionId)) throw new Error("Invalid session id");
  const path = await findTranscript(root, cwd, sessionId);
  if (!path) throw new Error("That Claude Code session no longer exists");
  if ((await stat(path)).size > MAX_SESSION_FILE_BYTES)
    throw new Error("This Claude Code session is too large to import");
  const records: JsonRecord[] = [];
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    // A session being written right now can end in a partial line.
    if (!line.trim()) continue;
    const record = parseRecord(line);
    const slim = record && slimRecord(record);
    if (slim) records.push(slim);
  }
  return records;
}

export function slimRecord(record: JsonRecord): JsonRecord | undefined {
  const kind = record.type;
  if (typeof kind !== "string") return undefined;
  const keep =
    kind === "user" ||
    kind === "assistant" ||
    kind === "ai-title" ||
    kind === "custom-title" ||
    kind === "summary" ||
    (kind === "system" && record.subtype === "compact_boundary");
  if (!keep) {
    // Attachments and hook summaries sit between turns in the `parentUuid`
    // chain; keep their links or the conversation can't be walked back.
    if (record.uuid === undefined) return undefined;
    return pick(record, LINK_KEYS);
  }
  const slim = pick(record, KEPT_KEYS);
  const message = slim.message;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const kept = pick(
      message as JsonRecord,
      new Set(["role", "content", "model", "usage", "id"]),
    );
    if (Array.isArray(kept.content))
      kept.content = kept.content.map(slimContentBlock);
    slim.message = kept;
  }
  return slim;
}

function pick(record: JsonRecord, keys: ReadonlySet<string>): JsonRecord {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => keys.has(key)),
  );
}

function slimContentBlock(block: unknown): unknown {
  if (!block || typeof block !== "object" || Array.isArray(block)) return block;
  const object = block as JsonRecord;
  if (object.type === "image") {
    // Inline image payloads are megabytes of base64 the transcript cannot show.
    const { source: _source, ...rest } = object;
    return rest;
  }
  if (object.type === "tool_result")
    return {
      ...object,
      content: truncateChars(toolResultText(object.content), MAX_TOOL_RESULT_CHARS),
    };
  if (object.type === "tool_use" && "input" in object)
    return { ...object, input: truncateStrings(object.input, MAX_TOOL_INPUT_CHARS) };
  return object;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "string"
        ? part
        : part &&
            typeof part === "object" &&
            (part as JsonRecord).type === "text" &&
            typeof (part as JsonRecord).text === "string"
          ? ((part as JsonRecord).text as string)
          : "",
    )
    .join("");
}
