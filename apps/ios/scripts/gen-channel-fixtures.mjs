#!/usr/bin/env node
// @monocode/channel → golden fixtures for MonoChannel (16 §16.5). It runs the
// TypeScript in packages/channel/src and writes, into MonoChannel's test
// resources (Tests/MonoChannelTests/Fixtures):
//
//   cacophony-ik.json  the Noise vectors, copied from packages/channel/src/vectors
//   snow-ik.json
//   records.json       records at the boundary sizes (0, 1, MAX_FRAGMENT and one
//                      more), maybeCompress over compressible, short and
//                      incompressible payloads, compressed records that span
//                      fragments, and a deflate bomb
//   offers.json        encodeOfferLink for every link base, and parseOfferLink
//                      over valid offers and every rule of 04 §4.2
//   pairing.json       proofs, confirmation codes, fingerprints, key hashes,
//                      base64url and Crockford encodings
//   envelopes.json     the prologue, frame kinds, hellos, handshake replies and
//                      every client and host message kind
//   handshake.json     a full IK handshake with fixed static and ephemeral keys,
//                      then transport frames both ways: the phone's through the
//                      priority queues, the host's compressed and fragmented
//
// The output is deterministic (fixed keys, no clock, no randomness), so CI can
// regenerate it and fail on a diff. `--check` does that comparison instead of
// writing.

import { createHash } from "node:crypto";
import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const channelSrc = join(repo, "packages/channel/src");
const packages = join(here, "../Packages");
const fixtures = join(packages, "MonoChannel/Tests/MonoChannelTests/Fixtures");

const ENV = "6f0b1f8e-3c2a-4a59-9a77-5d1c2b0f4e11";

async function loadChannel() {
  const result = await build({
    entryPoints: [join(channelSrc, "index.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "error",
    // Honour NODE_PATH as Node does; empty, the repo's node_modules resolve.
    nodePaths: process.env.NODE_PATH ? process.env.NODE_PATH.split(delimiter) : [],
  });
  const file = join(tmpdir(), `monocode-channel-fixtures-${process.pid}.mjs`);
  await writeFile(file, result.outputFiles[0].text);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    await rm(file);
  }
}

const ch = await loadChannel();
const { toBase64Url: b64, toHex: hex, utf8 } = ch;

/** Fixed key material: SHA-256 of a label. */
const seed = (label) => new Uint8Array(createHash("sha256").update(label).digest());

/** A deterministic byte pattern. */
const pattern = (length, salt) => Uint8Array.from({ length }, (_, i) => (i * 31 + salt) & 0xff);

/** Bytes from a linear congruential generator: incompressible, but fixed. */
function noise(length, state = 1) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

/** JSON that compresses, but not to nothing: numbers from the generator. */
function numbersJson(count, state = 7) {
  const numbers = [];
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    numbers.push(state % 100_000);
  }
  return JSON.stringify({ t: "res", id: 9, ok: true, r: { numbers } });
}

// ── Records ────────────────────────────────────────────────────────────────

function records() {
  const boundaries = [0, 1, ch.MAX_FRAGMENT, ch.MAX_FRAGMENT + 1].map((size, index) => {
    const msgId = [0, 1, 0x01020304, 0xffffffff][index];
    return {
      size,
      msgId,
      salt: size & 0xff,
      records: ch.encodeRecords(msgId, ch.RECORD_JSON, pattern(size, size & 0xff)).map(b64),
    };
  });
  const repeated = JSON.stringify({ blocks: Array(500).fill("the same words again") });
  const payloads = [
    { name: "short", msgId: 3, text: JSON.stringify({ t: "pong", ts: 1, now: 2 }) },
    { name: "compressible", msgId: 4, text: repeated },
    { name: "just-under", msgId: 5, text: "x".repeat(ch.COMPRESS_MIN - 1) },
    { name: "at-minimum", msgId: 6, text: "x".repeat(ch.COMPRESS_MIN) },
    { name: "spanning", msgId: 7, text: numbersJson(30_000) },
  ];
  const compressed = payloads.map(({ name, msgId, text }) => {
    const { type, payload } = ch.maybeCompress(utf8(text));
    return {
      name,
      msgId,
      json: text,
      type,
      records: ch.encodeRecords(msgId, type, payload).map(b64),
    };
  });
  const random = noise(4096);
  const incompressible = { bytes: b64(random), type: ch.maybeCompress(random).type };
  const bombSize = 4 * 1024 * 1024;
  const bomb = ch.maybeCompress(new Uint8Array(bombSize));
  if (bomb.type !== ch.RECORD_DEFLATE) throw new Error("The bomb did not compress");
  return {
    constants: {
      maxNoiseMessage: ch.MAX_NOISE_MESSAGE,
      tagLength: ch.TAG_LEN,
      recordHeader: ch.RECORD_HEADER,
      maxFragment: ch.MAX_FRAGMENT,
      maxMessage: ch.MAX_MESSAGE,
      compressMin: ch.COMPRESS_MIN,
    },
    boundaries,
    compressed,
    incompressible,
    bomb: { size: bombSize, deflate: b64(bomb.payload) },
  };
}

