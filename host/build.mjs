import { build } from "esbuild";
import { copyFile } from "node:fs/promises";

await build({
  entryPoints: ["host/cli.ts"],
  outfile: "build/host/monocode-host.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  loader: { ".ps1": "text" },
  define: { "import.meta.hot": "undefined" },
  sourcemap: true,
  // ws and qrcode are CommonJS and require Node built-ins at run time.
  banner: {
    js: 'import { createRequire as __monocodeRequire } from "node:module"; const require = __monocodeRequire(import.meta.url);',
  },
});
await copyFile("host/provider-guard.mjs", "build/host/provider-guard.mjs");
