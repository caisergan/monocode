// `monocode-host doctor [--json]` (spec 09 §9.10). Read-only: it never creates
// the data directory, the database, keys or config. The desktop parses the
// JSON form, so its shape (`DoctorReport`) only gains fields.

import { existsSync, statSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DoctorCheck, DoctorCheckId, DoctorReport } from "@monocode/core/wire";
import type { RemoteProvider } from "../src/features/connections/model/protocol";
import { readConfig, type HostConfig } from "./config";
import { DB_VERSION } from "./devices";
import { loadOrCreateKeys } from "./keys";

/** What a running host reports through `/lifecycle status`. Hosts older than
 * doctor answer `{}`, so everything past `pid` and `port` is optional. */
export type RunningStatus = {
  pid: number;
  port: number;
  version?: string;
  listening?: string[];
  directPort?: number;
  directMode?: string;
};

export type DoctorOptions = {
  directory: string;
  /** The RPC port this CLI was given. */
  port: number;
  /** This CLI's version. */
  version: string;
  /** Resolves undefined when no host is running; throws when one should be
   * running (running.json exists) but doesn't answer. */
  status: () => Promise<RunningStatus | undefined>;
  providers: () => Promise<RemoteProvider[]>;
  connect?: (host: string, port: number) => Promise<void>;
  freeBytes?: (directory: string) => Promise<number>;
  platform?: NodeJS.Platform;
};

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const check = (id: DoctorCheckId, status: DoctorCheck["status"], detail: string, fix: string | null = null): DoctorCheck => ({
  id,
  status,
  detail,
  fix,
});

