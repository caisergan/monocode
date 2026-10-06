#!/usr/bin/env node
// A real host for the simulator run (16 §16.7, 14 "As built, R2"), and a
// small control server MonoCodeUITests/PairingUITests drives it through.
//
//   1. Build the host bundle at the repo root: `npm run host:build`, or in a
//      checkout without node_modules, `node apps/ios/scripts/build-host.mjs`
//      after `eval "$(apps/ios/scripts/borrow-node-modules.sh <checkout>)"`.
//   2. Start this script with a fresh temporary data directory. It writes
//      config.json there (direct.mode "all", so loopback works, with
//      127.0.0.1 advertised next to the LAN and Tailscale addresses), runs
//      `monocode-host start`, and opens two folders, my-app and api-server, as
//      projects through a desktop credential:
//
//        node apps/ios/scripts/host-control.mjs --data-dir "$(mktemp -d)" \
//          --port 47820 --direct-port 47821 --control-port 47829
//
//   3. Run the UI tests against it:
//
//        TEST_RUNNER_MC_HOST_CONTROL=http://127.0.0.1:47829/ \
//        TEST_RUNNER_MC_SHOTS_DIR="$PWD/docs/mobile/screenshots/r2" \
//        xcodebuild test -project apps/ios/MonoCode.xcodeproj -scheme MonoCode \
//          -destination 'platform=iOS Simulator,name=iPhone 17,OS=27.0' \
//          -parallel-testing-enabled NO -only-testing:MonoCodeUITests/PairingUITests
//
//   4. Stop it with Ctrl+C: it stops the host too. The data directory is left
//      for inspection; delete it after.
//
// The endpoints, all GET, answer JSON:
//   /link?only=all|lan|tailscale|manual|tsip|tsname|blackhole&approveAfter=ms&deny=1
//        A pairing link (`pairing.create` on /lifecycle) whose offer keeps only
//        those addresses: `tsip` the Tailscale IP alone, `tsname` its MagicDNS
//        name alone, `blackhole` an address that never answers. The claim is
//        allowed (or denied) `approveAfter` ms after the phone claims it.
//   /restart?downMs=ms   Answers at once, then stops the host, waits, starts it.
//   /revoke              Revokes every active phone.
//   /devices             The devices table.
//
// It never uses ~/.monocode-host: --data-dir is required.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) {
    if (fallback === undefined) throw new Error(`--${name} is required`);
    return fallback;
  }
  return args[i + 1];
};
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const bundle = join(repo, "build/host/monocode-host.mjs");
const dir = resolve(option("data-dir"));
const rpcPort = option("port", "47820");
const directPort = option("direct-port", "47821");
const controlPort = Number(option("control-port", "47829"));
if (!existsSync(bundle)) throw new Error(`${bundle} is absent: build the host first (step 1 above)`);

const cli = (...command) =>
  execFileSync(process.execPath, [bundle, ...command, "--data-dir", dir, "--port", rpcPort], {
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
const running = () => JSON.parse(readFileSync(join(dir, "running.json"), "utf8"));
const lifecycle = async (action, params) => {
  const response = await fetch(`http://127.0.0.1:${rpcPort}/lifecycle`, {
    method: "POST",
    headers: { Authorization: `Bearer ${running().secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(params ? { action, params } : { action }),
  });
  return response.json();
};
const log = (...parts) => console.log(new Date().toISOString(), ...parts);

mkdirSync(dir, { recursive: true });
if (!existsSync(join(dir, "config.json")))
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      v: 1,
      direct: { mode: "all", port: Number(directPort), advertise: [{ addr: "127.0.0.1", port: Number(directPort) }] },
      push: { enabled: false },
    }),
  );
log(cli("start").trim());

// A desktop credential opens the projects the phone lists.
const desktop = JSON.parse(cli("pair", "--name", "Seeder", "--json"));
for (const name of ["my-app", "api-server"]) {
  const cwd = join(dir, "projects", name);
  mkdirSync(cwd, { recursive: true });
  const response = await fetch(`http://127.0.0.1:${rpcPort}/rpc`, {
    method: "POST",
    headers: { Authorization: `Bearer ${desktop.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, environmentId: desktop.environmentId, method: "projects.open", params: { cwd } }),
  });
  log("project", name, response.status);
}

/** The offer in `url` with only the addresses `only` names. */
const rewrite = (url, only) => {
  if (!only || only === "all") return url;
  const [base, fragment] = url.split("#o=");
  const offer = JSON.parse(Buffer.from(fragment, "base64url").toString());
  const named = offer.direct.find((endpoint) => endpoint.kind === "tailscale" && endpoint.dns);
  if ((only === "tsip" || only === "tsname") && !named) throw new Error("This Mac has no Tailscale address with a MagicDNS name");
  offer.direct =
    only === "blackhole" ? [{ kind: "manual", addr: "192.0.2.1", port: 3775 }]
    : only === "tsip" ? [{ kind: "tailscale", addr: named.addr, port: named.port }]
    : only === "tsname" ? [{ kind: "manual", addr: named.dns, port: named.port }]
    : offer.direct.filter((endpoint) => endpoint.kind === only);
  return `${base}#o=${Buffer.from(JSON.stringify(offer)).toString("base64url")}`;
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://control");
  try {
    let out = {};
    if (url.pathname === "/link") {
      const offer = await lifecycle("pairing.create", { ttlSeconds: 600 });
      const after = Number(url.searchParams.get("approveAfter") ?? "0");
      const allow = url.searchParams.get("deny") !== "1";
      const timer = setInterval(async () => {
        const status = await lifecycle("pairing.status", { offerId: offer.offerId }).catch(() => undefined);
        if (status?.status !== "claimed") {
          if (status && status.status !== "open") clearInterval(timer);
          return;
        }
        clearInterval(timer);
        log("claimed", status.code, allow ? "allowing" : "denying", "in", after, "ms");
        setTimeout(async () => log("decided", (await lifecycle("pairing.decide", { offerId: offer.offerId, allow })).status), after);
      }, 250);
      out = { url: rewrite(offer.url, url.searchParams.get("only")) };
    } else if (url.pathname === "/restart") {
      // Answers at once, so the phone can watch the drop and the return.
      setTimeout(async () => {
        log(cli("stop").trim());
        while (existsSync(join(dir, "running.json"))) await new Promise((done) => setTimeout(done, 100));
        await new Promise((done) => setTimeout(done, Number(url.searchParams.get("downMs") ?? "1500")));
        log(cli("start").trim());
      }, 500);
      out = { restarting: true };
    } else if (url.pathname === "/revoke") {
      const phones = JSON.parse(cli("devices", "--json")).filter((device) => device.kind === "mobile" && device.status === "active");
      for (const phone of phones) log(cli("revoke", phone.id).trim(), phone.id);
      out = { revoked: phones.map((phone) => phone.id) };
    } else if (url.pathname === "/devices") {
      out = JSON.parse(cli("devices", "--json"));
    } else {
      response.writeHead(404).end(JSON.stringify({ error: "unknown endpoint" }));
      return;
    }
    log(url.pathname, JSON.stringify(out).slice(0, 100));
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
  } catch (error) {
    log("error", error.message);
    response.writeHead(500).end(JSON.stringify({ error: error.message }));
  }
});
server.listen(controlPort, "127.0.0.1", () => log("control on", controlPort));

const stop = () => {
  server.close();
  try {
    log(cli("stop").trim());
  } catch {}
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
