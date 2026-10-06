#!/usr/bin/env node
// TypeScript implementations → JSON fixtures for the Swift packages (16 §16.5).
// It runs the Expo app's code (apps/mobile, frozen at b286412), the shared
// core (@monocode/core) and the desktop model code it re-exports, and writes:
//
// MonoTranscript (package resources, read by the Lab and the tests):
//   rows-120.json    buildRows(fixtureSession(120)), settled
//   rows-1000.json   buildRows(fixtureSession(1000)), settled
//   theme-dark.json  transcriptTheme(palette({ scheme: "dark" }))
//   theme-light.json transcriptTheme(palette({ scheme: "light" }))
//   stream.json      a live turn streamed on top of rows-1000 at 90 chars/s
//                    with 5 tool events/s: one batch of ops per 60 Hz frame
//
// MonoDemo (package resource): demo-state.json, the demo host's initial state
//   from demoHost.ts (projects, worktrees, every HostSession, the model
//   catalog) and seeded replies for the turns the Swift demo streams.
//
// Test resources (golden fixtures):
//   MonoWire  wire-samples.json   inbox.list, sessions.page, projects.list,
//                                 models.list results to decode and re-encode
//             sync-cases.json     applySessionSync before / sync / after cases
//   MonoTranscript builder.json  buildRows over edge cases, demo sessions and
//                                markdown, with folds, older pages and builds
//             diff.json          diffRows over a streamed, folded and paged session
//             grouping.json       groupTurns, groupTurnItems, foldableWork,
//                                 workSummaryLine and the per-block tool
//                                 helpers over demo sessions and edge cases
//   MonoDemo  demo-responses.json the TypeScript demo's answers to the read
//                                 methods on its initial state; sessions.sync
//                                 follows the host algorithm of 06 §6.7
//
// The output is deterministic (fixed clock, UTC), so CI can regenerate it and
// fail on a diff. `--check` does that comparison instead of writing.

process.env.TZ = "UTC";

import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const mobile = join(repo, "apps/mobile");
const packages = join(here, "../Packages");
const transcriptDir = join(packages, "MonoTranscript/Sources/MonoTranscript/Resources/Fixtures");
const demoDir = join(packages, "MonoDemo/Sources/MonoDemo/Resources");
const wireTests = join(packages, "MonoWire/Tests/MonoWireTests/Fixtures");
const transcriptTests = join(packages, "MonoTranscript/Tests/MonoTranscriptTests/Fixtures");
const demoTests = join(packages, "MonoDemo/Tests/MonoDemoTests/Fixtures");

/** The fixtures' clock: 2026-10-01 09:00 UTC. */
const NOW = Date.UTC(2026, 9, 1, 9, 0, 0);
const FRAME_MS = 1000 / 60;
const STREAM_CHARS_PER_SECOND = 90;
const TOOL_EVENTS_PER_SECOND = 5;
/** Enough for the Lab's run (stream from 2 s, fling 3.5 s to 13.5 s) with room to spare. */
const STREAM_SECONDS = 30;
const CWD = "/Users/demo/code/my-app";

// theme.ts imports react and react-native for its hook; transcriptTheme() is
// pure. The desktop session model reaches @tauri-apps through terminalTab.ts,
// and the demo host reaches Expo modules through hosts/connect.ts. CommonJS
// stubs, so any named import resolves (to undefined); none is called.
const stubs = {
  react: "module.exports = { useMemo: (f) => f() };",
  "react-native": "module.exports = { useColorScheme: () => 'dark', Platform: { OS: 'ios' } };",
  tauri: "module.exports = {};",
  expo: "module.exports = {};",
};

