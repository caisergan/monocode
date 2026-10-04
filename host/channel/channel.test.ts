import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HandshakeFailure,
  confirmationCode,
  generateKeyPair,
  memorySocketPair,
  openChannel,
  pairingProof,
  fromBase64Url,
  toBase64Url,
  type Channel,
  type Hello,
  type KeyPair,
  type PairingWelcome,
  type Welcome,
} from "@monocode/channel";
import { applySessionSync, type HostSession } from "@monocode/core/session";
import type { InboxList, WindowedSync } from "@monocode/core/wire";
import type { SendTurnInput } from "../../src/integrations/harness/core/types";
import type { HostProvider } from "../providers";
import { HostEngine } from "../engine";
import { HostStore } from "../store";
import { loadOrCreateKeys } from "../keys";
import { PairingManager } from "../pairing";
import { createHostRpc } from "../rpc";
import { ChannelConnection, type ChannelHost } from "./connection";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-channel-test-"));
  const store = new HostStore(join(directory, "host.db"));
  const project = store.addProject(directory, "Test");
  const turns: { input: SendTurnInput; finish: () => void }[] = [];
  const provider: HostProvider = {
    send: vi.fn(
      (input) =>
        new Promise<void>((resolve) => {
          turns.push({ input, finish: resolve });
        }),
    ),
    cancel: vi.fn(async () => turns.at(-1)?.finish()),
    stop: vi.fn(async () => turns.at(-1)?.finish()),
    bind: vi.fn(),
    approve: vi.fn(),
    answer: vi.fn(),
  };
  const engine = new HostEngine(store, { codex: provider });
  const keys = loadOrCreateKeys(directory);
  const rpc = createHostRpc(engine, ["codex"]);
  const pairing = new PairingManager(store.devices, {
    environmentId: store.environmentId,
    name: () => "test-host",
    hostKey: keys.host.publicKey,
    fingerprint: keys.fingerprint,
    endpoints: () => [{ kind: "lan", addr: "192.168.1.20", port: 3775 }],
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
    endpoints: () => [{ kind: "lan", addr: "192.168.1.20", port: 3775 }],
    register: (connection) => connections.add(connection),
    unregister: (connection) => connections.delete(connection),
  };
  const stop = store.onChange((change) => {
    for (const connection of connections) connection.sessionChanged(change);
  });
  cleanups.push(async () => {
    stop();
    for (const connection of connections) connection.close();
    pairing.close();
    await engine.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  let counter = 0;
  const hello = (overrides: Partial<Hello> = {}): Hello => ({
    v: 1,
    env: store.environmentId,
    n: ++counter,
    channel: { min: 1, max: 1 },
    app: { name: "MonoCode", version: "0.1.0", build: "1", platform: "ios", os: "18.7", model: "iPhone14,5" },
    caps: ["deflate", "windowedSync", "truncatedBlocks"],
    providers: ["codex", "claude"],
    ...overrides,
  });
  const connect = (deviceKey: KeyPair, overrides: Partial<Hello> = {}, hostKey = keys.host.publicKey) => {
    const [phone, side] = memorySocketPair();
    new ChannelConnection(side, host, "direct", "test");
    return openChannel(phone, {
      env: overrides.env ?? store.environmentId,
      hostKey: toBase64Url(hostKey),
      deviceKey,
      hello: hello(overrides),
    });
  };

  /** Pairs a fresh phone and returns its approved channel. */
  const pair = async () => {
    const created = pairing.create({ createdBy: "local" });
    const deviceKey = generateKeyPair();
    const { channel, reply } = await connect(deviceKey, { n: 0, pair: { offer: created.offerId } });
    expect((reply as PairingWelcome).pairing.offer).toBe(created.offerId);
    const approved = new Promise<Welcome>((resolve) =>
      channel.onEvent((event, data) => {
        const status = data as { status: string; welcome?: Welcome };
        if (event === "pair.status" && status.status === "approved") resolve(status.welcome!);
      }),
    );
    const claim = await channel.request<{ status: string; code: string; deviceId: string }>("pair.claim", {
      offer: created.offerId,
      proof: toBase64Url(pairingProof(fromBase64Url(created.offer.secret), channel.handshakeHash)),
      name: "Ege's iPhone",
      platform: "ios",
      model: "iPhone14,5",
      appVersion: "0.1.0",
    });
    expect(claim.status).toBe("pending");
    expect(claim.code).toBe(confirmationCode(channel.handshakeHash));
    expect(pairing.status(created.offerId)).toMatchObject({ status: "claimed", code: claim.code });
    pairing.decide(created.offerId, true, "local");
    const welcome = await approved;
    return { channel, welcome, deviceKey, deviceId: claim.deviceId };
  };

  const session = () =>
    engine.command({
      type: "create",
      commandId: crypto.randomUUID(),
      projectId: project.id,
      harness: "codex",
      model: "codex:test",
      runtimeMode: "supervised",
    }).sessionId;

  return { store, engine, rpc, pairing, keys, connect, pair, session, turns, project, provider };
}

const events = (channel: Channel) => {
  const seen: { event: string; data: unknown }[] = [];
  channel.onEvent((event, data) => seen.push({ event, data }));
  return seen;
};

describe("phone channel", () => {
  it("pairs a phone with a confirmed code, then serves it on the same channel", async () => {
    const s = setup();
    const { channel, welcome, deviceId } = await s.pair();
    expect(welcome.device).toMatchObject({ id: deviceId, name: "Ege's iPhone", role: "member" });
    expect(welcome.capabilities).toEqual(expect.arrayContaining(["channel.watch", "inbox", "sessions.window"]));
    expect(welcome.providers).toEqual(["codex"]);
    await expect(channel.request("projects.list")).resolves.toEqual([s.project]);
    // Members cannot create pairing offers or see other devices.
    s.store.issueDevice("Laptop");
    await expect(channel.request("devices.list")).resolves.toHaveLength(1);
    await expect(channel.request("devices.events")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("reconnects as a device and rejects replays, strangers and revoked phones", async () => {
    const s = setup();
    const { channel, deviceKey, deviceId } = await s.pair();
    channel.close();
    const again = await s.connect(deviceKey, { n: 41 });
    expect(again.reply).toMatchObject({ ok: true, device: { id: deviceId } });
    again.channel.close();
    await expect(s.connect(deviceKey, { n: 41 })).rejects.toMatchObject({
      code: "replayed_handshake",
      authenticated: true,
    });
    await expect(s.connect(generateKeyPair())).rejects.toMatchObject({ code: "unknown_device", authenticated: true });
    // A key made for another host fails to decrypt: an unauthenticated reject.
    await expect(s.connect(deviceKey, {}, generateKeyPair().publicKey)).rejects.toMatchObject({
      code: "handshake_failed",
      authenticated: false,
    });
    s.store.devices.revoke(deviceId);
    await expect(s.connect(deviceKey)).rejects.toMatchObject({ code: "device_revoked" });
  });

  it("rejects a wrong proof three times, then cancels the code", async () => {
    const s = setup();
    const created = s.pairing.create({ createdBy: "local" });
    for (let attempt = 0; attempt < 3; attempt++) {
      const { channel } = await s.connect(generateKeyPair(), { n: 0, pair: { offer: created.offerId } });
      await expect(
        channel.request("pair.claim", {
          offer: created.offerId,
          proof: toBase64Url(new Uint8Array(32)),
          name: "Thief",
          platform: "ios",
          appVersion: "1",
        }),
      ).rejects.toMatchObject({ code: "pairing_proof_invalid" });
      channel.close();
    }
    expect(s.pairing.status(created.offerId).status).toBe("cancelled");
    const failure = await s
      .connect(generateKeyPair(), { n: 0, pair: { offer: created.offerId } })
      .catch((error) => error);
    expect(failure).toBeInstanceOf(HandshakeFailure);
    expect(failure.code).toBe("pairing_expired");
  });

  it("tells a waiting phone when the computer denies it", async () => {
    const s = setup();
    const created = s.pairing.create({ createdBy: "local" });
    const { channel } = await s.connect(generateKeyPair(), { n: 0, pair: { offer: created.offerId } });
    const seen = events(channel);
    const closed = new Promise((resolve) => channel.onClose(resolve));
    await channel.request("pair.claim", {
      offer: created.offerId,
      proof: toBase64Url(pairingProof(fromBase64Url(created.offer.secret), channel.handshakeHash)),
      name: "Phone",
      platform: "android",
      appVersion: "1",
    });
    s.pairing.decide(created.offerId, false, "local");
    await closed;
    expect(seen).toContainEqual({ event: "pair.status", data: { status: "denied" } });
    expect(s.store.devices.list()).toEqual([]);
  });

  it("pushes windowed deltas that rebuild the host's transcript exactly", async () => {
    const s = setup();
    const { channel } = await s.pair();
    const id = s.session();
    // Three earlier turns, so a two-turn window leaves history behind.
    for (let turn = 0; turn < 3; turn++) {
      s.engine.command({ type: "send", commandId: `old-${turn}`, sessionId: id, text: `Turn ${turn}` });
      await vi.waitFor(() => expect(s.turns).toHaveLength(turn + 1));
      s.turns[turn].input.onEvent({ type: "message.delta", text: `Answer ${turn}` });
      s.turns[turn].finish();
      await vi.waitFor(() => expect(s.store.session(id).status).toBe("idle"));
    }
    let local: HostSession | undefined;
    let window: WindowedSync["window"];
    const syncs: WindowedSync[] = [];
    channel.onEvent((event, data) => {
      if (event !== "session.sync") return;
      const { sync } = data as { sync: WindowedSync };
      syncs.push(sync);
      window = sync.window ?? window;
      local = applySessionSync(local, sync as never);
    });
    await channel.request("watch.set", { sessions: [{ id, window: { tailTurns: 2 } }] });
    await vi.waitFor(() => expect(syncs[0]?.kind).toBe("snapshot"));
    expect(window).toMatchObject({ olderTurns: 1 });
    const texts = local!.session.blocks.map((block) => block.text);
    expect(texts[0]).toBe("Turn 1");
    expect(texts).toContain("Answer 2");
    expect(texts).not.toContain("Turn 0");

    s.engine.command({ type: "send", commandId: "live", sessionId: id, text: "Go" });
    await vi.waitFor(() => expect(s.turns).toHaveLength(4));
    const live = s.turns[3].input;
    live.onEvent({ type: "message.delta", text: "Working" });
    live.onEvent({ type: "approval.requested", requestId: 7, title: "Run npm test", kind: "execute" });
    await vi.waitFor(() =>
      expect(local?.session.blocks.some((block) => block.approval?.requestId === 7)).toBe(true),
    );
    expect(syncs.slice(1).every((sync) => sync.kind === "delta")).toBe(true);
    const host = s.store.windowedSync(id, undefined, { anchor: window!.anchor! });
    expect(host.kind).toBe("snapshot");
    expect(local!.session.blocks).toEqual((host as { value: HostSession }).value.session.blocks);
    expect(local!.revision).toBe(s.store.session(id).revision);

    // The inbox ranks the approval first and the phone can act on it.
    const inbox = await channel.request<InboxList>("inbox.list");
    expect(inbox.items[0]).toMatchObject({
      sessionId: id,
      attention: "approval",
      approval: { requestId: 7, title: "Run npm test" },
      needsInput: true,
    });
    await channel.request("commands.dispatch", {
      type: "approve",
      commandId: "approve-7",
      sessionId: id,
      runId: s.store.session(id).runId,
      requestId: 7,
      decision: "allow",
    });
    expect(s.provider.approve).toHaveBeenCalledWith(id, 7, "allow");
    await vi.waitFor(() =>
      expect(local?.session.blocks.find((block) => block.approval?.requestId === 7)?.approval?.decided).toBe("allow"),
    );
    s.turns[3].finish();
    await vi.waitFor(() => expect(local?.status).toBe("idle"));
    const after = await channel.request<InboxList>("inbox.list");
    expect(after.items[0]).toMatchObject({ attention: "finished", lastText: "Working" });
  });

  it("honours idempotency keys, queue commands and presence on the channel", async () => {
    const s = setup();
    const { channel, welcome, deviceId } = await s.pair();
    expect(welcome.capabilities).toEqual(
      expect.arrayContaining(["mutations.idempotent", "sessions.queue", "sessions.createWithPrompt", "presence"]),
    );
    // No config store in this host, so no host.config methods to advertise.
    expect(welcome.capabilities).not.toContain("host.config");
    const id = s.session();
    const rename = { projectId: s.project.id, sessionId: id, title: "Renamed" };
    const first = await channel.request("sessions.update", rename, { key: "rename-1" });
    const revision = s.store.session(id).revision;
    await expect(channel.request("sessions.update", rename, { key: "rename-1" })).resolves.toEqual(first);
    expect(s.store.session(id).revision).toBe(revision);
    await expect(
      channel.request("sessions.update", { ...rename, title: "Other" }, { key: "rename-1" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict", retryable: false });

    await channel.ping({ visible: true, focusedSessionId: id });
    expect(s.rpc.presence.watching(id, 60_000)).toEqual([deviceId]);
    await channel.request("presence.update", { visible: false });
    expect(s.rpc.presence.isPresent(deviceId)).toBe(false);
    await expect(channel.request("presence.update", { visible: "yes" })).rejects.toMatchObject({
      code: "invalid_params",
    });

    await channel.request("commands.dispatch", { type: "send", commandId: "go", sessionId: id, text: "Go" });
    await vi.waitFor(() => expect(s.turns).toHaveLength(1));
    await channel.request("commands.dispatch", { type: "queue", commandId: "next", sessionId: id, text: "Next" });
    s.turns[0].finish();
    await vi.waitFor(() => expect(s.turns).toHaveLength(2));
    expect(s.turns[1].input.text).toBe("Next");
    s.turns[1].finish();
    await vi.waitFor(() => expect(s.store.session(id).status).toBe("idle"));

    // A closed channel clears its device's presence.
    await channel.ping({ visible: true });
    expect(s.rpc.presence.isPresent(deviceId)).toBe(true);
    channel.close();
    await vi.waitFor(() => expect(s.rpc.presence.get(deviceId)).toBeUndefined());
  });

  it("sends inbox and project hints instead of polling", async () => {
    const s = setup();
    const { channel } = await s.pair();
    const seen = events(channel);
    await channel.request("watch.set", { inbox: true, projects: [s.project.id] });
    const id = s.session();
    await vi.waitFor(() => {
      expect(seen.map((entry) => entry.event)).toContain("inbox.changed");
      expect(seen).toContainEqual({ event: "project.sessions", data: { projectId: s.project.id } });
    });
    const page = await channel.request<{ items: { id: string; repo: string }[] }>("sessions.page", {
      projectId: s.project.id,
    });
    expect(page.items).toEqual([expect.objectContaining({ id, repo: "Test" })]);
  });
});
