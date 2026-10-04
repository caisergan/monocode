// Fault injection for keyed git.action calls (spec 06 §6.8, 09 §9.7): a commit
// or push whose response is lost runs once however the phone retries, a key
// reused with other params runs nothing, receipts outlive a host restart, and
// Git waits for running sessions. Each test uses a real checkout whose origin
// is a local bare repository with a post-receive hook that counts pushes.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateKeyPair,
  memorySocketPair,
  openChannel,
  toBase64Url,
  type FrameSocket,
} from "@monocode/channel";
import type { HostProvider } from "./providers";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { createHostRpc, type CallContext } from "./rpc";
import { loadOrCreateKeys } from "./keys";
import { PairingManager } from "./pairing";
import { ChannelConnection, type ChannelHost } from "./channel/connection";

/** Git commands the host ran through promisified execFile, with their timeouts. */
const gitRuns = vi.hoisted(() => [] as { args: string[]; timeout?: number }[]);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const run = promisify(actual.execFile);
  const execFile = ((...args: unknown[]) =>
    (actual.execFile as (...rest: unknown[]) => unknown)(...args)) as typeof actual.execFile;
  Object.defineProperty(execFile, promisify.custom, {
    value: (file: string, args: string[], options: { timeout?: number }) => {
      if (file === "git") gitRuns.push({ args, timeout: options?.timeout });
      return run(file, args, options);
    },
  });
  return { ...actual, execFile };
});

// The host's git calls inherit process.env. The pre-push hook sets GIT_DIR,
// which would point them at the real repository, so drop every inherited
// GIT_* variable for this file.
const inherited = Object.entries(process.env).filter(([key]) => key.startsWith("GIT_"));
beforeAll(() => {
  for (const [key] of inherited) delete process.env[key];
});
afterAll(() => {
  for (const [key, value] of inherited) process.env[key] = value;
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  gitRuns.length = 0;
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  }).trim();

/** A host on `directory`'s database, with a provider whose turns run until finished. */
function openHost(directory: string) {
  const store = new HostStore(join(directory, "host.db"));
  const turns: (() => void)[] = [];
  const provider: HostProvider = {
    send: vi.fn(() => new Promise<void>((resolve) => turns.push(resolve))),
    cancel: vi.fn(async () => turns.at(-1)?.()),
    stop: vi.fn(async () => turns.at(-1)?.()),
    bind: vi.fn(),
    approve: vi.fn(),
    answer: vi.fn(),
  };
  const engine = new HostEngine(store, { codex: provider });
  const rpc = createHostRpc(engine, ["codex"]);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await engine.close();
    store.close();
  };
  cleanups.push(close);
  return { store, engine, rpc, turns, close };
}

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-git-faults-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const checkout = join(directory, "checkout");
  const origin = join(directory, "origin.git");
  const noHooks = join(directory, "no-hooks");
  mkdirSync(checkout);
  mkdirSync(noHooks);
  git(directory, "init", "-q", "--bare", origin);
  // Hooks from a global core.hooksPath must not run here. The origin's own
  // hook counts the pushes it receives.
  git(origin, "config", "core.hooksPath", join(origin, "hooks"));
  writeFileSync(join(origin, "hooks", "post-receive"), "#!/bin/sh\necho push >> pushes.log\n");
  chmodSync(join(origin, "hooks", "post-receive"), 0o755);
  git(checkout, "init", "-q");
  git(checkout, "checkout", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "Host Test"],
    ["user.email", "host@example.test"],
    ["commit.gpgsign", "false"],
    ["core.autocrlf", "false"],
    ["core.hooksPath", noHooks],
  ])
    git(checkout, "config", key, value);
  writeFileSync(join(checkout, "app.ts"), "export const version = 0;\n");
  git(checkout, "add", "--", ".");
  git(checkout, "commit", "-qm", "initial");
  git(checkout, "remote", "add", "origin", origin);

  const host = openHost(directory);
  const project = await host.engine.openProject(checkout);
  const pushLog = join(origin, "pushes.log");
  return {
    directory,
    checkout,
    origin,
    host,
    project,
    /** Changes app.ts and stages it, so a commit that runs again would show. */
    stage(version: number) {
      writeFileSync(join(checkout, "app.ts"), `export const version = ${version};\n`);
      git(checkout, "add", "--", "app.ts");
    },
    commits: () => Number(git(checkout, "rev-list", "--count", "HEAD")),
    subject: () => git(checkout, "log", "-1", "--format=%s"),
    staged: () => git(checkout, "diff", "--cached", "--name-only"),
    head: () => git(checkout, "rev-parse", "HEAD"),
    remoteHead: () => git(origin, "rev-parse", "--verify", "--quiet", "refs/heads/main"),
    pushes: () => (existsSync(pushLog) ? readFileSync(pushLog, "utf8").split("\n").filter(Boolean).length : 0),
    commit: (message = "From the phone") => ({ projectId: project.id, action: "commit", message }),
    push: () => ({ projectId: project.id, action: "push" }),
  };
}

