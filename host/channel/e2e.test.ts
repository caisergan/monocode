// The bundled host process end to end: a client pairs over a real WebSocket
// through the CLI's lifecycle endpoint, reconnects as a device, and is cut
// off when the CLI revokes it.
import { afterEach, expect, it, vi } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import {
  confirmationCode,
  fromBase64Url,
  generateKeyPair,
  openChannel,
  openWebSocket,
  pairingProof,
  parseOfferLink,
  type Hello,
  type KeyPair,
  type WebSocketLike,
  type Welcome,
} from "@monocode/channel";

const exec = promisify(execFile);
const cli = resolve("build/host/monocode-host.mjs");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

// Tests never inherit the pre-push hook's GIT_* variables.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

it("pairs, reconnects and is revoked against the real host process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "monocode-e2e-"));
  const rpcPort = await freePort();
  const directPort = await freePort();
  writeFileSync(
    join(directory, "config.json"),
    JSON.stringify({ v: 1, direct: { mode: "all", port: directPort, advertise: [{ addr: "127.0.0.1", port: directPort }] } }),
  );
  const host: ChildProcess = spawn(process.execPath, [cli, "serve", "--data-dir", directory, "--port", String(rpcPort)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  host.stdout!.on("data", (chunk) => (output += chunk));
  host.stderr!.on("data", (chunk) => (output += chunk));
  cleanups.push(async () => {
    host.kill("SIGTERM");
    await new Promise((done) => host.once("exit", done));
    rmSync(directory, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !output.includes("Host fingerprint"); i++) await new Promise((done) => setTimeout(done, 100));
  expect(output).toContain("Host fingerprint");
  const running = JSON.parse(readFileSync(join(directory, "running.json"), "utf8")) as { secret: string };
  const lifecycle = async (action: string, params?: object) => {
    const response = await fetch(`http://127.0.0.1:${rpcPort}/lifecycle`, {
      method: "POST",
      headers: { Authorization: `Bearer ${running.secret}` },
      body: JSON.stringify({ action, params }),
    });
    expect(response.status).toBe(200);
    return response.json();
  };

  const created = (await lifecycle("pairing.create", { ttlSeconds: 120 })) as { offerId: string; url: string };
  const offer = parseOfferLink(created.url);
  expect(offer.direct).toContainEqual({ kind: "manual", addr: "127.0.0.1", port: directPort });
  const connect = async (deviceKey: KeyPair, hello: Partial<Hello>) => {
    const socket = await openWebSocket(() => new WebSocket(`ws://127.0.0.1:${directPort}/v1/channel`) as unknown as WebSocketLike, {
      timeoutMs: 3_000,
    });
    return openChannel(socket, {
      env: offer.env,
      hostKey: offer.key,
      deviceKey,
      hello: {
        v: 1,
        env: offer.env,
        n: 0,
        channel: { min: 1, max: 1 },
        app: { name: "MonoCode", version: "0.1.0", build: "1", platform: "ios", os: "18.7" },
        caps: ["deflate"],
        providers: ["codex", "claude"],
        ...hello,
      },
    });
  };

  const deviceKey = generateKeyPair();
  const pairing = await connect(deviceKey, { pair: { offer: offer.offer } });
  const approved = new Promise<Welcome>((done) =>
    pairing.channel.onEvent((event, data) => {
      if (event === "pair.status") done((data as { welcome: Welcome }).welcome);
    }),
  );
  const claim = await pairing.channel.request<{ code: string; status: string }>("pair.claim", {
    offer: offer.offer,
    proof: Buffer.from(pairingProof(fromBase64Url(offer.secret), pairing.channel.handshakeHash)).toString("base64url"),
    name: "Test phone",
    platform: "ios",
    appVersion: "0.1.0",
  });
  expect(claim).toMatchObject({ status: "pending", code: confirmationCode(pairing.channel.handshakeHash) });
  expect(await lifecycle("pairing.status", { offerId: created.offerId })).toMatchObject({ status: "claimed", code: claim.code });
  await lifecycle("pairing.decide", { offerId: created.offerId, allow: true });
  const welcome = await approved;
  expect(welcome.device.name).toBe("Test phone");
  pairing.channel.close();

  const device = await connect(deviceKey, { n: 1 });
  expect(device.reply).toMatchObject({ ok: true, device: { id: welcome.device.id } });
  await expect(device.channel.request("projects.list")).resolves.toEqual([]);
  await expect(device.channel.request("inbox.list")).resolves.toMatchObject({ items: [], truncated: false });

  const closed = new Promise<{ bye?: string }>((done) => device.channel.onClose(done));
  await exec(process.execPath, [cli, "revoke", welcome.device.id, "--data-dir", directory, "--port", String(rpcPort)], { env });
  expect((await closed).bye).toBe("device_revoked");
  await expect(connect(deviceKey, { n: 2 })).rejects.toMatchObject({ code: "device_revoked", authenticated: true });
  expect(existsSync(join(directory, "keys.json"))).toBe(true);
}, 30_000);

it("moves the phone listener when an admin changes host.config, and doctor sees it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "monocode-e2e-config-"));
  const rpcPort = await freePort();
  const before = await freePort();
  const after = await freePort();
  writeFileSync(
    join(directory, "config.json"),
    JSON.stringify({ v: 1, direct: { mode: "all", port: before, advertise: [{ addr: "127.0.0.1", port: before }] } }),
  );
  const host: ChildProcess = spawn(process.execPath, [cli, "serve", "--data-dir", directory, "--port", String(rpcPort)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  host.stdout!.on("data", (chunk) => (output += chunk));
  host.stderr!.on("data", (chunk) => (output += chunk));
  cleanups.push(async () => {
    host.kill("SIGTERM");
    await new Promise((done) => host.once("exit", done));
    rmSync(directory, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !output.includes("Host fingerprint"); i++) await new Promise((done) => setTimeout(done, 100));
  expect(output).toContain("Host fingerprint");
  const cliArgs = ["--data-dir", directory, "--port", String(rpcPort)];
  const running = JSON.parse(readFileSync(join(directory, "running.json"), "utf8")) as { secret: string };
  const lifecycle = async (action: string, params?: object) => {
    const response = await fetch(`http://127.0.0.1:${rpcPort}/lifecycle`, {
      method: "POST",
      headers: { Authorization: `Bearer ${running.secret}` },
      body: JSON.stringify({ action, params }),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  const desktop = JSON.parse((await exec(process.execPath, [cli, "pair", "--name", "Desktop", "--json", ...cliArgs], { env })).stdout) as {
    token: string;
    environmentId: string;
  };
  const rpc = async (method: string, params: object) => {
    const response = await fetch(`http://127.0.0.1:${rpcPort}/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${desktop.token}` },
      body: JSON.stringify({ version: 1, method, params, environmentId: desktop.environmentId }),
    });
    return (await response.json()) as { result?: unknown; error?: string; code?: string };
  };

  const created = (await lifecycle("pairing.create", { ttlSeconds: 120 })) as { offerId: string; url: string };
  const offer = parseOfferLink(created.url);
  const connect = async (port: number, deviceKey: KeyPair, hello: Partial<Hello>) => {
    const socket = await openWebSocket(() => new WebSocket(`ws://127.0.0.1:${port}/v1/channel`) as unknown as WebSocketLike, {
      timeoutMs: 3_000,
    });
    return openChannel(socket, {
      env: offer.env,
      hostKey: offer.key,
      deviceKey,
      hello: {
        v: 1,
        env: offer.env,
        n: 0,
        channel: { min: 1, max: 1 },
        app: { name: "MonoCode", version: "0.1.0", build: "1", platform: "ios", os: "18.7" },
        caps: ["deflate"],
        providers: ["codex", "claude"],
        ...hello,
      },
    });
  };
  const deviceKey = generateKeyPair();
  const pairing = await connect(before, deviceKey, { pair: { offer: offer.offer } });
  const approved = new Promise<Welcome>((done) =>
    pairing.channel.onEvent((event, data) => {
      if (event === "pair.status") done((data as { welcome: Welcome }).welcome);
    }),
  );
  await pairing.channel.request("pair.claim", {
    offer: offer.offer,
    proof: Buffer.from(pairingProof(fromBase64Url(offer.secret), pairing.channel.handshakeHash)).toString("base64url"),
    name: "Test phone",
    platform: "ios",
    appVersion: "0.1.0",
  });
  await lifecycle("pairing.decide", { offerId: created.offerId, allow: true });
  const welcome = await approved;
  expect(welcome.capabilities).toEqual(expect.arrayContaining(["host.config", "presence", "sessions.queue"]));
  const phone = pairing.channel;
  const configEvents: { direct: { port: number } }[] = [];
  phone.onEvent((event, data) => {
    if (event === "host.config") configEvents.push(data as { direct: { port: number } });
  });
  await expect(phone.request("host.config.get")).resolves.toMatchObject({
    direct: { mode: "all", port: before, listening: ["::"] },
  });
  await expect(phone.request("host.config.set", { direct: { port: after } })).rejects.toMatchObject({ code: "forbidden" });

  const changed = await rpc("host.config.set", { direct: { port: after, advertise: [{ addr: "127.0.0.1", port: after }] } });
  expect(changed.result).toMatchObject({ direct: { mode: "all", port: after, listening: ["::"] } });
  await expect(rpc("host.config.set", { direct: { port: rpcPort } })).resolves.toMatchObject({ code: "invalid_params" });
  await expect(rpc("presence.update", { visible: true })).resolves.toEqual({ result: {} });
  // The open channel stays up and hears about the change.
  await vi.waitFor(() => expect(configEvents.at(-1)?.direct.port).toBe(after));
  expect(JSON.parse(readFileSync(join(directory, "config.json"), "utf8")).direct.port).toBe(after);
  const moved = await connect(after, deviceKey, { n: 1 });
  expect(moved.reply).toMatchObject({ ok: true, device: { id: welcome.device.id } });
  moved.channel.close();
  await expect(connect(before, deviceKey, { n: 2 })).rejects.toThrow();

  const doctor = JSON.parse((await exec(process.execPath, [cli, "doctor", "--json", ...cliArgs], { env })).stdout) as {
    checks: { id: string; status: string; detail: string }[];
  };
  const checks = Object.fromEntries(doctor.checks.map((check) => [check.id, check]));
  expect(checks.host.status).toBe("ok");
  expect(checks.version.status).toBe("ok");
  expect(checks.database).toMatchObject({ status: "ok", detail: "Schema version 1" });
  expect(checks.listeners).toMatchObject({ status: "ok", detail: `RPC 127.0.0.1:${rpcPort}, phones 127.0.0.1:${after}` });
  phone.close();
}, 30_000);
