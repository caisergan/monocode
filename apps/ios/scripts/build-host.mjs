#!/usr/bin/env node
// The host bundle for the interop test and the simulator run, in a checkout
// without node_modules: what `npm run host:build` does after its type check
// (host/build.mjs), with NODE_PATH honoured so the packages resolve from
// another checkout's node_modules (scripts/borrow-node-modules.sh). With
// node_modules at the repo root, use `npm run host:build` instead; it also
// type-checks host/. Writes build/host/ (gitignored).
import { build } from "esbuild";
import { copyFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
await build({
  entryPoints: [join(repo, "host/cli.ts")],
  outfile: join(repo, "build/host/monocode-host.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  loader: { ".ps1": "text" },
  define: { "import.meta.hot": "undefined" },
  sourcemap: true,
  nodePaths: process.env.NODE_PATH ? process.env.NODE_PATH.split(delimiter) : [],
  // ws and qrcode are CommonJS and require Node built-ins at run time.
  banner: {
    js: 'import { createRequire as __monocodeRequire } from "node:module"; const require = __monocodeRequire(import.meta.url);',
  },
});
await copyFile(join(repo, "host/provider-guard.mjs"), join(repo, "build/host/provider-guard.mjs"));
console.log("Wrote build/host/monocode-host.mjs");