// ── Offers ─────────────────────────────────────────────────────────────────

const OFFER = {
  v: 1,
  env: ENV,
  name: "mac-mini",
  key: b64(seed("offer/key")),
  offer: b64(seed("offer/id").subarray(0, 16)),
  secret: b64(seed("offer/secret")),
  exp: 1_760_000_599,
  direct: [
    { kind: "lan", addr: "192.168.1.20", port: 3775 },
    { kind: "tailscale", addr: "100.101.12.7", port: 3775, dns: "mac-mini.tail1234.ts.net" },
    { kind: "manual", addr: "dev.example.com", port: 443 },
  ],
  relay: { url: "wss://relay.usemono.dev", room: "Q2hhbm5lbFJvb20" },
  ui: { theme: "dark", hue: 240, sat: 0, dark: 9, accent: "#4da3f5" },
};

const LINK_BASES = ["https://usemono.dev/pair", "monocode://pair", "monocode-dev://pair"];

function offers() {
  const encode = (value) => b64(utf8(JSON.stringify(value)));
  const link = (value) => `monocode-dev://pair#o=${encode(value)}`;
  const without = (key) => {
    const copy = { ...OFFER };
    delete copy[key];
    return copy;
  };
  const endpoint = (entry) => link({ ...OFFER, direct: [entry], relay: undefined });
  const cases = [
    // Valid forms
    ["full offer", link(OFFER)],
    ["https link", `https://usemono.dev/pair#o=${encode(OFFER)}`],
    ["bare encoded offer", encode(OFFER)],
    ["other fragment parameters", `monocode://pair#x=1&o=${encode(OFFER)}&y=2`],
    ["surrounding whitespace", `  \n${link(OFFER)}\t `],
    ["standard base64 alphabet", `monocode://pair#o=${Buffer.from(JSON.stringify(OFFER)).toString("base64")}`],
    ["direct only", link({ ...OFFER, relay: undefined, ui: undefined })],
    ["relay only", link({ ...OFFER, direct: undefined })],
    ["empty direct with relay", link({ ...OFFER, direct: [] })],
    ["name trimmed and cut at 64", link({ ...OFFER, name: `  ${"n".repeat(80)}  ` })],
    ["blank name", link({ ...OFFER, name: "   " })],
    ["missing name", link(without("name"))],
    ["name not a string", link({ ...OFFER, name: 7 })],
    ["unknown endpoint kind skipped", link({ ...OFFER, direct: [...OFFER.direct, { kind: "carrier-pigeon" }] })],
    ["non-object endpoints skipped", link({ ...OFFER, direct: [null, 3, "lan", [], ...OFFER.direct] })],
    ["only the first 8 endpoints", link({
      ...OFFER,
      direct: Array.from({ length: 10 }, (_, i) => ({ kind: "lan", addr: `10.0.0.${i}`, port: 3000 + i })),
    })],
    ["ninth endpoint invalid but ignored", link({
      ...OFFER,
      direct: [...Array.from({ length: 8 }, () => OFFER.direct[0]), { kind: "lan", addr: "a b", port: 0 }],
    })],
    ["tailscale dns dropped when invalid", endpoint({ kind: "tailscale", addr: "100.1.1.1", port: 1, dns: "bad host" })],
    ["dns ignored on lan", endpoint({ kind: "lan", addr: "10.0.0.1", port: 1, dns: "x.example" })],
    ["ipv6 literal", endpoint({ kind: "manual", addr: "fd7a:115c:a1e0::1", port: 65535 })],
    ["ipv4 mapped ipv6", endpoint({ kind: "manual", addr: "::ffff:192.168.1.1", port: 1 })],
    ["uppercase hostname", endpoint({ kind: "manual", addr: "Dev.Example.COM", port: 80 })],
    ["uppercase uuid", link({ ...OFFER, env: ENV.toUpperCase() })],
    ["fractional exp", link({ ...OFFER, exp: 1760000599.5 })],
    ["port written as a whole float", `monocode://pair#o=${b64(utf8(
      JSON.stringify({ ...OFFER, relay: undefined, direct: [OFFER.direct[0]] }).replace('"port":3775', '"port":3775.0'),
    ))}`],
    ["ui passed through unchecked", link({ ...OFFER, ui: { theme: "neon", extra: [1, 2] } })],
    ["ui array passed through", link({ ...OFFER, ui: [1, 2] })],
    ["ui null dropped", link({ ...OFFER, ui: null })],
    ["ui string dropped", link({ ...OFFER, ui: "dark" })],
    ["insecure relay allowed", link({ ...OFFER, relay: { url: "ws://relay.local", room: "r" } }), true],
    ["unknown fields ignored", link({ ...OFFER, future: { a: 1 } })],
    // Rejected
    ["not a link", "https://example.com"],
    ["empty text", ""],
    ["empty o parameter", "monocode://pair#o="],
    ["o without a value", "monocode://pair#o"],
    ["fragment without o", "monocode://pair#x=1"],
    ["invalid base64", "monocode://pair#o=a$b"],
    ["base64 length 1 mod 4", "monocode://pair#o=abcde"],
    ["not JSON", `monocode://pair#o=${b64(utf8("not json"))}`],
    ["invalid UTF-8", `monocode://pair#o=${b64(Uint8Array.of(0x7b, 0xff, 0x7d))}`],
    ["JSON array", link([OFFER])],
    ["JSON null", link(null)],
    ["over 4 KiB", link({ ...OFFER, name: "n".repeat(5000) })],
    ["version 2", link({ ...OFFER, v: 2 })],
    ["version as a string", link({ ...OFFER, v: "1" })],
    ["version missing", link(without("v"))],
    ["version 2 with bad fields", link({ v: 2 })],
    ["env not a uuid", link({ ...OFFER, env: "not-a-uuid" })],
    ["env missing", link(without("env"))],
    ["key short", link({ ...OFFER, key: "short" })],
    ["key 31 bytes", link({ ...OFFER, key: b64(seed("k").subarray(0, 31)) })],
    ["secret 33 bytes", link({ ...OFFER, secret: b64(new Uint8Array(33)) })],
    ["offer id 32 bytes", link({ ...OFFER, offer: b64(new Uint8Array(32)) })],
    ["key not a string", link({ ...OFFER, key: 5 })],
    ["exp missing", link(without("exp"))],
    ["exp a string", link({ ...OFFER, exp: "1760000599" })],
    ["direct not an array", link({ ...OFFER, direct: { kind: "lan" } })],
    ["direct null", link({ ...OFFER, direct: null })],
    ["neither direct nor relay", link({ ...OFFER, direct: undefined, relay: undefined })],
    ["only unknown endpoints", link({ ...OFFER, relay: undefined, direct: [{ kind: "carrier-pigeon" }] })],
    ["addr with a space", endpoint({ kind: "lan", addr: "a b", port: 1 })],
    ["addr missing", endpoint({ kind: "lan", port: 1 })],
    ["addr empty", endpoint({ kind: "lan", addr: "", port: 1 })],
    ["ipv4 part over 255", endpoint({ kind: "lan", addr: "192.168.1.256", port: 1 })],
    ["ipv6 with letters past f", endpoint({ kind: "manual", addr: "fd7a::g1", port: 1 })],
    ["hostname too long", endpoint({ kind: "manual", addr: "a".repeat(254), port: 1 })],
    ["hostname with underscore", endpoint({ kind: "manual", addr: "my_host", port: 1 })],
    ["port 0", endpoint({ kind: "lan", addr: "10.0.0.1", port: 0 })],
    ["port 65536", endpoint({ kind: "lan", addr: "10.0.0.1", port: 65536 })],
    ["port fractional", endpoint({ kind: "lan", addr: "10.0.0.1", port: 80.5 })],
    ["port a string", endpoint({ kind: "lan", addr: "10.0.0.1", port: "80" })],
    ["insecure relay", link({ ...OFFER, relay: { url: "ws://relay.example", room: "r" } })],
    ["http relay", link({ ...OFFER, relay: { url: "https://relay.example", room: "r" } }), true],
    ["relay null", link({ ...OFFER, relay: null })],
    ["relay without room", link({ ...OFFER, relay: { url: "wss://relay.example" } })],
    ["relay a string", link({ ...OFFER, relay: "wss://relay.example" })],
  ];
  const parse = cases.map(([name, input, allowInsecureRelay]) => {
    const entry = { name, input, ...(allowInsecureRelay ? { allowInsecureRelay } : {}) };
    try {
      return { ...entry, offer: ch.parseOfferLink(input, { allowInsecureRelay }) };
    } catch (error) {
      if (!(error instanceof ch.OfferError)) throw error;
      return { ...entry, error: { reason: error.reason, message: error.message } };
    }
  });
  const links = LINK_BASES.map((base) => ({ base, offer: OFFER, link: ch.encodeOfferLink(OFFER, base) }));
  return { links, parse };
}

