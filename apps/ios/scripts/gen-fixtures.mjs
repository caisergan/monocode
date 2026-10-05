#!/usr/bin/env node
// TypeScript implementations → JSON fixtures for the Swift packages (16 §16.5).
// For R0 it runs the Expo app's transcript code (apps/mobile, frozen at
// b286412) and writes MonoTranscript's Lab and test fixtures:
//
//   rows-120.json    buildRows(fixtureSession(120)), settled
//   rows-1000.json   buildRows(fixtureSession(1000)), settled
//   theme-dark.json  transcriptTheme(palette({ scheme: "dark" }))
//   stream.json      a live turn streamed on top of rows-1000 at 90 chars/s
//                    with 5 tool events/s: one batch of ops per 60 Hz frame
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
const outDir = join(here, "../Packages/MonoTranscript/Sources/MonoTranscript/Resources/Fixtures");

/** The fixtures' clock: 2026-10-01 09:00 UTC. */
const NOW = Date.UTC(2026, 9, 1, 9, 0, 0);
const FRAME_MS = 1000 / 60;
const STREAM_CHARS_PER_SECOND = 90;
const TOOL_EVENTS_PER_SECOND = 5;
/** Enough for the Lab's run (stream from 2 s, fling 3.5 s to 13.5 s) with room to spare. */
const STREAM_SECONDS = 30;

// theme.ts imports react and react-native for its hook; transcriptTheme() is
// pure. The desktop session model reaches @tauri-apps through terminalTab.ts.
// CommonJS stubs, so any named import resolves (to undefined); none is called.
const stubs = {
  react: "module.exports = { useMemo: (f) => f() };",
  "react-native": "module.exports = { useColorScheme: () => 'dark' };",
  tauri: "module.exports = {};",
};

const stubPlugin = {
  name: "stubs",
  setup(b) {
    b.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "stub" }));
    b.onResolve({ filter: /^react-native$/ }, () => ({ path: "react-native", namespace: "stub" }));
    b.onResolve({ filter: /^@tauri-apps\// }, () => ({ path: "tauri", namespace: "stub" }));
    b.onResolve({ filter: /^@\// }, (args) => ({ path: join(mobile, "src", args.path.slice(2)) + ".ts" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
  },
};

async function loadExpoCode() {
  const entry = `
    export { fixtureSession, streamScript } from "./src/transcript/fixtures.ts";
    export { buildRows } from "./src/transcript/rows.ts";
    export { transcriptTheme } from "./src/ui/theme.ts";
    export { diffRows } from "./modules/transcript/src/diff.ts";
    export { palette } from "@monocode/design";
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
const { fixtureSession, streamScript, buildRows, transcriptTheme, diffRows, palette } = await loadExpoCode();

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

const huge = fixtureSession(1000);
const outputs = {
  "rows-120.json": settled(120),
  "rows-1000.json": buildRows(huge, { live: false, open: new Set() }),
  "theme-dark.json": transcriptTheme(palette({ scheme: "dark" })),
  "stream.json": recordStream(huge),
};

const check = process.argv.includes("--check");
let stale = false;
await mkdir(outDir, { recursive: true });
for (const [name, value] of Object.entries(outputs)) {
  const text = JSON.stringify(value) + "\n";
  const path = join(outDir, name);
  const previous = await readFile(path, "utf8").catch(() => "");
  if (previous === text) continue;
  if (check) {
    console.error(`${name} is out of date; run node apps/ios/scripts/gen-fixtures.mjs`);
    stale = true;
  } else {
    await writeFile(path, text);
    console.log(`wrote ${name} (${(text.length / 1024).toFixed(0)} KiB)`);
  }
}
if (stale) process.exit(1);
