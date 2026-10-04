// The bundled host process end to end: a client pairs over a real WebSocket
// through the CLI's lifecycle endpoint, reconnects as a device, and is cut
// off when the CLI revokes it.
import { afterEach, expect, it } from "vitest";
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