// ── Pairing and encodings ──────────────────────────────────────────────────

function pairing() {
  const proofs = [0, 1, 2, 3].map((i) => {
    const secret = seed(`pairing/secret/${i}`);
    const h = seed(`pairing/h/${i}`);
    const code = ch.confirmationCode(h);
    return {
      secret: hex(secret),
      h: hex(h),
      proof: hex(ch.pairingProof(secret, h)),
      code,
      formatted: ch.formatCode(code),
    };
  });
  // Hashes whose codes need zero padding keep the padding honest.
  for (let i = 0; proofs.length < 8; i++) {
    const h = seed(`pairing/padded/${i}`);
    const code = ch.confirmationCode(h);
    if (code.startsWith("0")) proofs.push({ secret: hex(seed("s")), h: hex(h), proof: hex(ch.pairingProof(seed("s"), h)), code, formatted: ch.formatCode(code) });
  }
  const fingerprints = [new Uint8Array(32), seed("host/0"), seed("host/1")].map((key) => ({
    key: hex(key),
    fingerprint: ch.hostFingerprint(key),
    keyHash: hex(ch.keyHash(key)),
  }));
  const encodings = Array.from({ length: 40 }, (_, length) => {
    const bytes = pattern(length, length);
    return { hex: hex(bytes), base64url: b64(bytes), crockford: ch.toCrockford(bytes) };
  });
  return { proofs, fingerprints, encodings };
}

