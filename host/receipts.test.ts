// Mutation receipts (spec 06 §6.8, 09 §9.7): a keyed mutating request runs
// once; retries with the same key and params get the stored result.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostProvider } from "./providers";
import { HostEngine } from "./engine";
import { HostStore, canonicalJson } from "./store";
import { createHostRpc, type CallContext } from "./rpc";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-receipts-test-"));
  const store = new HostStore(join(directory, "host.db"));
  const provider: HostProvider = {
    send: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    bind: vi.fn(),
    approve: vi.fn(),
    answer: vi.fn(),
  };
  const engine = new HostEngine(store, { codex: provider });
  const rpc = createHostRpc(engine, ["codex"]);
  cleanups.push(async () => {
    await engine.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const phone = (key?: string): CallContext => ({
    principal: { deviceId: "phone-1", role: "member", kind: "mobile", name: "Phone" },
    transport: "direct",
    ...(key ? { key } : {}),
  });
  return { directory, store, engine, rpc, phone };
}

const rows = (store: HostStore) =>
  store.db.prepare("SELECT key, device_id, method FROM mutation_receipts").all();

describe("withMutationReceipt", () => {
  it("returns the stored result for the same key and params", async () => {
    const { store } = setup();
    const run = vi.fn(async () => ({ value: 42 }));
    await expect(store.withMutationReceipt("k1", "phone-1", "files.write", { a: 1, b: [2] }, run)).resolves.toEqual({
      value: 42,
    });
    // Key order in params doesn't matter: the hash is over canonical JSON.
    await expect(store.withMutationReceipt("k1", "phone-1", "files.write", { b: [2], a: 1 }, run)).resolves.toEqual({
      value: 42,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(rows(store)).toEqual([{ key: "k1", device_id: "phone-1", method: "files.write" }]);
  });

  it("rejects the same key with different params, method or device", async () => {
    const { store } = setup();
    await store.withMutationReceipt("k1", "phone-1", "files.write", { a: 1 }, () => "done");
    const run = vi.fn(() => "again");
    for (const [device, method, params] of [
      ["phone-1", "files.write", { a: 2 }],
      ["phone-1", "files.create", { a: 1 }],
      ["phone-2", "files.write", { a: 1 }],
    ] as const)
      await expect(store.withMutationReceipt("k1", device, method, params, run)).rejects.toMatchObject({
        code: "idempotency_conflict",
        retryable: false,
      });
    expect(run).not.toHaveBeenCalled();
  });

  it("shares one execution between concurrent duplicates", async () => {
    const { store } = setup();
    let finish!: (value: string) => void;
    const run = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    const first = store.withMutationReceipt("k1", "phone-1", "git.action", { action: "commit" }, run);
    const second = store.withMutationReceipt("k1", "phone-1", "git.action", { action: "commit" }, run);
    // A different payload under a key still in flight conflicts at once.
    await expect(
      store.withMutationReceipt("k1", "phone-1", "git.action", { action: "push" }, run),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    finish("committed");
    await expect(Promise.all([first, second])).resolves.toEqual(["committed", "committed"]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("doesn't store failures, so a retry runs again", async () => {
    const { store } = setup();
    const run = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce("ok");
    await expect(store.withMutationReceipt("k1", "phone-1", "files.write", {}, run)).rejects.toThrow("disk full");
    expect(rows(store)).toEqual([]);
    await expect(store.withMutationReceipt("k1", "phone-1", "files.write", {}, run)).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("forgets receipts after 24 hours, and housekeeping deletes them", async () => {
    const { store } = setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    await store.withMutationReceipt("old", "phone-1", "files.write", {}, () => 1);
    vi.setSystemTime(new Date("2026-10-02T00:00:01Z"));
    await expect(store.withMutationReceipt("old", "phone-1", "files.write", { other: true }, () => 2)).resolves.toBe(2);
    await store.withMutationReceipt("fresh", "phone-1", "files.write", {}, () => 3);
    vi.setSystemTime(new Date("2026-10-03T00:00:02Z"));
    store.devices.housekeeping();
    expect(rows(store)).toEqual([]);
  });

  it("rejects malformed keys", async () => {
    const { store } = setup();
    for (const key of ["", "x".repeat(129), "a\0b", 7 as unknown as string])
      await expect(store.withMutationReceipt(key, "phone-1", "files.write", {}, () => 1)).rejects.toMatchObject({
        code: "invalid_params",
      });
  });

  it("hashes canonical JSON", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[{"x":2,"y":1}]},"b":1}');
  });
});

describe("dispatch with an idempotency key", () => {
  it("wraps mutating methods only", async () => {
    const { rpc, phone, store } = setup();
    const mutate = vi.fn((params: Record<string, unknown>) => ({ applied: params.n }));
    const read = vi.fn(() => ({ at: Date.now() }));
    rpc.register("test.mutate", { kind: "mutating", roles: ["admin", "member"], handler: mutate });
    rpc.register("test.read", { kind: "read", roles: ["admin", "member"], handler: read });
    await expect(rpc.dispatch("test.mutate", { n: 1 }, phone("key-1"))).resolves.toEqual({ applied: 1 });
    await expect(rpc.dispatch("test.mutate", { n: 1 }, phone("key-1"))).resolves.toEqual({ applied: 1 });
    expect(mutate).toHaveBeenCalledTimes(1);
    await expect(rpc.dispatch("test.mutate", { n: 2 }, phone("key-1"))).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    // Without a key a mutation runs every time, as before.
    await rpc.dispatch("test.mutate", { n: 1 }, phone());
    expect(mutate).toHaveBeenCalledTimes(2);
    // Reads ignore the key.
    await rpc.dispatch("test.read", {}, phone("key-2"));
    await rpc.dispatch("test.read", {}, phone("key-2"));
    expect(read).toHaveBeenCalledTimes(2);
    expect(rows(store)).toEqual([{ key: "key-1", device_id: "phone-1", method: "test.mutate" }]);
  });

  it("returns a real method's stored result to a retried request", async () => {
    const { rpc, phone, store, directory } = setup();
    const opened = await rpc.dispatch("projects.open", { cwd: directory }, phone("open-1"));
    await expect(rpc.dispatch("projects.open", { cwd: directory }, phone("open-1"))).resolves.toEqual(opened);
    expect(store.projects()).toHaveLength(1);
  });
});
