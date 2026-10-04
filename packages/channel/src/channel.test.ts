import { describe, expect, it } from "vitest";
import { fromBase64Url, fromUtf8, toBase64Url, toCrockford, utf8 } from "./bytes";
import { HandshakeFailure, openChannel } from "./client";
import {
  FRAME_HANDSHAKE_1,
  FRAME_HANDSHAKE_2,
  FRAME_REJECT,
  channelPrologue,
  type Hello,
} from "./envelope";
import { IKResponder, generateKeyPair, type KeyPair } from "./noise";
import { encodeOfferLink, parseOfferLink, type Offer } from "./offer";
import { confirmationCode, hostFingerprint, pairingProof, verifyPairingProof } from "./pairing";
import {
  MAX_FRAGMENT,
  RECORD_DEFLATE,
  RECORD_JSON,
  Reassembler,
  RecordError,
  encodeRecords,
  inflateBounded,
  maybeCompress,
} from "./record";
import { SecureSession } from "./session";
import { memorySocketPair, type FrameSocket } from "./socket";

const ENV = "6f0b1f8e-3c2a-4a59-9a77-5d1c2b0f4e11";

describe("bytes", () => {
  it("round-trips base64url for every length", () => {
    for (let length = 0; length < 40; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 0xff);
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
    expect(() => fromBase64Url("a$b")).toThrow();
  });

  it("encodes Crockford base32", () => {
    expect(toCrockford(Uint8Array.of(0, 0, 0, 0, 0))).toBe("00000000");
    expect(toCrockford(Uint8Array.of(0xff))).toBe("ZW");
  });
});

describe("records", () => {
  it("fragments large messages and reassembles interleaved ones", () => {
    const big = Uint8Array.from({ length: MAX_FRAGMENT * 2 + 10 }, (_, i) => i & 0xff);
    const small = utf8('{"t":"pong"}');
    const bigRecords = encodeRecords(7, RECORD_JSON, big);
    expect(bigRecords).toHaveLength(3);
    const reassembler = new Reassembler();
    expect(reassembler.push(bigRecords[0])).toBeUndefined();
    const interleaved = reassembler.push(encodeRecords(8, RECORD_JSON, small)[0]);
    expect(fromUtf8(interleaved!.payload)).toBe('{"t":"pong"}');
    expect(reassembler.push(bigRecords[1])).toBeUndefined();
    expect(reassembler.push(bigRecords[2])!.payload).toEqual(big);
  });

  it("rejects reserved flags, oversize messages and too many partials", () => {
    const record = encodeRecords(1, RECORD_JSON, utf8("{}"))[0];
    record[1] |= 2;
    expect(() => new Reassembler().push(record)).toThrow(RecordError);
    const limited = new Reassembler(MAX_FRAGMENT + 5);
    const parts = encodeRecords(2, RECORD_JSON, new Uint8Array(MAX_FRAGMENT * 2));
    limited.push(parts[0]);
    expect(() => limited.push(parts[1])).toThrow(/too large/);
    const crowded = new Reassembler();
    for (let id = 0; id < 32; id++)
      crowded.push(encodeRecords(id, RECORD_JSON, new Uint8Array(MAX_FRAGMENT + 1))[0]);
    expect(() =>
      crowded.push(encodeRecords(99, RECORD_JSON, new Uint8Array(MAX_FRAGMENT + 1))[0]),
    ).toThrow(/partial/);
  });

  it("compresses only when it helps and stops decompression bombs", () => {
    expect(maybeCompress(utf8("short")).type).toBe(RECORD_JSON);
    const text = utf8(JSON.stringify({ blocks: Array(500).fill("the same words again") }));
    const compressed = maybeCompress(text);
    expect(compressed.type).toBe(RECORD_DEFLATE);
    expect(inflateBounded(compressed.payload)).toEqual(text);
    const bomb = maybeCompress(new Uint8Array(4 * 1024 * 1024)).payload;
    expect(() => inflateBounded(bomb, 1024 * 1024)).toThrow(/too large/);
  });
});