// ── Envelopes ──────────────────────────────────────────────────────────────

const HOST_INFO = { name: "mac-mini", platform: "darwin", version: "0.9.0", fingerprint: ch.hostFingerprint(seed("host/0")) };

const HELLO = {
  v: 1,
  env: ENV,
  n: 42,
  channel: { min: 1, max: 1 },
  app: { name: "MonoCode", version: "1.0.0", build: "1000123", platform: "ios", os: "26.0", model: "iPhone14,5" },
  caps: ["deflate", "attention", "windowedSync", "truncatedBlocks"],
  providers: ["claude", "codex"],
  presence: { visible: true, focusedSessionId: "s-1" },
};

const WELCOME = {
  ok: true,
  channel: 1,
  env: ENV,
  boot: "boot-1",
  time: 1_760_000_000_123,
  host: HOST_INFO,
  device: { id: "d-1", name: "Demo iPhone", role: "admin" },
  capabilities: ["inbox", "watch", "deflate"],
  providers: ["claude"],
  endpoints: [
    { kind: "lan", addr: "192.168.1.20", port: 3775 },
    { kind: "tailscale", addr: "100.101.12.7", port: 3775, dns: "mac-mini.tail1234.ts.net" },
  ],
  relay: null,
  push: { enabled: true },
  limits: { maxMessage: ch.MAX_MESSAGE, maxInFlight: 64, maxWatchedSessions: 8 },
};

const PAIRING_WELCOME = {
  ok: true,
  channel: 1,
  env: ENV,
  boot: "boot-1",
  time: 1_760_000_000_123,
  host: HOST_INFO,
  pairing: { offer: OFFER.offer, expiresAt: 1_760_000_599 },
};

