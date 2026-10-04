// host.config (spec 09 §9.3): validation, atomic saves, change events, and
// the admin-only setter over the shared dispatcher.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostConfigView } from "@monocode/core/wire";
import type { HostProvider } from "./providers";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { createHostRpc, type CallContext } from "./rpc";
import { HostConfigStore, applyConfigPatch, defaultConfig, readConfig } from "./config";

const RPC_PORT = 3774;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function directory() {
  const path = mkdtempSync(join(tmpdir(), "monocode-config-test-"));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

describe("config patches", () => {
  it.each([
    [{ direct: { port: 80 } }, "Invalid direct port"],
    [{ direct: { port: RPC_PORT } }, "Invalid direct port"],
    [{ direct: { port: 70_000 } }, "Invalid direct port"],
    [{ direct: { port: 4000.5 } }, "Invalid direct port"],
    [{ direct: { mode: "public" } }, "Invalid direct mode"],
    [{ direct: { advertise: Array.from({ length: 5 }, () => ({ addr: "10.0.0.1", port: 3775 })) } }, "at most 4"],
    [{ direct: { advertise: [{ addr: "10.0.0.1" }] } }, "Invalid advertised address"],
    [{ direct: { advertise: [{ addr: "bad host!", port: 3775 }] } }, "Invalid advertised address"],
    [{ direct: { advertise: [{ addr: "10.0.0.1", port: 3775, extra: 1 }] } }, "Invalid advertised address"],
    [{ relay: { url: "ws://relay.example.com" } }, "Invalid relay URL"],
    [{ relay: { url: "ws://localhost.evil.example" } }, "Invalid relay URL"],
    [{ relay: { url: "https://relay.example.com" } }, "Invalid relay URL"],
    [{ relay: { url: "not a url" } }, "Invalid relay URL"],
    [{ relay: { enabled: "yes" } }, "Invalid relay.enabled"],
    [{ pairing: { linkBase: "http://example.com/pair" } }, "Invalid pairing link base"],
    [{ pairing: { linkBase: "https://example.com/join" } }, "Invalid pairing link base"],
    [{ pairing: { requireConfirmation: 1 } }, "Invalid pairing.requireConfirmation"],
    [{ push: { allowPrivateGateways: null } }, "Invalid push.allowPrivateGateways"],
    [{ relay: { roomId: "mine" } }, "Invalid setting: relay.roomId"],
    [{ power: { preventIdleSleepWhileRunning: false } }, "Invalid setting: power"],
    [{ direct: "all" }, "Invalid setting: direct"],
    [[], "Invalid settings"],
  ])("rejects %j", (patch, message) => {
    const error = (() => {
      try {
        applyConfigPatch(defaultConfig(), patch, RPC_PORT);
      } catch (caught) {
        return caught as { code?: string; message: string };
      }
    })();
    expect(error).toMatchObject({ code: "invalid_params" });
    expect(error!.message).toContain(message);
  });

  it("accepts every documented field", () => {
    const config = applyConfigPatch(
      defaultConfig(),
      {
        relay: { enabled: true, url: "ws://127.0.0.1:8787" },
        direct: { mode: "all", port: 4100, advertise: [{ addr: "host.tailnet.ts.net", port: 4100 }] },
        push: { enabled: false, allowPrivateGateways: true },
        pairing: { requireConfirmation: false, linkBase: "https://example.com/pair" },
      },
      RPC_PORT,
    );
    expect(config).toMatchObject({
      relay: { enabled: true, url: "ws://127.0.0.1:8787" },
      direct: { mode: "all", port: 4100, advertise: [{ addr: "host.tailnet.ts.net", port: 4100 }] },
      push: { enabled: false, allowPrivateGateways: true },
      pairing: { requireConfirmation: false, linkBase: "https://example.com/pair", defaultTtlSeconds: 600 },
    });
    expect(applyConfigPatch(defaultConfig(), { relay: { url: "wss://relay.example.com" } }, RPC_PORT).relay.url).toBe(
      "wss://relay.example.com",
    );
    expect(applyConfigPatch(defaultConfig(), { pairing: { linkBase: "monocode://pair" } }, RPC_PORT).pairing.linkBase).toBe(
      "monocode://pair",
    );
  });
});

describe("HostConfigStore", () => {
  it("saves atomically, announces real changes once, and leaves bad patches unapplied", async () => {
    const dir = directory();
    const config = new HostConfigStore(dir, RPC_PORT);
    const file = join(dir, "config.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const changed = vi.fn();
    config.onChanged(changed);

    await config.set({ direct: { port: 4200 } });
    expect(config.current.direct.port).toBe(4200);
    expect(JSON.parse(readFileSync(file, "utf8")).direct.port).toBe(4200);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0][1].direct.port).toBe(3775);

    await config.set({ direct: { port: 4200 } });
    expect(changed).toHaveBeenCalledTimes(1);

    const before = readFileSync(file, "utf8");
    await expect(config.set({ direct: { port: 4300 }, relay: { url: "ws://example.com" } })).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(config.current.direct.port).toBe(4200);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("re-reads the file on reload, and rejects an invalid file", async () => {
    const dir = directory();
    const config = new HostConfigStore(dir, RPC_PORT);
    const changed = vi.fn();
    config.onChanged(changed);
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), direct: { mode: "off" } }));
    await config.reload();
    expect(config.current.direct).toMatchObject({ mode: "off", port: 3775 });
    expect(changed).toHaveBeenCalledTimes(1);
    writeFileSync(file, "{ nope");
    expect(() => readConfig(dir, RPC_PORT)).toThrow("Invalid config.json");
    await expect(config.reload()).rejects.toMatchObject({ code: "invalid_params" });
    expect(config.current.direct.mode).toBe("off");
  });
});