const phone = (key?: string): CallContext => ({
  principal: { deviceId: "phone-1", role: "member", kind: "mobile", name: "Phone" },
  transport: "direct",
  ...(key ? { key } : {}),
});

const receipts = (store: HostStore) => store.db.prepare("SELECT key, method FROM mutation_receipts ORDER BY key").all();
const ran = (verb: string) => gitRuns.filter((run) => run.args.includes(verb));

describe("keyed git.action under faults", () => {
  it("commits once when a lost response is retried, at the same time or later", async () => {
    const s = await setup();
    s.stage(1);
    // The phone resent while the first attempt was still running.
    const [first, duplicate] = await Promise.all([
      s.host.rpc.dispatch("git.action", s.commit(), phone("commit-1")),
      s.host.rpc.dispatch("git.action", s.commit(), phone("commit-1")),
    ]);
    expect(first).toBeNull();
    expect(duplicate).toEqual(first);
    expect(s.commits()).toBe(2);
    expect(s.subject()).toBe("From the phone");
    expect(ran("commit")).toHaveLength(1);

    // The first response was lost; the retry comes later. Something is staged
    // now, so running the commit again would make a third commit.
    s.stage(2);
    await expect(s.host.rpc.dispatch("git.action", s.commit(), phone("commit-1"))).resolves.toEqual(first);
    expect(s.commits()).toBe(2);
    expect(s.staged()).toBe("app.ts");
    expect(ran("commit")).toHaveLength(1);
    expect(receipts(s.host.store)).toEqual([{ key: "commit-1", method: "git.action" }]);

    // Without a key the same request is a new commit, as before.
    await s.host.rpc.dispatch("git.action", s.commit(), phone());
    expect(s.commits()).toBe(3);
  });

  it("reaches the remote once when a push is retried with the same key", async () => {
    const s = await setup();
    s.stage(1);
    git(s.checkout, "commit", "-qm", "local work");
    const [first, duplicate] = await Promise.all([
      s.host.rpc.dispatch("git.action", s.push(), phone("push-1")),
      s.host.rpc.dispatch("git.action", s.push(), phone("push-1")),
    ]);
    expect(duplicate).toEqual(first);
    expect(s.pushes()).toBe(1);
    const pushed = s.head();
    expect(s.remoteHead()).toBe(pushed);

    // A new local commit would make a second push reach the remote.
    s.stage(2);
    git(s.checkout, "commit", "-qm", "not pushed");
    await expect(s.host.rpc.dispatch("git.action", s.push(), phone("push-1"))).resolves.toEqual(first);
    expect(s.pushes()).toBe(1);
    expect(s.remoteHead()).toBe(pushed);
    expect(ran("push")).toHaveLength(1);
  });

  it("refuses a key reused with other params and runs nothing", async () => {
    const s = await setup();
    s.stage(1);
    await s.host.rpc.dispatch("git.action", s.commit("first"), phone("key-1"));
    s.stage(2);
    for (const params of [s.commit("second"), s.push(), { ...s.commit("first"), cwd: s.checkout }])
      await expect(s.host.rpc.dispatch("git.action", params, phone("key-1"))).rejects.toMatchObject({
        code: "idempotency_conflict",
        retryable: false,
      });
    // A conflicting request while the first is still running is refused too.
    const running = s.host.rpc.dispatch("git.action", s.commit("third"), phone("key-2"));
    await expect(s.host.rpc.dispatch("git.action", s.push(), phone("key-2"))).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    await running;
    expect(s.commits()).toBe(3);
    expect(s.subject()).toBe("third");
    expect(s.pushes()).toBe(0);
    expect(ran("commit")).toHaveLength(2);
    expect(ran("push")).toHaveLength(0);
  });

  it("returns the stored result after a host restart without running Git", async () => {
    const s = await setup();
    s.stage(1);
    const committed = await s.host.rpc.dispatch("git.action", s.commit(), phone("restart-commit"));
    const pushed = await s.host.rpc.dispatch("git.action", s.push(), phone("restart-push"));
    expect(s.commits()).toBe(2);
    expect(s.pushes()).toBe(1);
    await s.host.close();

    const restarted = openHost(s.directory);
    // An unpushed commit and a staged change: a push or commit that ran again would show.
    s.stage(2);
    git(s.checkout, "commit", "-qm", "after the restart");
    s.stage(3);
    const before = gitRuns.length;
    await expect(restarted.rpc.dispatch("git.action", s.commit(), phone("restart-commit"))).resolves.toEqual(committed);
    await expect(restarted.rpc.dispatch("git.action", s.push(), phone("restart-push"))).resolves.toEqual(pushed);
    expect(gitRuns.length).toBe(before);
    expect(s.commits()).toBe(3);
    expect(s.staged()).toBe("app.ts");
    expect(s.pushes()).toBe(1);
    expect(s.remoteHead()).not.toBe(s.head());
    expect(receipts(restarted.store)).toEqual([
      { key: "restart-commit", method: "git.action" },
      { key: "restart-push", method: "git.action" },
    ]);
  });

  it("refuses commit and push while a session in the project runs, and runs them once it stops", async () => {
    const s = await setup();
    s.stage(1);
    const { engine, store } = s.host;
    const { sessionId } = engine.command({
      type: "create",
      commandId: crypto.randomUUID(),
      projectId: s.project.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    });
    engine.command({ type: "send", commandId: crypto.randomUUID(), sessionId, text: "Work" });
    await vi.waitFor(() => expect(store.session(sessionId).status).toBe("running"));
    for (const [params, key] of [
      [s.commit(), "busy-commit"],
      [s.push(), "busy-push"],
    ] as const)
      await expect(s.host.rpc.dispatch("git.action", params, phone(key))).rejects.toMatchObject({
        code: "session_busy",
        retryable: false,
      });
    expect(s.commits()).toBe(1);
    expect(s.pushes()).toBe(0);
    expect([...ran("commit"), ...ran("push")]).toEqual([]);
    expect(receipts(store)).toEqual([]);

    s.host.turns[0]();
    await vi.waitFor(() => expect(store.session(sessionId).status).not.toBe("running"));
    // A refusal isn't stored, so the phone's retry with the same key runs.
    await s.host.rpc.dispatch("git.action", s.commit(), phone("busy-commit"));
    expect(s.commits()).toBe(2);
    await s.host.rpc.dispatch("git.action", s.push(), phone("busy-push"));
    expect(s.pushes()).toBe(1);
    expect(s.remoteHead()).toBe(s.head());
  });

  it("commits once when the channel loses the response and the phone resends", async () => {
    const s = await setup();
    const { store, rpc } = s.host;
    const keys = loadOrCreateKeys(s.directory);
    const pairing = new PairingManager(store.devices, {
      environmentId: store.environmentId,
      name: () => "test-host",
      hostKey: keys.host.publicKey,
      fingerprint: keys.fingerprint,
      endpoints: () => [],
      linkBase: () => "monocode-dev://pair",
      defaultTtlSeconds: () => 600,
      requireConfirmation: () => true,
    });
    const connections = new Set<ChannelConnection>();
    const host: ChannelHost = {
      store,
      rpc,
      keys,
      pairing,
      providers: ["codex"],
      endpoints: () => [],
      register: (connection) => connections.add(connection),
      unregister: (connection) => connections.delete(connection),
    };
    cleanups.push(() => {
      for (const connection of connections) connection.close();
      pairing.close();
    });
    const deviceKey = generateKeyPair();
    const deviceId = store.devices.addMobile({
      name: "Test phone",
      publicKey: toBase64Url(deviceKey.publicKey),
      platform: "ios",
      offerId: "test",
    });
    store.devices.activate(deviceId);

    let losing = false;
    /** The host's end of the socket: once losing, the next record the host
     * sends is dropped and the connection dies with it in flight. */
    const lossy = (socket: FrameSocket): FrameSocket => {
      const wrapper: FrameSocket = {
        onFrame: null,
        onClose: null,
        get bufferedAmount() {
          return socket.bufferedAmount;
        },
        send(frame) {
          if (losing) socket.close(1006, "connection lost");
          else socket.send(frame);
        },
        close: (code, reason) => socket.close(code, reason),
      };
      socket.onFrame = (frame) => wrapper.onFrame?.(frame);
      socket.onClose = (code, reason) => wrapper.onClose?.(code, reason);
      return wrapper;
    };
    let counter = 0;
    const connect = async (wrap: (socket: FrameSocket) => FrameSocket = (socket) => socket) => {
      const [phoneSide, hostSide] = memorySocketPair();
      new ChannelConnection(wrap(hostSide), host, "direct", "test");
      const { channel } = await openChannel(phoneSide, {
        env: store.environmentId,
        hostKey: toBase64Url(keys.host.publicKey),
        deviceKey,
        hello: {
          v: 1,
          env: store.environmentId,
          n: ++counter,
          channel: { min: 1, max: 1 },
          app: { name: "MonoCode", version: "0.1.0", build: "1", platform: "ios", os: "18.7" },
          caps: ["deflate"],
          providers: ["codex"],
        },
      });
      cleanups.push(() => channel.close());
      return channel;
    };

    s.stage(1);
    const first = await connect(lossy);
    losing = true;
    await expect(first.request("git.action", s.commit(), { key: "channel-commit", timeoutMs: 5_000 })).rejects.toMatchObject({
      code: "offline",
      retryable: true,
    });
    // The host committed; only its answer was lost.
    await vi.waitFor(() => expect(receipts(store)).toEqual([{ key: "channel-commit", method: "git.action" }]));
    expect(s.commits()).toBe(2);

    s.stage(2);
    const second = await connect();
    await expect(second.request("git.action", s.commit(), { key: "channel-commit" })).resolves.toBeNull();
    expect(s.commits()).toBe(2);
    expect(s.staged()).toBe("app.ts");
    expect(ran("commit")).toHaveLength(1);
  });

  it("gives push its own timeout, inside the phone's 120 s deadline", async () => {
    const s = await setup();
    s.stage(1);
    await s.host.rpc.dispatch("git.action", s.commit(), phone());
    await s.host.rpc.dispatch("git.action", s.push(), phone());
    expect(s.pushes()).toBe(1);
    expect(ran("commit").map((run) => run.timeout)).toEqual([10_000]);
    const [push] = ran("push");
    expect(push.timeout).toBe(110_000);
    // 06 §6.4: the phone waits 120 s for git.action with push.
    expect(push.timeout).toBeLessThan(120_000);
  });
});
