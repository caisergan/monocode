import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  configureChildBackend,
  acquireHarnessBridge,
} from "../src/integrations/harness/core/child";
import { HostChildBackend } from "./child-backend";
import { HostStore } from "./store";
import { acquireHostOwner } from "./owner";
import { HostEngine } from "./engine";
import { hostProviders } from "./providers";
import { createHostServer } from "./server";
import {
  REMOTE_PROVIDERS,
  type RemoteProvider,
} from "../src/features/connections/model/protocol";
import { connectionInfo, installService, uninstallService } from "./service";
import { version } from "../package.json";
import { protectWindowsDirectory } from "./windows";
import { createInterface } from "node:readline/promises";
import QRCode from "qrcode";
import { formatCode } from "@monocode/channel/pairing";
import type { PairingOffer, PairingStatus } from "@monocode/core/wire";
import { loadOrCreateKeys } from "./keys";
import { HostConfigStore, configView, loadConfig } from "./config";
import { formatDoctor, runDoctor } from "./doctor";
import { resolveProvider } from "./process";
import { PairingManager } from "./pairing";
import { createHostRpc } from "./rpc";
import { ChannelServer } from "./channel/server";
import { discoverEndpoints } from "./channel/endpoints";
import { HostError, toHostError } from "./errors";

process.umask(0o077);
// npm-based providers can launch Node subprocesses without a separate Node
// installation. Keep the packaged runtime first in the host's own PATH.
process.env.PATH = [dirname(process.execPath), process.env.PATH ?? ""].join(
  delimiter,
);
const args = process.argv.slice(2);
const command = args[0] ?? "help";
const option = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--"))
    throw new Error(`Missing --${name} value`);
  return args[i + 1];
};
const directory = resolve(
  option("data-dir", join(homedir(), ".monocode-host")),
);
const port = Number(option("port", "3774"));
const statePath = join(directory, "running.json");
type Running = { pid: number; port: number; secret: string };
const readRunning = (): Running | undefined => {
  if (!existsSync(statePath)) return;
  return JSON.parse(readFileSync(statePath, "utf8")) as Running;
};
/** Talks to the running host through its local administrative endpoint. */
const lifecycle = async (
  state: Running,
  action: string,
  params?: Record<string, unknown>,
): Promise<unknown> => {
  const response = await fetch(`http://127.0.0.1:${state.port}/lifecycle`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${state.secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params ? { action, params } : { action }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(detail?.error ?? "Could not verify the running host");
  }
  return response.json().catch(() => ({}));
};
const has = (flag: string) => args.includes(`--${flag}`);

/** `pair --mobile`: shows a QR code, then confirms the phone that claims it. */
async function pairMobile(): Promise<void> {
  const state = readRunning();
  if (!state) throw new Error("The host is not running. Start it with: monocode-host start");
  const json = has("json");
  const yes = has("yes");
  if (!yes && !process.stdin.isTTY)
    throw new Error("Nobody could confirm the phone here. Run in a terminal, or pass --yes.");
  const ttl = Number(option("ttl", "10"));
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > 30) throw new Error("--ttl must be 1 to 30 minutes");
  const offer = (await lifecycle(state, "pairing.create", {
    ttlSeconds: Math.round(ttl * 60),
    ...(args.includes("--name") ? { label: option("name", "") } : {}),
  })) as PairingOffer;
  let finished = false;
  const cancel = async () => {
    if (finished) return;
    finished = true;
    await lifecycle(state, "pairing.cancel", { offerId: offer.offerId }).catch(() => undefined);
  };
  process.once("SIGINT", () => {
    void cancel().then(() => {
      if (!json) console.log("\nCancelled. The code no longer works.");
      process.exit(130);
    });
  });
  if (json) console.log(JSON.stringify({ offerId: offer.offerId, url: offer.url, expiresAt: offer.expiresAt, fingerprint: offer.fingerprint }));
  else {
    const reach = [
      offer.reachable.lan && "local network",
      offer.reachable.tailscale && "Tailscale",
      offer.reachable.manual && "configured address",
      offer.reachable.relay && "relay",
    ].filter(Boolean);
    console.log("Pair a phone with this computer");
    console.log("Scan this code with MonoCode Dev, or open the link on your phone.\n");
    console.log(
      await QRCode.toString(offer.url, {
        type: has("ascii") ? "utf8" : "terminal",
        small: !has("ascii"),
        errorCorrectionLevel: "M",
      }),
    );
    console.log(`  ${offer.url}`);
    console.log(`  Host fingerprint: ${offer.fingerprint}`);
    console.log(`  Reachable through: ${reach.join(", ") || "nothing yet"}`);
    console.log(`  Expires in ${ttl} min. Press Ctrl+C to cancel.\n`);
  }
  let announced = false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const status = (await lifecycle(state, "pairing.status", { offerId: offer.offerId })) as PairingStatus;
      if (status.status === "claimed" && !announced) {
        announced = true;
        const device = status.device!;
        const code = formatCode(status.code ?? "");
        if (json) console.log(JSON.stringify({ status: "claimed", device, code: status.code }));
        else console.log(`"${device.name}" (${device.model ?? device.platform}) wants to pair. Code on the phone: ${code}`);
        const allow = yes || /^y(es)?$/i.test((await prompt.question("Allow? [y/N] ")).trim());
        const decided = (await lifecycle(state, "pairing.decide", { offerId: offer.offerId, allow })) as PairingStatus;
        if (json) console.log(JSON.stringify({ status: decided.status }));
        else if (decided.status === "approved")
          console.log(`Paired "${device.name}" (device ${device.id.slice(0, 6)}…). Manage devices with: monocode-host devices`);
        else console.log("Denied. The phone was not paired.");
        finished = true;
        return;
      }
      if (["approved", "denied", "expired", "cancelled"].includes(status.status)) {
        finished = true;
        if (json) console.log(JSON.stringify({ status: status.status }));
        else console.log(status.status === "expired" ? "The code expired. Run this again for a new one." : `Pairing ${status.status}.`);
        return;
      }
    }
  } finally {
    prompt.close();
  }
}