describe("host.config over the dispatcher", () => {
  function setup() {
    const dir = directory();
    const store = new HostStore(join(dir, "host.db"));
    const provider: HostProvider = {
      send: async () => {},
      cancel: async () => {},
      stop: async () => {},
      bind: () => {},
      approve: () => {},
      answer: () => {},
    };
    const engine = new HostEngine(store, { codex: provider });
    const config = new HostConfigStore(dir, RPC_PORT);
    const rpc = createHostRpc(engine, ["codex"], { config: { store: config, listening: () => ["192.168.1.20"] } });
    cleanups.push(async () => {
      await engine.close();
      store.close();
    });
    const as = (role: "admin" | "member"): CallContext => ({
      principal: { deviceId: role, role, kind: role === "admin" ? "desktop" : "mobile", name: role },
      transport: role === "admin" ? "http" : "direct",
    });
    return { rpc, config, as };
  }

  it("lets any device read the settings and only admins change them", async () => {
    const { rpc, config, as } = setup();
    const view = (await rpc.dispatch("host.config.get", {}, as("member"))) as HostConfigView;
    expect(view).toEqual({
      relay: { enabled: false, url: "wss://relay.usemono.dev", status: "disabled" },
      direct: { mode: "private", port: 3775, listening: ["192.168.1.20"], advertise: [] },
      push: { enabled: true, allowPrivateGateways: false },
      pairing: { requireConfirmation: true, linkBase: "monocode-dev://pair" },
    });
    // The room id and power settings never leave the host.
    expect(JSON.stringify(view)).not.toContain(config.current.relay.roomId);
    await expect(rpc.dispatch("host.config.set", { direct: { port: 4100 } }, as("member"))).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(config.current.direct.port).toBe(3775);
    const changed = (await rpc.dispatch(
      "host.config.set",
      { direct: { mode: "all", port: 4100 }, relay: { enabled: true } },
      as("admin"),
    )) as HostConfigView;
    expect(changed).toMatchObject({ direct: { mode: "all", port: 4100 }, relay: { enabled: true, status: "error" } });
    await expect(rpc.dispatch("host.config.set", { direct: { port: 1 } }, as("admin"))).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("advertises host.config and presence where they are registered", async () => {
    const { rpc, as } = setup();
    const describe = (await rpc.dispatch("environment.describe", {}, as("admin"))) as {
      capabilities: string[];
      hostVersion: string;
    };
    expect(describe.capabilities).toEqual(
      expect.arrayContaining(["sessions", "host.config", "presence", "sessions.queue", "sessions.createWithPrompt"]),
    );
    // HTTP carries no idempotency key, and has no watch.
    expect(describe.capabilities).not.toContain("mutations.idempotent");
    expect(describe.capabilities).not.toContain("channel.watch");
    expect(describe.hostVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(rpc.capabilities("channel")).toEqual(
      expect.arrayContaining(["channel.watch", "mutations.idempotent", "host.config", "presence"]),
    );
  });
});