function envelopes() {
  const replies = [
    WELCOME,
    { ...WELCOME, relay: { url: "wss://relay.usemono.dev", room: "room" }, device: { ...WELCOME.device, role: "member" } },
    { ...WELCOME, device: { ...WELCOME.device, role: "observer" }, future: true },
    PAIRING_WELCOME,
    { ok: false, code: "unknown_device", message: "This phone isn't paired." },
    { ok: false, code: "some_future_code", message: "Newer host" },
  ];
  return {
    channelVersion: ch.CHANNEL_VERSION,
    prologue: hex(utf8(ch.channelPrologue(ENV))),
    frames: {
      handshake1: ch.FRAME_HANDSHAKE_1,
      handshake2: ch.FRAME_HANDSHAKE_2,
      transport: ch.FRAME_TRANSPORT,
      reject: ch.FRAME_REJECT,
    },
    hellos: [
      HELLO,
      { ...HELLO, n: 0, presence: undefined, pair: { offer: OFFER.offer }, caps: ["deflate", "someFutureCap"] },
    ].map((value) => JSON.parse(JSON.stringify(value))),
    replies: replies.map((reply) => ({ reply, pairing: reply.ok ? ch.isPairingWelcome(reply) : false })),
    client: [
      { t: "req", id: 1, m: "inbox.list", p: { limit: 50, nested: { a: [1, "two", null, true] } } },
      { t: "req", id: 2, m: "sessions.command", p: { sessionId: "s-1" }, key: "k-1" },
      { t: "req", id: 3, m: "environment.describe" },
      { t: "cancel", id: 2 },
      { t: "ping", ts: 1_760_000_000_000.25, presence: { visible: false } },
      { t: "ping", ts: 1_760_000_000_001 },
      ...["rekey", "replaced", "background", "device_revoked", "host_stopping", "protocol_error", "idle_timeout", "pairing_closed"]
        .map((code) => ({ t: "bye", code })),
    ],
    host: [
      { t: "res", id: 1, ok: true, r: { items: [], cursor: null } },
      { t: "res", id: 2, ok: true, r: 0.5 },
      { t: "res", id: 3, ok: true, r: [1, "a", false, null, { b: -2.5e-7 }] },
      { t: "res", id: 4, ok: false, e: { code: "not_found", message: "No such session", retryable: false } },
      { t: "res", id: 5, ok: false, e: { code: "rate_limited", message: "Slow down", retryable: true, data: { retryAfterMs: 1000 } } },
      { t: "res", id: 6, ok: false, e: { code: "a_future_code", message: "?", retryable: false } },
      { t: "evt", e: "sessions.sync", d: { sessionId: "s-1", sync: { kind: "unchanged", revision: 3 } } },
      { t: "evt", e: "inbox.changed", d: null },
      { t: "pong", ts: 1_760_000_000_000.25, now: 1_760_000_000_050 },
      { t: "bye", code: "host_stopping", message: "The host is shutting down" },
      { t: "bye", code: "rekey" },
      { t: "bye", code: "a_future_bye" },
    ],
    errors: [
      { code: "invalid_params", message: "Bad", retryable: false },
      new ch.ChannelRequestError({ code: "offline", message: "Not connected", retryable: true }),
    ].map((error) => ({ code: error.code, message: error.message, retryable: error.retryable })),
  };
}

// ── Handshake transcript ───────────────────────────────────────────────────