async function main() {
  if (command === "--version") {
    console.log(version);
    return;
  }
  if (command === "help" || command === "--help") {
    console.log(`MonoCode Host (experimental; Node 24+; Windows/Linux/macOS)
  serve                 Run in foreground on 127.0.0.1
  start                 Run detached from this terminal
  service install       Install/start the persistent user service
  service uninstall     Stop the host and remove its service; keeps data
  connection-info       Print the running host's port (JSON)
  status                Check the running host
  stop                  Stop the host and interrupt its running turns
  pair --name <device>  Issue a device credential (shown once)
  pair --mobile [--name <label>] [--ttl <minutes>] [--yes] [--json] [--ascii]
                        Pair a phone (shows a QR code; needs the running host)
  devices [--json]      List paired devices
  rename-device <id> <name>
                        Rename a device
  revoke <device-id>    Revoke a device (closes its live connections)
  endpoints             Show the addresses phones will be offered
  keys fingerprint      Print the host fingerprint
  doctor [--json]       Check the host, database, keys, config, listeners,
                        providers and disk space
Options: --data-dir <directory> --port <port> (default 3774)
Connect another computer using an SSH forward to the loopback port.`);
    return;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid port");
  // Before the data directory is created or re-permissioned: doctor reports
  // what is there, and changes nothing.
  if (command === "doctor") {
    const report = await runDoctor({
      directory,
      port,
      version,
      status: async () => {
        const state = readRunning();
        if (!state) return undefined;
        const reported = (await lifecycle(state, "status")) as Record<string, unknown>;
        return { ...reported, pid: state.pid, port: state.port };
      },
      providers: async () => {
        const found: RemoteProvider[] = [];
        for (const provider of REMOTE_PROVIDERS)
          await resolveProvider(provider).then(
            () => found.push(provider),
            () => undefined,
          );
        return found;
      },
    });
    console.log(has("json") ? JSON.stringify(report, null, 2) : formatDoctor(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") await protectWindowsDirectory(directory);
  else chmodSync(directory, 0o700);
  if (command === "connection-info") {
    console.log(JSON.stringify(await connectionInfo(directory)));
    return;
  }
  if (command === "service" && args[1] === "uninstall") {
    const notes = await uninstallService();
    // Also stops a manually started host, or one the service manager left.
    const state = readRunning();
    if (state) {
      await lifecycle(state, "stop").catch(() => undefined);
      for (let i = 0; i < 200 && existsSync(statePath); i++)
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.log(
      [
        existsSync(statePath)
          ? "The host service was removed, but the host is still running. Run stop, or end its process."
          : "The host is stopped and will not start automatically.",
        `Sessions, logs and device credentials are kept in ${directory}. Delete that directory only if you want to erase them.`,
        ...notes,
      ].join("\n"),
    );
    return;
  }
  if (command === "service") {
    if (args[1] !== "install")
      throw new Error("Use: service install, or service uninstall");
    console.log(
      JSON.stringify(
        await installService({
          directory,
          port,
          executable: process.execPath,
          entry: fileURLToPath(import.meta.url),
        }),
      ),
    );
    return;
  }
  if (command === "status" || command === "stop") {
    const state = readRunning();
    if (!state) {
      console.log("Host is stopped");
      return;
    }
    await lifecycle(state, command);
    console.log(
      command === "stop"
        ? "Host is stopping"
        : `Host is running (PID ${state.pid}, port ${state.port})`,
    );
    return;
  }
  if (command === "start") {
    const log = openSync(join(directory, "host.log"), "a", 0o600);
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        "serve",
        "--data-dir",
        directory,
        "--port",
        String(port),
      ],
      {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log, log],
        env: process.env,
      },
    );
    child.unref();
    closeSync(log);
    for (let i = 0; i < (process.platform === "win32" ? 150 : 50); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const state = readRunning();
      if (state && state.pid === child.pid) {
        console.log(
          `Host started on 127.0.0.1:${state.port}. It will continue after this terminal closes.`,
        );
        return;
      }
    }
    throw new Error(`Host did not start. See ${join(directory, "host.log")}`);
  }
  if (command === "pair" && has("mobile")) {
    await pairMobile();
    return;
  }
  if (command === "keys") {
    if (args[1] !== "fingerprint") throw new Error("Use: keys fingerprint");
    console.log(loadOrCreateKeys(directory).fingerprint);
    return;
  }
  if (command === "endpoints") {
    const config = loadConfig(directory, port);
    const { endpoints } = await discoverEndpoints(config.direct.port, config.direct.advertise);
    if (config.direct.mode === "off") console.log("Direct connections are off.");
    else if (!endpoints.length) console.log("No private network address found.");
    for (const endpoint of endpoints)
      console.log(`${endpoint.kind.padEnd(10)} ${endpoint.addr}:${endpoint.port}${"dns" in endpoint && endpoint.dns ? `  (${endpoint.dns})` : ""}`);
    return;
  }
  const store = new HostStore(join(directory, "host.db"));
  /** Tells a running host to re-read devices (closes revoked phones' channels). */
  const devicesChanged = async () => {
    const state = readRunning();
    if (state) await lifecycle(state, "devices.changed").catch(() => undefined);
  };
  if (command === "pair") {
    const device = store.issueDevice(option("name", "Desktop"));
    console.log(
      JSON.stringify(
        { ...device, environmentId: store.environmentId },
        null,
        args.includes("--json") ? undefined : 2,
      ),
    );
    store.close();
    return;
  }
  if (command === "devices") {
    const devices = store.devices.list();
    store.close();
    if (has("json")) {
      console.log(JSON.stringify(devices, null, 2));
      return;
    }
    if (!devices.length) console.log("No devices are paired.");
    for (const device of devices) {
      const seen = device.lastSeenAt
        ? `last seen ${new Date(device.lastSeenAt).toLocaleString()}${device.lastSeenVia ? ` (${device.lastSeenVia})` : ""}`
        : "never connected";
      console.log(
        [
          device.id,
          device.name,
          `${device.kind}/${device.role}${device.status === "pending" ? " (pending)" : ""}`,
          device.model ?? device.platform ?? "",
          `paired ${new Date(device.createdAt).toLocaleDateString()}`,
          seen,
        ].filter(Boolean).join("  "),
      );
    }
    return;
  }
  if (command === "rename-device") {
    if (!args[1] || !args[2]) throw new Error("Use: rename-device <device-id> <name>");
    store.devices.rename(args[1], args[2]);
    store.close();
    console.log("Device renamed");
    return;
  }
  if (command === "revoke") {
    if (!args[1] || args[1].startsWith("--"))
      throw new Error("Provide a device ID to revoke");
    const revoked = store.revokeDevice(args[1]);
    store.close();
    if (!revoked) throw new Error("Device not found");
    await devicesChanged();
    console.log("Device revoked");
    return;
  }
  if (command !== "serve") {
    store.close();
    throw new Error("Unknown command; run with --help");
  }
  const releaseOwner = await acquireHostOwner(directory);
  const backend = new HostChildBackend();
  let cleanup = () => {
    rmSync(statePath, { force: true });
    store.close();
    releaseOwner();
  };
  try {
    configureChildBackend(backend);
    const release = await acquireHarnessBridge();
    const available: RemoteProvider[] = [];
    for (const provider of REMOTE_PROVIDERS) {
      try {
        await backend.resolve(provider);
        available.push(provider);
      } catch {
        /* report via descriptor */
      }
    }
    const engine = new HostEngine(store, hostProviders);
    const secret = randomBytes(32).toString("base64url");
    const keys = loadOrCreateKeys(directory);
    const config = new HostConfigStore(directory, port);
    let channels: ChannelServer | undefined;
    const listening = () => channels?.listening ?? [];
    const rpc = createHostRpc(engine, available, { config: { store: config, listening } });
    // config.changed: rebind the phone listeners, then tell open channels.
    config.onChanged(() => channels?.reconfigure(() => configView(config.current, listening())));
    // Hourly cleanup of tombstones, device events, receipts and stale push
    // registrations (spec 09 §9.4).
    const housekeeping = () => {
      try {
        store.devices.housekeeping();
      } catch (error) {
        console.error("Housekeeping failed:", error instanceof Error ? error.message : error);
      }
    };
    housekeeping();
    const housekeepingTimer = setInterval(housekeeping, 60 * 60_000);
    housekeepingTimer.unref();
    const pairing = new PairingManager(store.devices, {
      environmentId: store.environmentId,
      name: () => hostname(),
      hostKey: keys.host.publicKey,
      fingerprint: keys.fingerprint,
      endpoints: () => channels?.currentEndpoints ?? [],
      linkBase: () => config.current.pairing.linkBase,
      defaultTtlSeconds: () => config.current.pairing.defaultTtlSeconds,
      requireConfirmation: () => config.current.pairing.requireConfirmation,
    });
    const admin = ["admin" as const];
    rpc.register("pairing.create", {
      kind: "mutating",
      roles: admin,
      handler: (params, ctx) => {
        const { offer: _offer, ...created } = pairing.create({
          createdBy: ctx.principal.deviceId,
          ttlSeconds: typeof params.ttlSeconds === "number" ? params.ttlSeconds : undefined,
          label: typeof params.label === "string" ? params.label : undefined,
          ui: params.ui && typeof params.ui === "object" ? (params.ui as never) : undefined,
        });
        return created;
      },
    });
    rpc.register("pairing.status", { kind: "read", roles: admin, handler: (params) => pairing.status(String(params.offerId ?? "")) });
    rpc.register("pairing.decide", {
      kind: "mutating",
      roles: admin,
      handler: (params, ctx) => pairing.decide(String(params.offerId ?? ""), params.allow === true, ctx.principal.deviceId),
    });
    rpc.register("pairing.cancel", { kind: "mutating", roles: admin, handler: (params) => pairing.cancel(String(params.offerId ?? "")) });
    const revoke = rpc.methods["devices.revoke"];
    rpc.register("devices.revoke", {
      ...revoke,
      handler: async (params, ctx) => {
        const result = await revoke.handler(params, ctx);
        channels?.deviceRevoked(String(params.deviceId ?? ""));
        return result;
      },
    });
    const revokeSelf = rpc.methods["devices.revokeSelf"];
    rpc.register("devices.revokeSelf", {
      ...revokeSelf,
      handler: async (params, ctx) => {
        const result = await revokeSelf.handler(params, ctx);
        if (ctx.transport !== "http") setTimeout(() => channels?.deviceRevoked(ctx.principal.deviceId), 100);
        return result;
      },
    });
    const openProject = rpc.methods["projects.open"];
    rpc.register("projects.open", {
      ...openProject,
      handler: async (params, ctx) => {
        const result = await openProject.handler(params, ctx);
        channels?.projectsChanged();
        return result;
      },
    });
    let stopping = false;
    let stop: () => Promise<void>;
    // The CLI's pairing and device commands act through this endpoint as the
    // host owner. Its secret never leaves running.json.
    const local = { deviceId: "local", role: "admin" as const, kind: "desktop" as const, name: "This computer" };
    const lifecycleActions: Record<string, (params: Record<string, unknown>) => unknown> = {
      // doctor reads this; older hosts answered {}.
      status: () => ({
        version,
        pid: process.pid,
        port,
        listening: listening(),
        directPort: config.current.direct.port,
        directMode: config.current.direct.mode,
      }),
      stop: () => ({}),
      // The CLI changed config.json: re-read it and apply the change.
      reload: async () => configView(await config.reload(), listening()),
      "config.changed": async () => configView(await config.reload(), listening()),
      "pairing.create": (params) => rpc.dispatch("pairing.create", params, { principal: local, transport: "http" }),
      "pairing.status": (params) => rpc.dispatch("pairing.status", params, { principal: local, transport: "http" }),
      "pairing.decide": (params) => rpc.dispatch("pairing.decide", params, { principal: local, transport: "http" }),
      "pairing.cancel": (params) => rpc.dispatch("pairing.cancel", params, { principal: local, transport: "http" }),
      "devices.changed": () => {
        channels?.devicesChanged();
        return {};
      },
    };
    // A separate local administrative credential cannot be used as a paired
    // client credential, and is never sent to the desktop.
    const server = createHostServer(engine, available, (request, response) => {
      if (
        request.method !== "POST" ||
        request.headers.origin ||
        request.headers.authorization !== `Bearer ${secret}`
      ) {
        response.writeHead(403).end();
        return;
      }
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
        if (body.length > 4096) request.destroy();
      });
      request.on("end", async () => {
        let parsed: { action?: unknown; params?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          response.writeHead(400).end();
          return;
        }
        const action = typeof parsed.action === "string" && Object.hasOwn(lifecycleActions, parsed.action)
          ? lifecycleActions[parsed.action] : undefined;
        if (!action) {
          response.writeHead(400).end();
          return;
        }
        try {
          const params = parsed.params && typeof parsed.params === "object" && !Array.isArray(parsed.params)
            ? parsed.params as Record<string, unknown> : {};
          response.end(JSON.stringify((await action(params)) ?? {}));
          if (parsed.action === "stop") void stop();
        } catch (error) {
          const host = error instanceof HostError ? error : toHostError(error);
          response.writeHead(400).end(JSON.stringify({ error: host.message, code: host.code }));
        }
      });
    }, rpc);
    stop = async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(housekeepingTimer);
      pairing.close();
      await channels?.close();
      server.close();
      server.closeAllConnections();
      await engine.close();
      await backend.close();
      release();
      cleanup();
    };
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    writeFileSync(
      statePath,
      JSON.stringify({ pid: process.pid, port, secret }),
      { mode: 0o600 },
    );
    process.once("SIGTERM", () => {
      void stop();
    });
    process.once("SIGINT", () => {
      void stop();
    });
    console.log(
      `MonoCode Host ${store.environmentId} listening on 127.0.0.1:${port}`,
    );
    console.log(
      `Providers: ${available.join(", ") || "none found; install and authenticate a supported provider on this host"}`,
    );
    channels = new ChannelServer({
      store,
      rpc,
      keys,
      pairing,
      providers: available,
      config: () => config.current,
      log: (message) => console.log(message),
    });
    await channels.start();
    console.log(`Host fingerprint: ${keys.fingerprint}`);
    cleanup = () => {
      rmSync(statePath, { force: true });
      store.close();
      releaseOwner();
    };
  } catch (error) {
    await backend.close();
    cleanup();
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