const stubPlugin = {
  name: "stubs",
  setup(b) {
    b.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "stub" }));
    b.onResolve({ filter: /^react-native$/ }, () => ({ path: "react-native", namespace: "stub" }));
    b.onResolve({ filter: /^@tauri-apps\// }, () => ({ path: "tauri", namespace: "stub" }));
    b.onResolve({ filter: /^expo-/ }, () => ({ path: "expo", namespace: "stub" }));
    b.onResolve({ filter: /^@\// }, (args) => ({ path: join(mobile, "src", args.path.slice(2)) + ".ts" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
    // The demo host keeps its instance private; expose it to this script
    // without editing the frozen app.
    b.onLoad({ filter: /src\/demo\/demoHost\.ts$/ }, async (args) => ({
      contents: (await readFile(args.path, "utf8")) + "\nexport { demo as __demo };\n",
      loader: "ts",
    }));
  },
};

async function loadExpoCode() {
  const entry = `
    export { fixtureSession, streamScript, answer } from "./src/transcript/fixtures.ts";
    export { buildRows } from "./src/transcript/rows.ts";
    export { transcriptTheme } from "./src/ui/theme.ts";
    export { diffRows } from "./modules/transcript/src/diff.ts";
    export { palette } from "@monocode/design";
    export { __demo, DEMO_ENV } from "./src/demo/demoHost.ts";
    export { applySessionSync } from "@monocode/core/session";
    export { windowStart, windowMeta, truncateBlock } from "@monocode/core/window";
    export * as transcript from "@monocode/core/transcript";
  `;
  const result = await build({
    stdin: { contents: entry, resolveDir: mobile, loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "error",
    plugins: [stubPlugin],
  });
  const file = join(tmpdir(), `monocode-fixtures-${process.pid}.mjs`);
  await writeFile(file, result.outputFiles[0].text);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    await rm(file);
  }
}

Date.now = () => NOW;
const code = await loadExpoCode();
const { fixtureSession, streamScript, answer, buildRows, transcriptTheme, diffRows, palette, __demo: demo, DEMO_ENV } = code;
const { applySessionSync, windowStart, windowMeta, truncateBlock, transcript } = code;

const clone = (value) => JSON.parse(JSON.stringify(value));

// ── MonoTranscript ──────────────────────────────────────────────────────────

const settled = (turns) => buildRows(fixtureSession(turns), { live: false, open: new Set() });

/** Replays the Expo Lab's stream loop on a simulated 60 Hz clock and records
 * the ops each frame would send. */
function recordStream(base) {
  const script = streamScript();
  const open = new Set();
  const turn = base.length;
  let blocks = [
    ...base,
    { id: `live-u${turn}`, role: "user", text: "Stream a long answer with tool calls", startedAt: NOW },
    { id: `live-a${turn}`, role: "assistant", text: "", streaming: true },
  ];
  let rows = buildRows(base, { live: false, open });
  const baseIds = new Set(rows.map((row) => row.id));
  const frames = [];
  let offset = 0;
  for (let tick = 1; tick * FRAME_MS <= STREAM_SECONDS * 1000 && offset < script.text.length; tick++) {
    const t = tick * FRAME_MS;
    const target = Math.floor((t / 1000) * STREAM_CHARS_PER_SECOND);
    let next = blocks;
    if (target > offset) {
      offset = Math.min(script.text.length, target);
      const last = next[next.length - 1];
      next = [...next.slice(0, -1), { ...last, text: script.text.slice(0, offset) }];
    }
    // Tool events land in the trail just above the streaming answer.
    if (tick % Math.round(60 / TOOL_EVENTS_PER_SECOND) === 0) {
      const file = script.files[tick % script.files.length];
      const tool = { id: `live-t${tick}`, role: "tool", text: `Read ${file}`, tool: { kind: "read", status: "completed", preview: { kind: "read", path: file } } };
      next = [...next.slice(0, -1), tool, next[next.length - 1]];
    }
    if (next === blocks) continue;
    blocks = next;
    const after = buildRows(blocks, { live: true, open });
    const ops = diffRows(rows, after);
    rows = after;
    if (ops.length) frames.push({ t: Math.round(t * 10) / 10, chars: offset, ops });
  }
  // The recording is bound to its base: say which base rows it touches.
  const touched = new Set();
  for (const { ops } of frames)
    for (const op of ops) {
      if (op.op === "insert" && op.after && baseIds.has(op.after)) touched.add(op.after);
      if (op.op === "update") op.rows.filter((row) => baseIds.has(row.id)).forEach((row) => touched.add(row.id));
      if (op.op === "remove") op.ids.filter((id) => baseIds.has(id)).forEach((id) => touched.add(id));
      if (op.op === "reset") throw new Error("the stream recording reset the transcript");
    }
  return {
    base: "rows-1000",
    baseRowsTouched: [...touched],
    charsPerSecond: STREAM_CHARS_PER_SECOND,
    toolEventsPerSecond: TOOL_EVENTS_PER_SECOND,
    frameMs: Math.round(FRAME_MS * 1000) / 1000,
    seconds: STREAM_SECONDS,
    frames,
    /** The rows after the last frame that are not in the base, for streaming-equals-final checks. */
    finalRows: rows.filter((row) => !baseIds.has(row.id)),
  };
}

// ── The demo host ───────────────────────────────────────────────────────────

/** fixtures.ts's generator, so the replies are seeded like the fixtures. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const sessions = [...demo.sessions.values()].map((entry) => clone(entry.value));
const replyRandom = seeded(2026);
const demoState = {
  fixtureNow: NOW,
  env: DEMO_ENV,
  boot: "demo-boot",
  projects: clone(demo.projects),
  worktrees: Object.fromEntries([...demo.worktrees.entries()].map(([id, trees]) => [id, clone(trees)])),
  sessions,
  models: await demo.handle("models.list", {}),
  /** Answers the Swift demo streams, one per simulated turn. */
  replies: Array.from({ length: 6 }, (_, i) => answer(replyRandom, i % 2 === 0)),
};

/** `sessions.sync` as the host computes it (06 §6.7). The TypeScript demo
 * only pushes syncs from `watch.set`; this is the same windowing. */
function sessionsSync(params) {
  const value = sessions.find((item) => item.session.id === params.sessionId);
  const { start, reset } = windowStart(value.session.blocks, params.window ?? {});
  const meta = windowMeta(value.session.blocks, start);
  if (params.revision === value.revision && !reset) return { kind: "unchanged", revision: value.revision, window: meta };
  const blocks = value.session.blocks.slice(start).map((block) => truncateBlock(block, params.maxBlockChars ?? 0));
  return { kind: "snapshot", value: { ...value, session: { ...value.session, blocks } }, window: meta };
}

async function demoResponses() {
  const calls = [];
  const call = async (method, params) => {
    const result = method === "sessions.sync" ? sessionsSync(params) : await demo.handle(method, params);
    calls.push({ method, params, result: clone(result) });
    return result;
  };
  await call("inbox.list", {});
  await call("projects.list", {});
  await call("models.list", {});
  for (const projectId of ["p-app", "p-api"])
    for (const archived of ["exclude", "only"]) {
      let cursor;
      do {
        const page = await call("sessions.page", { projectId, archived, limit: 50, ...(cursor ? { cursor } : {}) });
        cursor = page.cursor;
      } while (cursor);
    }
  await call("sessions.page", { projectId: "p-app", archived: "include", limit: 7 });
  for (const sessionId of ["s-auth", "s-perf", "s-api", "s-old-0"]) {
    const window = { tailTurns: 20 };
    const snapshot = await call("sessions.sync", { sessionId, window, maxBlockChars: 20_000 });
    await call("sessions.sync", { sessionId, revision: snapshot.value.revision, window, maxBlockChars: 20_000 });
    // Older pages, from the window's anchor back to the first turn.
    let before = snapshot.window.anchor;
    while (before) {
      const older = await call("sessions.blocks", { sessionId, before, turns: 20, maxBlockChars: 20_000 });
      before = older.hasOlder ? older.blocks[0]?.id : undefined;
    }
  }
  await call("sessions.sync", { sessionId: "s-perf", window: { tailTurns: 5 }, maxBlockChars: 300 });
  await call("sessions.sync", { sessionId: "s-perf", window: { anchor: "u30" }, maxBlockChars: 20_000 });
  await call("sessions.sync", { sessionId: "s-perf", revision: 1, window: { anchor: "gone" }, maxBlockChars: 20_000 });
  return { now: NOW, calls };
}

const responses = await demoResponses();
const firstResult = (method, filter = () => true) => responses.calls.find((c) => c.method === method && filter(c.params)).result;

// ── applySessionSync ────────────────────────────────────────────────────────

/** A delta from `before` to `after`, as the host builds one: the window's ids
 * and every block that changed. */
function delta(before, after) {
  const old = new Map(before.session.blocks.map((block) => [block.id, JSON.stringify(block)]));
  const { blocks, ...session } = after.session;
  return {
    kind: "delta",
    base: before.revision,
    value: { ...after, session },
    blockIds: blocks.map((block) => block.id),
    blocks: blocks.filter((block) => old.get(block.id) !== JSON.stringify(block)),
  };
}

function syncCases() {
  const auth = clone(sessions.find((item) => item.session.id === "s-auth"));
  // Without the 40 KB test log, which only makes the file large.
  const base = { ...auth, session: { ...auth.session, blocks: auth.session.blocks.filter((block) => block.id !== "t-log") } };
  const step = (value, change) => {
    const next = change(clone(value));
    next.revision = value.revision + 1;
    next.updatedAt = value.updatedAt + 1000;
    return next;
  };
  const v1 = step(base, (v) => ({ ...v, status: "running", runId: "run-1", session: { ...v.session, blocks: [...v.session.blocks, { id: "n-u", role: "user", text: "And the refresh test?", startedAt: NOW }] } }));
  const v2 = step(v1, (v) => ({ ...v, session: { ...v.session, blocks: [...v.session.blocks, { id: "n-a", role: "assistant", text: "Looking", streaming: true }] } }));
  const v3 = step(v2, (v) => ({ ...v, session: { ...v.session, blocks: v.session.blocks.map((b) => (b.id === "n-a" ? { ...b, text: "Looking at the refresh path now." } : b)) } }));
  const v4 = step(v3, (v) => {
    const blocks = v.session.blocks;
    return { ...v, session: { ...v.session, title: "Fix flaky auth and refresh tests", blocks: [...blocks.slice(0, -1), { id: "n-t", role: "tool", text: "npm test -- refresh", tool: { kind: "execute", status: "pending", detail: "npm test -- refresh" }, approval: { requestId: 9 } }, blocks[blocks.length - 1]] } };
  });
  // The window moves: the first turn leaves it.
  const v5 = step(v4, (v) => {
    const second = v.session.blocks.findIndex((b, i) => i > 0 && b.role === "user");
    return { ...v, session: { ...v.session, blocks: v.session.blocks.slice(second) } };
  });
  const v6 = step(v5, (v) => ({ ...v, status: "idle", runId: undefined, finishedAt: NOW + 60_000, lastTurnOutcome: "finished", session: { ...v.session, blocks: v.session.blocks.map((b) => (b.streaming ? { ...b, streaming: false } : b.approval ? { ...b, approval: { ...b.approval, decided: "allow" }, tool: { ...b.tool, status: "completed" } } : b)) } }));
  const cases = [];
  const ok = (name, before, sync) => cases.push({ name, before, sync, after: clone(applySessionSync(before, sync)) });
  const fails = (name, before, sync) => {
    try {
      applySessionSync(before, sync);
    } catch (error) {
      cases.push({ name, before, sync, error: error.message });
      return;
    }
    throw new Error(`${name} did not throw`);
  };
  ok("snapshot without a window", undefined, { kind: "snapshot", value: base });
  ok("snapshot replaces", v2, { kind: "snapshot", value: v1 });
  ok("unchanged", v1, { kind: "unchanged", revision: v1.revision });
  ok("append a turn", base, delta(base, v1));
  ok("append a streaming block", v1, delta(v1, v2));
  ok("update a block", v2, delta(v2, v3));
  ok("insert before the tail and rename", v3, delta(v3, v4));
  ok("window moves", v4, delta(v4, v5));
  ok("settle", v5, delta(v5, v6));
  fails("unchanged without a window", undefined, { kind: "unchanged", revision: 1 });
  fails("unchanged at another revision", v1, { kind: "unchanged", revision: v1.revision + 1 });
  fails("delta on another base", v1, delta(v2, v3));
  fails("delta without a window", undefined, delta(v2, v3));
  const missing = delta(v2, v3);
  missing.blockIds = [...missing.blockIds, "nowhere"];
  fails("delta missing a block", v2, missing);
  return { cases };
}

// ── Grouping ────────────────────────────────────────────────────────────────

const tool = (id, text, fields = {}, extra = {}) => ({ id, role: "tool", text, tool: { status: "completed", ...fields }, ...extra });
const user = (id, text, extra = {}) => ({ id, role: "user", text, startedAt: NOW, ...extra });
const say = (id, text, extra = {}) => ({ id, role: "assistant", text, ...extra });
const think = (id, text, extra = {}) => ({ id, role: "reasoning", text, ...extra });
const path = (rel) => `${CWD}/${rel}`;

/** Blocks the demo and fixtures never produce, for the branches they miss. */
const EDGE_CASES = {
  "pending edit approval": [
    user("u1", "Fix the race"),
    think("r1", "The **token write** races.\n\nNext paragraph."),
    tool("t1", "Read src/auth/session.ts", { kind: "read", preview: { kind: "read", path: path("src/auth/session.ts") } }),
    tool("t2", "Edit src/auth/session.ts", { kind: "edit", status: "pending", preview: { kind: "write", path: path("src/auth/session.ts"), additions: 2, deletions: 1, lines: [{ kind: "context", text: "const a = 1;", number: 4 }, { kind: "del", text: "write(token)", number: 5 }, { kind: "add", text: "await lock(() => write(token))", number: 5 }] } }, { approval: { requestId: 3 } }),
  ],
  "pending command approval after prose": [
    user("u1", "Run the tests"),
    tool("t1", "Read package.json", { kind: "read", preview: { kind: "read", path: path("package.json") } }),
    say("a1", "I'll run the auth tests now."),
    tool("t2", "npm test -- auth", { kind: "execute", status: "pending", detail: "npm test -- auth" }, { approval: { requestId: 4 } }),
  ],
  "decided approvals": [
    user("u1", "Try both"),
    tool("t1", "rm -rf build", { kind: "execute", status: "failed" }, { approval: { requestId: 5, decided: "deny" } }),
    tool("t2", "npm run build", { kind: "execute" }, { approval: { requestId: 6, decided: "allow" } }),
    tool("t3", "npm run lint", { kind: "execute", status: "pending" }, { approval: { requestId: 7, decided: "cancelled" } }),
    say("a1", "Built it; the clean was denied."),
  ],
  subagents: [
    user("u1", "Review it"),
    tool("t1", "Task Review the auth module for races. Then report back with details", { kind: "task", status: "in_progress" }, { agentRun: { name: "Review the auth module for races", model: "claude:sonnet-5", steps: [{ id: "s1", kind: "tool", text: "Read src/auth/session.ts", toolKind: "read", status: "completed" }] } }),
    tool("t2", "Agent", { kind: "agent", status: "failed", detail: "The subagent crashed." }, { agentRun: { name: "Check the tests", steps: [] } }),
    tool("t3", "Read src/a.ts", { kind: "read", preview: { kind: "read", path: path("src/a.ts") } }),
    say("a1", "Both reviews are in."),
  ],
  "notices and system rows": [
    user("u1", "Go"),
    tool("t1", "Read README.md", { kind: "read", preview: { kind: "read", path: path("README.md") } }),
    { id: "s1", role: "system", text: "Advisor reviewed this turn" },
    { id: "s2", role: "system", text: "Consider the lock order.", interjection: { customType: "advisor", severity: "concern" } },
    tool("t2", "Read src/b.ts", { kind: "read", preview: { kind: "read", path: path("src/b.ts") } }),
    { id: "s3", role: "system", text: "Provider error: rate limited", notice: "error" },
    { id: "s4", role: "system", text: "Turn interrupted when MonoCode quit." },
    say("a1", "Stopped early."),
  ],
  "hidden and ignored blocks": [
    user("u1", "Plan it"),
    think("r0", "   "),
    tool("t1", "TodoWrite", { kind: "tasks" }),
    tool("t2", "Tool", { kind: "other", status: "pending" }),
    tool("t3", "", { status: "in_progress" }),
    say("a0", "  "),
    { id: "k1", role: "tasks", text: "- [x] one\n- [ ] two", taskList: { items: [{ text: "one", status: "completed" }, { text: "two", status: "pending" }] } },
    { id: "p1", role: "plan", text: "## Plan\n\n1. Lock\n2. Test", plan: { status: "ready" } },
    say("a1", "Here is the plan."),
  ],
  "initial thinking superseded": [
    user("u1", "Hello"),
    think("r1", "Thinking about a greeting."),
    say("a1", "Hello there."),
  ],
  "initial thinking kept before a tool": [
    user("u1", "Look"),
    think("r1", "Which file?"),
    tool("t1", "Read src/a.ts", { kind: "read", preview: { kind: "read", path: path("src/a.ts") } }),
    say("a1", "Found it."),
  ],
  "background work after the answer": [
    user("u1", "Start the server"),
    tool("t1", "npm run dev", { kind: "execute" }),
    say("a1", "The server is starting in the background."),
    tool("t2", "npm run dev", { kind: "execute", status: "running", background: true }),
    say("a2", "It is up on port 3000."),
  ],
  "shell commands": [
    user("u1", "Explore"),
    tool("t1", "cat src/a.ts | head -20", { kind: "execute" }),
    tool("t2", "rg -n refresh src", { kind: "execute" }),
    tool("t3", "find . -name '*.ts' -maxdepth 2", { kind: "execute" }),
    tool("t4", "ls -la src/auth", { kind: "execute" }),
    tool("t5", "sed -n '10,20p' src/b.ts", { kind: "execute" }),
    tool("t6", 'bash -lc "cat package.json"', { kind: "execute" }),
    tool("t7", "echo done > out.txt", { kind: "execute" }),
    tool("t8", "git status && git diff", { kind: "execute" }),
    tool("t9", "/bin/zsh -lc 'grep -rn TODO src'", { kind: "execute" }),
    tool("t10", "sed -i '' 's/a/b/' src/c.ts", { kind: "execute" }),
    tool("t11", "Bash", { kind: "execute", preview: { kind: "shell", title: "npm test", output: "ok" } }),
    tool("t12", "cat <<EOF > notes.md", { kind: "execute" }),
    tool("t13", "Read src/d.ts", { kind: "execute" }),
    tool("t14", "rg --files", { kind: "execute" }),
    tool("t15", "tail -n 50 /var/log/app.log", { kind: "execute" }),
    say("a1", "Explored."),
  ],
  "searches and other tools": [
    user("u1", "Search"),
    tool("t1", "Grep", { kind: "search", preview: { kind: "search", query: "refreshToken" } }),
    tool("t2", "Find *.test.ts", { kind: "search" }),
    tool("t3", "Glob", { kind: "other" }),
    tool("t4", "Fetch https://example.com", { kind: "fetch" }),
    tool("t5", "Skill", { kind: "skill", title: "Skill" }),
    tool("t6", "List src", { kind: "read" }),
    tool("t7", "WebSearch", { kind: "other" }),
    tool("t8", "monocode app sessions.list --json {}", { kind: "execute" }),
    say("a1", "Searched."),
  ],
  "only MonoCode calls": [
    user("u1", "List sessions"),
    tool("t1", "monocode app sessions.list --json '{}'", { kind: "execute" }),
    tool("t2", "monocode app --help", { kind: "execute" }),
    say("a1", "Listed."),
  ],
  "edits and paths": [
    user("u1", "Edit"),
    tool("t1", "Edit dependency versions", { kind: "edit" }),
    tool("t2", "Write", { kind: "edit", preview: { kind: "write", path: "/tmp/elsewhere/notes.md" } }),
    tool("t3", "Edited SKILL.md", { kind: "edit", preview: { kind: "write", path: path("skills/SKILL.md") } }),
    tool("t4", "Created src/new.ts", { kind: "other", preview: { kind: "write", path: path("src/new.ts") } }),
    tool("t5", "Delete old.ts", { kind: "delete", preview: { kind: "write", fileName: "old.ts" } }),
    tool("t6", "Read", { kind: "read", preview: { kind: "read", path: "~/notes/todo.md" } }),
    tool("t7", "Read Makefile", { kind: "read" }),
    tool("t8", "Read C:\\work\\app\\main.ts", { kind: "read" }),
    say("a1", "Edited."),
  ],
  "handoff, internal and draft turns": [
    user("u1", "First"),
    say("a1", "One."),
    { id: "h1", role: "handoff", text: "Handed off to codex", handoff: { from: "claude", to: "codex", status: "ready" } },
    user("u2", "Keep going", { internal: true }),
    say("a2", "Two."),
    user("u3", "Later", { draft: true }),
  ],
  "live turn": [
    user("u1", "Stream"),
    think("r1", "Planning the answer.", { streaming: true }),
    tool("t1", "Read src/a.ts", { kind: "read", preview: { kind: "read", path: path("src/a.ts") } }),
    tool("t2", "npm test", { kind: "execute", status: "running" }),
    say("a1", "Half an answer", { streaming: true }),
  ],
};

const T = transcript;

function blockFacts(block, cwd) {
  const label = T.toolCallLabel(block, cwd);
  return {
    label,
    state: T.toolCallState(block),
    display: T.resolveToolCallDisplay(label, block.tool?.preview, cwd),
    needsApproval: T.needsApproval(block),
    notice: T.isNoticeBlock(block),
    thinking: T.isThinkingBlock(block),
    subagent: T.isSubagentBlock(block),
    ...(T.isSubagentBlock(block) ? { subagentName: T.subagentName(block) } : {}),
    proseSummary: T.proseSummary(block.text),
  };
}

const itemShape = (item) => ({ type: item.type, ids: item.type === "block" ? [item.block.id] : item.blocks.map((block) => block.id) });

function groupingCase(name, blocks, cwd) {
  const turns = T.groupTurns(blocks);
  const turnFacts = turns.map((turn) => {
    const rest = turn[0]?.role === "user" ? turn.slice(1) : turn;
    const facts = {};
    for (const settledTurn of [true, false]) {
      const items = T.groupTurnItems(rest, { settled: settledTurn });
      const fold = T.foldableWork(items);
      facts[settledTurn ? "settled" : "live"] = {
        items: items.map(itemShape),
        fold: fold ?? null,
        foldSummary: fold ? T.workSummaryLine(T.foldedBlocks(items, fold)) : null,
        firstFoldable: T.firstFoldableIndex(items),
        initialThinking: T.initialThinkingIndex(items),
        summaries: items.map((item) => (item.type === "activity" ? { settled: T.workSummaryLine(item.blocks), live: T.workSummaryLine(item.blocks, true) } : null)),
      };
    }
    return { ids: turn.map((block) => block.id), copyText: T.turnCopyText(turn), ...facts };
  });
  return {
    name,
    cwd,
    blocks,
    managedTurns: T.groupTurns(blocks, true).map((turn) => turn.map((block) => block.id)),
    turns: turnFacts,
    blockFacts: Object.fromEntries(blocks.map((block) => [block.id, blockFacts(block, cwd)])),
  };
}

function grouping() {
  const cases = Object.entries(EDGE_CASES).map(([name, blocks]) => groupingCase(name, blocks, CWD));
  for (const id of ["s-auth", "s-perf", "s-api"]) {
    const value = sessions.find((item) => item.session.id === id);
    cases.push(groupingCase(`demo ${id}`, value.session.blocks, value.session.cwd));
  }
  cases.push(groupingCase("fixture 60", fixtureSession(60, 9), undefined));
  return { cases };
}

// ── Row builder and diff ────────────────────────────────────────────────────

/** Markdown the fixtures never write: every block kind and inline rule. */
const MARKDOWN = [
  "# Heading one",
  "## Heading *two* with `code`",
  "### Three",
  "#### Four ####",
  "",
  "A paragraph with **strong**, *em*, _under_, snake_case_name, `inline code`, `src/auth/session.ts:42`, `Makefile`,",
  "`not a file.`, ``double `ticks` code``, a [safe link](https://example.com \"title\"), an [unsafe one](javascript:alert(1)),",
  "a [relative](./docs/README.md), ![alt text](https://example.com/a.png), ![](x.png), and \\*escaped\\* \\`ticks\\`.",
  "",
  "- one",
  "- two",
  "  continued line",
  "  - nested **item**",
  "    - deeper",
  "1. first",
  "2) second",
  "10. tenth",
  "",
  "> quoted *line*",
  "> second quoted line",
  "",
  "---",
  "***",
  "",
  "| Name | Value |",
  "| --- | :---: |",
  "| a | `1` |",
  "| b | 2 |",
  "",
  "```swift",
  "let a = 1",
  "\tlet b = 2",
  "```",
  "",
  "~~~",
  "plain fence",
  "~~~",
  "",
  "```ts",
  ...Array.from({ length: 95 }, (_, i) => `const line${i} = ${i};`),
  "```",
  "",
  "Trailing text with a ```fence that never closes",
  "```py",
  "print('open')",
].join("\n");

function builderCases() {
  const cases = [];
  const add = (name, blocks, options = {}) => {
    const opts = { live: false, cwd: CWD, open: [], sending: [], hasOlder: false, loadingOlder: false, canBuild: false, ...options };
    const rows = buildRows(clone(blocks), { ...opts, open: new Set(opts.open), sending: new Set(opts.sending) });
    cases.push({ name, blocks, options: opts, rows: clone(rows) });
  };
  for (const [name, blocks] of Object.entries(EDGE_CASES)) {
    add(`${name}, settled`, blocks);
    add(`${name}, live`, blocks, { live: true });
  }
  add("pending edit approval, sending", EDGE_CASES["pending edit approval"], { live: true, sending: [3] });
  const demo = (id) => sessions.find((item) => item.session.id === id);
  const auth = demo("s-auth");
  add("demo s-auth", auth.session.blocks, { cwd: auth.session.cwd });
  add("demo s-auth, folds open", auth.session.blocks, { cwd: auth.session.cwd, open: ["u0:fold", "u3:fold"] });
  add("demo s-perf, older", demo("s-perf").session.blocks, { hasOlder: true });
  add("demo s-perf, loading older", demo("s-perf").session.blocks, { hasOlder: true, loadingOlder: true });
  add("demo s-api", demo("s-api").session.blocks);
  add("demo s-old-5", demo("s-old-5").session.blocks);
  add("fixture 40", fixtureSession(40, 3), { cwd: undefined });
  add("markdown", [user("u1", "Show every block"), say("a1", MARKDOWN)]);
  add("markdown, streaming", [user("u1", "Show every block"), say("a1", MARKDOWN.slice(0, 1400), { streaming: true })], { live: true });
  add("live turn before any text", [user("u1", "Go")], { live: true });
  add("live turn with only reasoning", [user("u1", "Go"), think("r1", "Planning", { streaming: true })], { live: true });
  const plan = [user("u1", "Plan the fix"), { id: "p1", role: "plan", text: "## Serialise the refresh\n\n1. Lock\n2. Test", plan: { status: "ready" } }];
  add("plan, buildable", plan, { canBuild: true });
  add("plan, not buildable", plan);
  add("plan, building", [plan[0], { ...plan[1], plan: { status: "building" } }], { canBuild: true });
  add("plan, streaming", [plan[0], { ...plan[1], streaming: true }], { canBuild: true, live: true });
  add("attachments and drafts", [
    user("u1", "Look at this", { attachments: [{ id: "img1", name: "failing-test.png", mimeType: "image/png", kind: "image", size: 501 }, { id: "f1", name: "log.txt", mimeType: "text/plain", kind: "file", size: 10 }] }),
    say("a1", "Seen."),
    user("u2", "Later", { draft: true }),
  ]);
  add("unicode", [user("u1", "Ünïcödé — “quotes” 🚀 and 日本語"), say("a1", "Emoji 👩‍💻 in **bold 🚀** and `code 🚀` with ü.")]);
  return { cases };
}

/** Consecutive row lists from one session: streamed, settled, folded, paged. */
function diffCases() {
  const base = sessions.find((item) => item.session.id === "s-auth").session.blocks.filter((block) => block.id !== "t-log");
  const reply = answer(seeded(11), true);
  const states = [];
  const rows = (blocks, options = {}) => buildRows(clone(blocks), { live: false, cwd: CWD, open: new Set(options.open ?? []), hasOlder: options.hasOlder, loadingOlder: options.loadingOlder });
  states.push(["empty", []]);
  states.push(["settled", rows(base)]);
  const turn = [user("n-u", "And the refresh test?")];
  states.push(["sent", buildRows(clone([...base, ...turn]), { live: true, cwd: CWD, open: new Set() })]);
  for (const end of [0, 40, 160, 600, reply.length]) {
    const blocks = [...base, ...turn, think("n-r", "Checking the refresh path."), tool("n-t", "Read src/auth/refresh.ts", { kind: "read", preview: { kind: "read", path: `${CWD}/src/auth/refresh.ts` } }), say("n-a", reply.slice(0, end), { streaming: end < reply.length })];
    states.push([`streamed ${end}`, buildRows(clone(blocks), { live: true, cwd: CWD, open: new Set() })]);
  }
  const full = [...base, { ...turn[0], durationMs: 42_000 }, think("n-r", "Checking the refresh path."), tool("n-t", "Read src/auth/refresh.ts", { kind: "read", preview: { kind: "read", path: `${CWD}/src/auth/refresh.ts` } }), say("n-a", reply)];
  states.push(["settled again", rows(full)]);
  states.push(["fold open", rows(full, { open: ["n-u:fold"] })]);
  states.push(["fold closed", rows(full)]);
  states.push(["older available", rows(full, { hasOlder: true })]);
  states.push(["older loading", rows(full, { hasOlder: true, loadingOlder: true })]);
  const older = fixtureSession(2, 77).map((block) => ({ ...block, id: `old-${block.id}` }));
  states.push(["older prepended", rows([...older, ...full])]);
  states.push(["turns reordered", rows([...full.slice(-4), ...full.slice(0, -4)])]);
  states.push(["cleared", []]);
  const cases = [];
  for (let i = 1; i < states.length; i++) {
    const [name, after] = states[i];
    const before = states[i - 1][1];
    cases.push({ name: `${states[i - 1][0]} → ${name}`, before, after, ops: clone(diffRows(before, after)) });
  }
  return { cases };
}

// ── Output ──────────────────────────────────────────────────────────────────

const huge = fixtureSession(1000);
const outputs = {
  [join(transcriptDir, "rows-120.json")]: settled(120),
  [join(transcriptDir, "rows-1000.json")]: buildRows(huge, { live: false, open: new Set() }),
  [join(transcriptDir, "theme-dark.json")]: transcriptTheme(palette({ scheme: "dark" })),
  [join(transcriptDir, "theme-light.json")]: transcriptTheme(palette({ scheme: "light" })),
  [join(transcriptDir, "stream.json")]: recordStream(huge),
  [join(demoDir, "demo-state.json")]: demoState,
  [join(demoTests, "demo-responses.json")]: responses,
  [join(wireTests, "wire-samples.json")]: {
    inbox: firstResult("inbox.list"),
    projects: firstResult("projects.list"),
    models: firstResult("models.list"),
    page: firstResult("sessions.page", (p) => p.projectId === "p-app" && !p.cursor && p.archived === "exclude"),
    older: firstResult("sessions.blocks"),
    unchanged: firstResult("sessions.sync", (p) => p.revision !== undefined),
  },
  [join(wireTests, "sync-cases.json")]: syncCases(),
  [join(wireTests, "grouping.json")]: grouping(),
  [join(transcriptTests, "builder.json")]: builderCases(),
  [join(transcriptTests, "diff.json")]: diffCases(),
};

const check = process.argv.includes("--check");
let stale = false;
for (const [path, value] of Object.entries(outputs)) {
  const text = JSON.stringify(value) + "\n";
  const previous = await readFile(path, "utf8").catch(() => "");
  const name = path.slice(packages.length + 1);
  if (previous === text) continue;
  if (check) {
    console.error(`${name} is out of date; run node apps/ios/scripts/gen-fixtures.mjs`);
    stale = true;
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    console.log(`wrote ${name} (${(text.length / 1024).toFixed(0)} KiB)`);
  }
}
if (stale) process.exit(1);
