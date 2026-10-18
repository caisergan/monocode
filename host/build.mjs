import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFile } from "node:fs/promises";

// The desktop compares this with the source branch to offer host updates.
const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
let commit = "";
try {
  commit = git("rev-parse", "HEAD");
  if (git("status", "--porcelain", "--untracked-files=no")) commit += "+dirty";
} catch {
  /* not a git checkout */
}

await build({
  entryPoints: ["host/cli.ts"],
  outfile: "build/host/monocode-host.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  loader: { ".ps1": "text" },
  define: {
    "import.meta.hot": "undefined",
    "process.env.MONOCODE_HOST_COMMIT": JSON.stringify(commit),
  },
  sourcemap: true,
});
await copyFile("host/provider-guard.mjs", "build/host/provider-guard.mjs");