function tcpConnect(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out"));
    }, 2_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function diskFree(directory: string): Promise<number> {
  const stats = await statfs(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}

const formatBytes = (bytes: number) =>
  bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GiB` : `${Math.round(bytes / MIB)} MiB`;

/** `127.0.0.1:3775`, `[::1]:3775`. A wildcard is reached through loopback. */
function target(address: string): string {
  if (address === "::" || address === "0.0.0.0") return "127.0.0.1";
  return address;
}
const hostPort = (host: string, port: number) => (host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`);

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const { directory, version } = options;
  const platform = options.platform ?? process.platform;
  const probe = options.connect ?? tcpConnect;
  const checks: DoctorCheck[] = [];
  const start = "Start it with: monocode-host start";

  // Host and version.
  let running: RunningStatus | undefined;
  let unreachable: string | undefined;
  try {
    running = await options.status();
  } catch (error) {
    unreachable = error instanceof Error ? error.message : String(error);
  }
  if (running) checks.push(check("host", "ok", `Running (PID ${running.pid}, port ${running.port})`));
  else if (unreachable)
    checks.push(
      check(
        "host",
        "fail",
        `running.json exists, but the host didn't answer: ${unreachable}`,
        "Run monocode-host stop, then monocode-host start",
      ),
    );
  else checks.push(check("host", "warn", "Not running", start));
  if (!running) checks.push(check("version", "ok", `monocode-host ${version}`));
  else if (!running.version)
    checks.push(
      check("version", "warn", `The running host is older than ${version}`, "Restart it: monocode-host stop, then monocode-host start"),
    );
  else if (running.version !== version)
    checks.push(
      check(
        "version",
        "warn",
        `The running host is ${running.version}; this command is ${version}`,
        "Restart it: monocode-host stop, then monocode-host start",
      ),
    );
  else checks.push(check("version", "ok", `monocode-host ${version}`));

  // Database: schema version and a quick integrity check.
  const dbPath = join(directory, "host.db");
  if (!existsSync(dbPath)) {
    checks.push(check("database", "warn", "No database yet", start));
    checks.push(check("integrity", "ok", "Nothing to check yet"));
  } else {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const userVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
      if (userVersion === DB_VERSION) checks.push(check("database", "ok", `Schema version ${userVersion}`));
      else if (userVersion < DB_VERSION)
        checks.push(
          check("database", "warn", `Schema version ${userVersion}; it is upgraded to ${DB_VERSION} on the next start`, start),
        );
      else
        checks.push(
          check(
            "database",
            "fail",
            `Schema version ${userVersion} was written by a newer host (this one uses ${DB_VERSION})`,
            "Update monocode-host; older hosts can't open this database",
          ),
        );
      const rows = db.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
      const problems = rows.map((row) => String(row.quick_check)).filter((row) => row !== "ok");
      checks.push(
        problems.length
          ? check(
              "integrity",
              "fail",
              `quick_check: ${problems.slice(0, 3).join("; ")}`,
              "Stop the host, keep a copy of host.db, and restore it from a backup",
            )
          : check("integrity", "ok", "quick_check passed"),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push(check("database", "fail", `Could not open host.db: ${message}`, "Check the data directory's permissions"));
      checks.push(check("integrity", "fail", "Not checked: the database could not be opened", "Check the data directory's permissions"));
    } finally {
      db?.close();
    }
  }

  // Key file permissions.
  const keyPath = join(directory, "keys.json");
  if (!existsSync(keyPath)) checks.push(check("keys", "warn", "No host keys yet", start));
  else {
    let corrupt: string | undefined;
    try {
      loadOrCreateKeys(directory);
    } catch (error) {
      corrupt = error instanceof Error ? error.message : String(error);
    }
    const loose = (path: string) => (statSync(path).mode & 0o077) !== 0;
    const mode = (path: string) => (statSync(path).mode & 0o777).toString(8).padStart(3, "0");
    if (corrupt)
      checks.push(
        check(
          "keys",
          "fail",
          `keys.json can't be read: ${corrupt}`,
          "Move keys.json aside and restart the host; paired phones must pair again",
        ),
      );
    else if (platform === "win32") checks.push(check("keys", "ok", "Protected by the data directory's access list"));
    else if (loose(keyPath))
      checks.push(
        check("keys", "fail", `keys.json is readable by other users (mode ${mode(keyPath)})`, `chmod 600 "${keyPath}"`),
      );
    else if (loose(directory))
      checks.push(
        check("keys", "fail", `The data directory is open to other users (mode ${mode(directory)})`, `chmod 700 "${directory}"`),
      );
    else checks.push(check("keys", "ok", "keys.json is private (mode 600)"));
  }

  // Config validity.
  let config: HostConfig | undefined;
  try {
    config = readConfig(directory, options.port);
    checks.push(
      config
        ? check(
            "config",
            "ok",
            `Direct connections ${config.direct.mode === "off" ? "off" : `${config.direct.mode} on port ${config.direct.port}`}; relay ${config.relay.enabled ? "on" : "off"}`,
          )
        : check("config", "ok", "Defaults (config.json is created on the first start)"),
    );
  } catch (error) {
    checks.push(
      check(
        "config",
        "fail",
        error instanceof Error ? error.message : String(error),
        `Fix ${join(directory, "config.json")}, or delete it to restore the defaults`,
      ),
    );
  }

  // Listeners: connect to each address the running host is bound to.
  if (!running) checks.push(check("listeners", "warn", "Not checked: the host is not running", start));
  else {
    const targets = [{ label: "RPC", host: "127.0.0.1", port: running.port }];
    if (running.listening && running.directPort)
      for (const address of running.listening)
        targets.push({ label: "phones", host: target(address), port: running.directPort });
    const results = await Promise.all(
      targets.map(async (item) => {
        try {
          await probe(item.host, item.port);
          return { ...item, error: undefined };
        } catch (error) {
          return { ...item, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    const failed = results.filter((item) => item.error);
    const list = results.map((item) => `${item.label} ${hostPort(item.host, item.port)}`).join(", ");
    if (failed.length)
      checks.push(
        check(
          "listeners",
          "fail",
          `Could not connect to ${failed.map((item) => `${hostPort(item.host, item.port)} (${item.error})`).join(", ")}`,
          "Check that a firewall allows the port, then restart the host",
        ),
      );
    else if (running.listening === undefined)
      checks.push(check("listeners", "warn", `${list}; this host doesn't report phone listeners`, "Restart it to use this version"));
    else if (!running.listening.length && running.directMode !== "off")
      checks.push(
        check(
          "listeners",
          "warn",
          `${list}; no private network address to listen on for phones`,
          "Connect this machine to a LAN or Tailscale, or set direct.mode to \"all\"",
        ),
      );
    else
      checks.push(
        check("listeners", "ok", running.directMode === "off" ? `${list}; direct connections are off` : list),
      );
  }

  // Provider binaries.
  const available = await options.providers().catch(() => [] as RemoteProvider[]);
  checks.push(
    available.length
      ? check("providers", "ok", available.join(", "))
      : check("providers", "warn", "No provider CLI found", "Install and sign in to Codex, Claude or another supported provider"),
  );

  // Free disk space where sessions are stored.
  try {
    const free = await (options.freeBytes ?? diskFree)(existsSync(directory) ? directory : join(directory, ".."));
    checks.push(
      free < 100 * MIB
        ? check("disk", "fail", `${formatBytes(free)} free`, "Free disk space; sessions can't be saved")
        : free < GIB
          ? check("disk", "warn", `${formatBytes(free)} free`, "Free some disk space")
          : check("disk", "ok", `${formatBytes(free)} free`),
    );
  } catch (error) {
    checks.push(check("disk", "warn", `Could not read free space: ${error instanceof Error ? error.message : error}`));
  }

  // Not built yet: no relay client, no push targets.
  checks.push(
    config?.relay.enabled
      ? check("relay", "warn", "Enabled, but this host has no relay client yet", "Turn the relay off in the host settings")
      : check("relay", "ok", "Not configured"),
  );
  checks.push(check("push", "ok", "Not configured"));

  return { v: 1, hostVersion: version, ok: !checks.some((item) => item.status === "fail"), checks };
}

/** The terminal form: one line per check, with its fix underneath. */
export function formatDoctor(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((item) => item.id.length));
  return report.checks
    .map((item) =>
      [
        `${`[${item.status}]`.padEnd(6)} ${item.id.padEnd(width)}  ${item.detail}`,
        ...(item.fix ? [`${" ".repeat(width + 9)}Fix: ${item.fix}`] : []),
      ].join("\n"),
    )
    .join("\n");
}