describe("offers", () => {
  const offer: Offer = {
    v: 1,
    env: ENV,
    name: "mac-mini",
    key: toBase64Url(new Uint8Array(32).fill(1)),
    offer: toBase64Url(new Uint8Array(16).fill(2)),
    secret: toBase64Url(new Uint8Array(32).fill(3)),
    exp: 1_760_000_599,
    direct: [
      { kind: "lan", addr: "192.168.1.20", port: 3775 },
      { kind: "tailscale", addr: "100.101.12.7", port: 3775, dns: "mac-mini.tail1234.ts.net" },
    ],
  };

  it("round-trips through every link form", () => {
    for (const base of ["https://usemono.dev/pair", "monocode-dev://pair", "monocode://pair"])
      expect(parseOfferLink(encodeOfferLink(offer, base))).toEqual(offer);
  });

  it("rejects malformed offers and unknown versions", () => {
    expect(() => parseOfferLink("https://example.com")).toThrow(/isn't a MonoCode/);
    const link = (value: unknown) =>
      `monocode-dev://pair#o=${toBase64Url(utf8(JSON.stringify(value)))}`;
    expect(() => parseOfferLink(link({ ...offer, v: 2 }))).toThrow(/Update MonoCode/);
    expect(() => parseOfferLink(link({ ...offer, key: "short" }))).toThrow();
    expect(() => parseOfferLink(link({ ...offer, direct: [], relay: undefined }))).toThrow();
    expect(() =>
      parseOfferLink(link({ ...offer, direct: [{ kind: "lan", addr: "a b", port: 1 }] })),
    ).toThrow();
    expect(() =>
      parseOfferLink(link({ ...offer, relay: { url: "ws://relay.example", room: "r" } })),
    ).toThrow();
    // Unknown endpoint kinds are skipped, not fatal.
    expect(
      parseOfferLink(link({ ...offer, direct: [...offer.direct!, { kind: "carrier-pigeon" }] }))
        .direct,
    ).toHaveLength(2);
  });
});

describe("pairing crypto", () => {
  it("binds the proof to the handshake hash", () => {
    const secret = new Uint8Array(32).fill(9);
    const h = new Uint8Array(32).fill(4);
    const proof = pairingProof(secret, h);
    expect(verifyPairingProof(secret, h, proof)).toBe(true);
    expect(verifyPairingProof(secret, new Uint8Array(32).fill(5), proof)).toBe(false);
    expect(confirmationCode(h)).toMatch(/^\d{6}$/);
    expect(hostFingerprint(new Uint8Array(32))).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
  });
});

/** A minimal host: answers the handshake and echoes requests. */
function fakeHost(
  socket: FrameSocket,
  hostKey: KeyPair,
  reply: (hello: Hello) => object,
  reject?: string,
) {
  const responder = new IKResponder({ staticKey: hostKey, prologue: utf8(channelPrologue(ENV)) });
  let session: SecureSession | undefined;
  socket.onFrame = (frame) => {
    if (!session) {
      expect(frame[0]).toBe(FRAME_HANDSHAKE_1);
      if (reject) {
        socket.send(Uint8Array.of(FRAME_REJECT, ...utf8(JSON.stringify({ code: reject }))));
        return;
      }
      const { payload } = responder.readMessage1(frame.subarray(1));
      const { message, transport } = responder.writeMessage2(
        utf8(JSON.stringify(reply(JSON.parse(fromUtf8(payload))))),
      );
      socket.send(Uint8Array.of(FRAME_HANDSHAKE_2, ...message));
      session = new SecureSession(transport, socket);
      return;
    }
    const message = session.receive(frame) as { t: string; id: number; m: string; p: unknown; ts: number };
    if (message?.t === "req") {
      if (message.m === "fail")
        session.send({ t: "res", id: message.id, ok: false, e: { code: "not_found", message: "nope", retryable: false } });
      else if (message.m === "big")
        session.send({ t: "res", id: message.id, ok: true, r: "x".repeat(200_000) }, 2);
      else {
        session.send({ t: "evt", e: "echoed", d: message.p });
        session.send({ t: "res", id: message.id, ok: true, r: message.p });
      }
    }
    if (message?.t === "ping") session.send({ t: "pong", ts: message.ts, now: 42 });
  };
}

const hello: Hello = {
  v: 1,
  env: ENV,
  n: 1,
  channel: { min: 1, max: 1 },
  app: { name: "MonoCode", version: "0", build: "0", platform: "node", os: "test" },
  caps: ["deflate"],
  providers: [],
};

describe("channel client", () => {
  it("handshakes, requests, receives events and pings", async () => {
    const hostKey = generateKeyPair();
    const [phone, host] = memorySocketPair();
    fakeHost(host, hostKey, () => ({ ok: true, channel: 1, env: ENV, limits: { maxMessage: 1 << 24 } }));
    const { channel, reply } = await openChannel(phone, {
      env: ENV,
      hostKey: toBase64Url(hostKey.publicKey),
      deviceKey: generateKeyPair(),
      hello,
    });
    expect(reply.ok).toBe(true);
    const events: unknown[] = [];
    channel.onEvent((event, data) => events.push([event, data]));
    await expect(channel.request("echo", { a: 1 })).resolves.toEqual({ a: 1 });
    expect(events).toEqual([["echoed", { a: 1 }]]);
    await expect(channel.request("big")).resolves.toHaveLength(200_000);
    await expect(channel.request("fail")).rejects.toMatchObject({ code: "not_found" });
    await expect(channel.ping()).resolves.toMatchObject({ hostNow: 42 });
    const closed = new Promise((resolve) => channel.onClose(resolve));
    host.close(1000, "bye");
    await closed;
    await expect(channel.request("echo")).rejects.toMatchObject({ code: "offline" });
  });

  it("reports authenticated errors from message 2 and unauthenticated rejects", async () => {
    const hostKey = generateKeyPair();
    const [phone, host] = memorySocketPair();
    fakeHost(host, hostKey, () => ({ ok: false, code: "unknown_device", message: "Unknown" }));
    const failure = await openChannel(phone, {
      env: ENV,
      hostKey: toBase64Url(hostKey.publicKey),
      deviceKey: generateKeyPair(),
      hello,
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(HandshakeFailure);
    expect(failure).toMatchObject({ code: "unknown_device", authenticated: true });

    const [phone2, host2] = memorySocketPair();
    fakeHost(host2, hostKey, () => ({}), "handshake_failed");
    await expect(
      openChannel(phone2, {
        env: ENV,
        hostKey: toBase64Url(hostKey.publicKey),
        deviceKey: generateKeyPair(),
        hello,
      }),
    ).rejects.toMatchObject({ code: "handshake_failed", authenticated: false });
  });
});
