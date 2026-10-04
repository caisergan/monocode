// Spike S1 (14): how long a 400-line TypeScript block takes to highlight. This
// runs in Node (V8), not Hermes, so it is not the S1 measurement itself. The
// second command turns off V8's optimising compilers and its native regex
// code, which is closer to an interpreter like Hermes (--jitless would also
// do it, but it disables WebAssembly, which vite-node needs).
//
// Run from apps/mobile, optionally with a .ts file to time its first 400 lines:
//   ../../node_modules/.bin/vite-node src/highlight/scripts/bench.ts [file.ts]
//   node --no-opt --no-maglev --no-sparkplug --regexp-interpret-all \
//     ../../node_modules/.bin/vite-node src/highlight/scripts/bench.ts [file.ts]

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { typescriptModule } from "../__tests__/samples";
import { highlightWithBackend, setHighlightBackend, type Backend } from "../backend";

const RUNS = 50;
const file = process.argv[2];
const code = file ? readFileSync(file, "utf8").split("\n").slice(0, 400).join("\n") : typescriptModule(400);

async function highlight(backend: Backend): Promise<number> {
  const started = performance.now();
  const result = await highlightWithBackend(code, { lang: "typescript", scheme: "dark" });
  const elapsed = performance.now() - started;
  if (result?.backend !== backend || result.lines.length !== 400) throw new Error(`${backend} didn't highlight 400 lines`);
  return elapsed;
}

const ms = (value: number) => `${value.toFixed(1)} ms`;

async function measure(backend: Backend) {
  setHighlightBackend(backend);
  // Loads the modules, so the next fresh start measures the highlighter alone.
  const firstLoad = await highlight(backend);
  setHighlightBackend(backend);
  const fresh = await highlight(backend);
  const warm: number[] = [];
  for (let i = 0; i < RUNS; i++) warm.push(await highlight(backend));
  warm.sort((a, b) => a - b);
  console.log(
    `${backend}: first call with module loading ${ms(firstLoad)}; fresh highlighter, first block ${ms(fresh)}; ` +
      `warm median ${ms(warm[RUNS >> 1])}, p95 ${ms(warm[Math.floor(RUNS * 0.95)])}, min ${ms(warm[0])} (${RUNS} runs)`,
  );
}

const flags = process.execArgv.filter((arg) => arg.startsWith("--")).join(" ");
console.log(`${file ?? "Generated module"}: 400 lines, ${code.length} chars, Node ${process.version} ${flags} (V8, not Hermes)`);
await measure("shiki");
await measure("highlightjs");
