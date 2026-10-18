#!/usr/bin/env node
// Installs MonoCode Host built from this checkout on an SSH machine.
//
// "Update Host" in the app installs the host from the dev branch. This
// installs it from this checkout instead, such as a branch not merged yet:
// it builds the package for the machine's platform, uploads it and runs the
// app's own bootstrap with it.
//
// usage: npm run host:deploy -- <ssh-target> [--port <port>] [--yes]
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args.splice(index, 2)[1];
};
const yes = args.includes("--yes");
if (yes) args.splice(args.indexOf("--yes"), 1);
const requestedPort = flag("--port");
const target = args[0];
if (!target || target.startsWith("-") || args.length > 1) {
  console.error("usage: npm run host:deploy -- <ssh-target> [--port <port>] [--yes]");
  process.exit(1);
}

const ssh = (command, input) => {
  const result = spawnSync("ssh", ["-o", "BatchMode=yes", "--", target, command], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (result.status !== 0)
    throw new Error(`ssh ${target} failed (exit ${result.status ?? result.signal})`);
  return result.stdout;
};
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

const [system, machine] = ssh("uname -s; uname -m").trim().split(/\s+/);
const os = { Linux: "linux", Darwin: "darwin" }[system];
const arch = { x86_64: "x64", amd64: "x64", arm64: "arm64", aarch64: "arm64" }[machine];
if (!os || !arch) throw new Error(`Unsupported host platform: ${system} ${machine}`);
const platform = `${os}-${arch}`;

// Keep the port the desktop's SSH forward already points at.
const running = ssh(
  "[ -x ~/.monocode-host/bin/monocode-host ] && ~/.monocode-host/bin/monocode-host connection-info 2>/dev/null || true",
).trim();
const port = Number(requestedPort ?? (running ? JSON.parse(running).port : 3774));
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid port");

if (running && !yes) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(
    `Reinstalling restarts the host on ${target}; its running turns are interrupted. Continue? [y/N] `,
  );
  prompt.close();
  if (!/^y(es)?$/i.test(answer.trim())) process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
execFileSync("npm", ["run", "host:package", "--", "--target", platform], {
  cwd: root,
  stdio: "inherit",
});

const file = `monocode-host-${platform}.tar.gz`;
const local = join(root, "build/host-packages", file);
const uploads = ".monocode-host/uploads";
ssh(`umask 077 && mkdir -p ${uploads}`);
execFileSync("scp", ["-q", "-o", "BatchMode=yes", local, `${target}:${uploads}/`], {
  stdio: "inherit",
});
const sha256 = readFileSync(`${local}.sha256`, "utf8").split(/\s/)[0];

// The same script "Update Host" runs (remote_ssh::uploaded_package_script).
const template = readFileSync(join(root, "src-tauri/src/remote_bootstrap.sh"), "utf8")
  .replaceAll("\r\n", "\n")
  .replace("@@VERSION@@", shellQuote(version))
  .replace("@@RELEASE@@", "''");
const script = [
  "MONOCODE_HOST_FORCE_UPGRADE=1",
  `MONOCODE_HOST_PORT=${port}`,
  `MONOCODE_HOST_ARCHIVE="$HOME/${uploads}/"${shellQuote(file)}`,
  `MONOCODE_HOST_ARCHIVE_SHA256=${shellQuote(sha256)}`,
  template,
].join("\n");
try {
  const output = ssh("sh -l -s", script).trim().split("\n").at(-1);
  console.log(`MonoCode Host ${version} (this checkout) is running on ${target}, port ${JSON.parse(output).port}.`);
} finally {
  // The bootstrap moves the upload into place unless it failed first.
  ssh(`rm -f ${uploads}/${file}`);
}