function handshake() {
  const phoneStatic = ch.keyPairFromSecret(seed("handshake/phone/static"));
  const phoneEphemeral = ch.keyPairFromSecret(seed("handshake/phone/ephemeral"));
  const hostStatic = ch.keyPairFromSecret(seed("handshake/host/static"));
  const hostEphemeral = ch.keyPairFromSecret(seed("handshake/host/ephemeral"));
  const prologue = utf8(ch.channelPrologue(ENV));
  const initiator = new ch.IKInitiator({
    staticKey: phoneStatic,
    remoteStatic: hostStatic.publicKey,
    prologue,
    ephemeral: phoneEphemeral,
  });
  const responder = new ch.IKResponder({ staticKey: hostStatic, prologue, ephemeral: hostEphemeral });
  const helloJson = JSON.stringify(HELLO);
  const welcomeJson = JSON.stringify(WELCOME);
  const message1 = initiator.writeMessage1(utf8(helloJson));
  responder.readMessage1(message1);
  const { message: message2, transport: hostSide } = responder.writeMessage2(utf8(welcomeJson));
  const { transport: phoneSide } = initiator.readMessage2(message2);
  const h = phoneSide.handshakeHash;
  const secret = ch.fromBase64Url(OFFER.secret);

  // The phone's frames go through the priority queues. The sink accepts a
  // number of frames, then reports a full buffer so the rest stay queued.
  let allowance = 0;
  const phoneFrames = [];
  const phoneSink = {
    get bufferedAmount() {
      return allowance > 0 ? 0 : 1 << 30;
    },
    send(frame) {
      allowance--;
      phoneFrames.push(b64(frame));
    },
  };
  const phone = new ch.SecureSession(phoneSide, phoneSink, { compress: false });
  const steps = [];
  const send = (message, priority) => {
    const json = JSON.stringify(message);
    steps.push({ send: { json, priority } });
    phone.send(message, priority);
  };
  const release = (count) => {
    allowance = count;
    phoneFrames.length = 0;
    phone.flush();
    steps.push({ frames: [...phoneFrames] });
  };
  send({ t: "res", id: 99, ok: true, r: { blob: b64(noise(70_000, 3)) } }, 2);
  send({ t: "req", id: 1, m: "inbox.list" }, 1);
  release(1);
  release(1);
  send({ t: "req", id: 2, m: "sessions.page", p: { projectId: "p-1" } }, 0);
  send({ t: "ping", ts: 1_760_000_000_000.5, presence: { visible: true } }, 0);
  release(10);
  phone.close();

  // The host's frames: small, compressed and fragmented, in send order.
  const hostFrames = [];
  const host = new ch.SecureSession(hostSide, { bufferedAmount: 0, send: (frame) => hostFrames.push(b64(frame)) });
  const hostMessages = [
    [{ t: "res", id: 1, ok: true, r: { items: [] } }, 0],
    [{ t: "evt", e: "sessions.sync", d: { blocks: Array(300).fill("the same words again") } }, 1],
    [JSON.parse(numbersJson(30_000)), 2],
    [{ t: "pong", ts: 1_760_000_000_000.5, now: 1_760_000_000_100 }, 0],
  ];
  for (const [message, priority] of hostMessages) host.send(message, priority);
  host.close();

  return {
    env: ENV,
    prologue: hex(prologue),
    phone: { static: hex(phoneStatic.secretKey), ephemeral: hex(phoneEphemeral.secretKey), public: hex(phoneStatic.publicKey) },
    host: { static: hex(hostStatic.secretKey), ephemeral: hex(hostEphemeral.secretKey), public: hex(hostStatic.publicKey) },
    hello: helloJson,
    welcome: welcomeJson,
    message1: hex(message1),
    message2: hex(message2),
    handshakeHash: hex(h),
    confirmationCode: ch.confirmationCode(h),
    pairingSecret: hex(secret),
    pairingProof: hex(ch.pairingProof(secret, h)),
    phoneSteps: steps,
    hostFrames,
    hostMessages: hostMessages.map(([message]) => message),
  };
}

// ── Output ─────────────────────────────────────────────────────────────────

const vectors = join(channelSrc, "vectors");
const outputs = {
  "cacophony-ik.json": await readFile(join(vectors, "cacophony-ik.json"), "utf8"),
  "snow-ik.json": await readFile(join(vectors, "snow-ik.json"), "utf8"),
  "records.json": records(),
  "offers.json": offers(),
  "pairing.json": pairing(),
  "envelopes.json": envelopes(),
  "handshake.json": handshake(),
};

const check = process.argv.includes("--check");
let stale = false;
for (const [name, value] of Object.entries(outputs)) {
  const path = join(fixtures, name);
  const text = typeof value === "string" ? value : JSON.stringify(value) + "\n";
  const previous = await readFile(path, "utf8").catch(() => "");
  if (previous === text) continue;
  if (check) {
    console.error(`MonoChannel/${name} is out of date; run node apps/ios/scripts/gen-channel-fixtures.mjs`);
    stale = true;
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    console.log(`wrote MonoChannel/${name} (${(text.length / 1024).toFixed(0)} KiB)`);
  }
}
if (stale) process.exit(1);
