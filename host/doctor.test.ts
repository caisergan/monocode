// `monocode-host doctor --json` is parsed by the desktop: pin its shape.
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HostStore } from "./store";
import { loadOrCreateKeys } from "./keys";
import { loadConfig } from "./config";
import { formatDoctor, runDoctor, type DoctorOptions } from "./doctor";

const IDS = ["host", "version", "database", "integrity", "keys", "config", "listeners", "providers", "disk", "relay", "push"];
const posix = process.platform !== "win32";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function dataDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-doctor-test-"));
  chmodSync(directory, 0o700);
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A data directory as a started host leaves it. */
function initialised() {
  const directory = dataDirectory();
  new HostStore(join(directory, "host.db")).close();
  loadOrCreateKeys(directory);
  loadConfig(directory, 3774);
  return directory;
}

async function listener(): Promise<number> {
  const server: Server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

const options = (directory: string, overrides: Partial<DoctorOptions> = {}): DoctorOptions => ({
  directory,
  port: 3774,
  version: "1.2.3",
  status: async () => undefined,
  providers: async () => ["codex"],
  freeBytes: async () => 50 * 1024 ** 3,
  ...overrides,
});

const byId = (report: { checks: { id: string }[] }) =>
  Object.fromEntries(report.checks.map((check) => [check.id, check])) as Record<
    string,
    { status: string; detail: string; fix: string | null }
  >;

describe("doctor", () => {
  it("reports a healthy running host in a stable shape", async () => {
    const directory = initialised();
    const rpc = await listener();
    const direct = await listener();
    const report = await runDoctor(
      options(directory, {
        status: async () => ({ pid: 4242, port: rpc, version: "1.2.3", listening: ["127.0.0.1"], directPort: direct, directMode: "private" }),
      }),
    );
    expect(Object.keys(report)).toEqual(["v", "hostVersion", "ok", "checks"]);
    expect(report).toMatchObject({ v: 1, hostVersion: "1.2.3", ok: true });
    expect(report.checks.map((check) => check.id)).toEqual(IDS);
    for (const check of report.checks) {
      expect(Object.keys(check)).toEqual(["id", "status", "detail", "fix"]);
      expect(["ok", "warn", "fail"]).toContain(check.status);
      expect(typeof check.detail).toBe("string");
      expect(check.fix === null || typeof check.fix === "string").toBe(true);
    }
    const checks = byId(report);
    expect(report.checks.every((check) => check.status === "ok")).toBe(true);
    expect(checks.host.detail).toBe(`Running (PID 4242, port ${rpc})`);
    expect(checks.database.detail).toBe("Schema version 1");
    expect(checks.integrity.detail).toBe("quick_check passed");
    expect(checks.listeners.detail).toBe(`RPC 127.0.0.1:${rpc}, phones 127.0.0.1:${direct}`);
    expect(checks.providers.detail).toBe("codex");
    expect(checks.disk.detail).toBe("50.0 GiB free");
    expect(checks.relay).toEqual({ status: "ok", detail: "Not configured", fix: null, id: "relay" });
    expect(checks.push).toEqual({ status: "ok", detail: "Not configured", fix: null, id: "push" });
    expect(formatDoctor(report)).toContain("[ok]   listeners");
  });

  it("explains a stopped host, an unreachable listener and a version mismatch", async () => {
    const directory = initialised();
    const stopped = byId(await runDoctor(options(directory)));
    expect(stopped.host).toMatchObject({ status: "warn", detail: "Not running", fix: "Start it with: monocode-host start" });
    expect(stopped.listeners.status).toBe("warn");

    const rpc = await listener();
    const closed = await listener();
    await cleanups.pop()!();
    const running = byId(
      await runDoctor(
        options(directory, {
          status: async () => ({ pid: 1, port: rpc, version: "1.0.0", listening: ["::"], directPort: closed, directMode: "all" }),
        }),
      ),
    );
    expect(running.version).toMatchObject({ status: "warn", detail: "The running host is 1.0.0; this command is 1.2.3" });
    expect(running.listeners.status).toBe("fail");
    expect(running.listeners.detail).toContain(`127.0.0.1:${closed}`);
    expect(running.listeners.fix).toContain("firewall");

    const unanswered = await runDoctor(options(directory, { status: () => Promise.reject(new Error("ECONNREFUSED")) }));
    expect(unanswered.ok).toBe(false);
    expect(byId(unanswered).host.status).toBe("fail");
  });

  it.skipIf(!posix)("fails on readable keys, a broken config, a newer database and low disk space", async () => {
    const directory = initialised();
    chmodSync(join(directory, "keys.json"), 0o644);
    writeFileSync(join(directory, "config.json"), JSON.stringify({ direct: { port: 80 } }));
    const db = new DatabaseSync(join(directory, "host.db"));
    db.exec("PRAGMA user_version = 9");
    db.close();
    const report = await runDoctor(
      options(directory, { providers: async () => [], freeBytes: async () => 10 * 1024 * 1024 }),
    );
    const checks = byId(report);
    expect(report.ok).toBe(false);
    expect(checks.keys).toMatchObject({ status: "fail", detail: "keys.json is readable by other users (mode 644)" });
    expect(checks.keys.fix).toBe(`chmod 600 "${join(directory, "keys.json")}"`);
    expect(checks.config).toMatchObject({ status: "fail", detail: expect.stringContaining("Invalid direct port") });
    expect(checks.database).toMatchObject({ status: "fail", detail: expect.stringContaining("newer host") });
    expect(checks.providers.status).toBe("warn");
    expect(checks.disk).toMatchObject({ status: "fail", detail: "10 MiB free" });
  });

  it("changes nothing in a data directory that doesn't exist yet", async () => {
    const directory = join(dataDirectory(), "never-started");
    const checks = byId(await runDoctor(options(directory)));
    expect(checks.database).toMatchObject({ status: "warn", detail: "No database yet" });
    expect(checks.keys).toMatchObject({ status: "warn", detail: "No host keys yet" });
    expect(checks.config).toMatchObject({ status: "ok" });
    const { existsSync } = await import("node:fs");
    expect(existsSync(directory)).toBe(false);
  });
});
