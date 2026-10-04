// One phone channel (spec 09 §9.8): Noise IK as responder, the hello rules
// from 03 §3.4, then requests, events and pairing over the record layer.

import { hostname } from "node:os";
import { fromUtf8, toBase64Url, utf8 } from "@monocode/channel/bytes";
import {
  CHANNEL_VERSION,
  FRAME_HANDSHAKE_1,
  FRAME_HANDSHAKE_2,
  FRAME_REJECT,
  channelPrologue,
  type ByeCode,
  type ChannelErrorCode,
  type ClientMessage,
  type Endpoint,
  type HandshakeReply,
  type Hello,
  type HostInfo,
  type Priority,
  type Welcome,
} from "@monocode/channel/envelope";
import { IKResponder } from "@monocode/channel/noise";
import { SecureSession } from "@monocode/channel/session";
import type { FrameSocket } from "@monocode/channel/socket";
import type { RemoteProvider } from "../../src/features/connections/model/protocol";
import type { Principal, Via } from "../devices";
import { HostError, wireError } from "../errors";
import type { HostKeys } from "../keys";
import type { PairingManager } from "../pairing";
import { BASE_CAPABILITIES, BOOT_ID, CHANNEL_CAPABILITIES, clientProviders, type HostRpc } from "../rpc";
import type { HostStore, SessionChange } from "../store";
import { MAX_WATCHED_SESSIONS, Watcher } from "./watch";
import { version } from "../../package.json";

const HANDSHAKE_DEADLINE_MS = 10_000;
const IDLE_TIMEOUT_MS = 45_000;
const LIFETIME_MS = 24 * 60 * 60_000;
const CLAIM_WINDOW_MS = 30_000;
const MAX_IN_FLIGHT = 64;
export const MAX_MESSAGE = 16 * 1024 * 1024;

export type ChannelHost = {
  store: HostStore;
  rpc: HostRpc;
  keys: HostKeys;
  pairing: PairingManager;
  providers: RemoteProvider[];
  endpoints(): Endpoint[];
  /** Registers an authenticated channel; may close older ones for the device. */
  register(connection: ChannelConnection): void;
  unregister(connection: ChannelConnection): void;
};

function hostInfo(keys: HostKeys): HostInfo {
  return { name: hostname(), platform: process.platform, version, fingerprint: keys.fingerprint };
}

function isHello(value: unknown): value is Hello {
  const hello = value as Hello;
  return (
    !!hello &&
    typeof hello === "object" &&
    hello.v === 1 &&
    typeof hello.env === "string" &&
    typeof hello.n === "number" &&
    !!hello.channel &&
    typeof hello.channel.min === "number" &&
    typeof hello.channel.max === "number" &&
    !!hello.app &&
    Array.isArray(hello.caps) &&
    Array.isArray(hello.providers)
  );
}

export class ChannelConnection {
  state: "handshake" | "pairing" | "device" | "closed" = "handshake";
  principal?: Principal;
  hello?: Hello;
  private session?: SecureSession;
  private handshakeHash?: Uint8Array;
  private remoteStatic?: Uint8Array;
  private pairingOffer?: string;
  private claimed = false;
  private openedAt = Date.now();
  private inFlight = 0;
  private watcher?: Watcher;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private deadline: ReturnType<typeof setTimeout>;
  private lifetime?: ReturnType<typeof setTimeout>;
  private stopPairingListener?: () => void;
  private onAuthenticated?: () => void;

  constructor(
    private readonly socket: FrameSocket,
    private readonly host: ChannelHost,
    readonly transport: Exclude<Via, "http">,
    readonly remoteAddress: string,
    onAuthenticated?: () => void,
  ) {
    this.onAuthenticated = onAuthenticated;
    this.deadline = setTimeout(() => this.close(1008, "handshake timeout"), HANDSHAKE_DEADLINE_MS);
    socket.onFrame = (frame) => this.frame(frame);
    socket.onClose = () => this.closed();
  }

  get deviceId(): string | undefined {
    return this.principal?.deviceId;
  }

  private frame(frame: Uint8Array): void {
    if (this.state === "closed") return;
    if (this.state === "handshake") {
      this.handshake(frame);
      return;
    }
    this.touch();
    let message: ClientMessage | undefined;
    try {
      message = this.session!.receive(frame) as ClientMessage | undefined;
    } catch {
      this.bye("protocol_error");
      return;
    }
    if (!message) return;
    switch (message.t) {
      case "req":
        void this.request(message);
        return;
      case "ping":
        this.send({ t: "pong", ts: message.ts, now: Date.now() }, 0);
        return;
      case "cancel":
        return;
      case "bye":
        this.close(1000, message.code);
        return;
      default:
        this.bye("protocol_error");
    }
  }

  private reject(code: ChannelErrorCode): void {
    const payload = utf8(JSON.stringify({ code }));
    const frame = new Uint8Array(payload.length + 1);
    frame[0] = FRAME_REJECT;
    frame.set(payload, 1);
    this.socket.send(frame);
    this.close(1008, code);
  }

  private handshake(frame: Uint8Array): void {
    if (frame[0] !== FRAME_HANDSHAKE_1) {
      this.close(1002, "expected handshake");
      return;
    }
    const { store, keys, pairing } = this.host;
    const responder = new IKResponder({
      staticKey: keys.host,
      prologue: utf8(channelPrologue(store.environmentId)),
    });
    let hello: unknown;
    try {
      const read = responder.readMessage1(frame.subarray(1));
      this.remoteStatic = read.remoteStatic;
      hello = JSON.parse(fromUtf8(read.payload));
    } catch {
      // Wrong host key, wrong environmentId (prologue) or corruption.
      this.reject("handshake_failed");
      return;
    }
    const finish = (reply: HandshakeReply) => {
      const { message, transport } = responder.writeMessage2(utf8(JSON.stringify(reply)));
      const out = new Uint8Array(message.length + 1);
      out[0] = FRAME_HANDSHAKE_2;
      out.set(message, 1);
      this.socket.send(out);
      if (!reply.ok) {
        // Let the authenticated error reach the phone before closing.
        setTimeout(() => this.close(1008, reply.code), 50);
        return;
      }
      clearTimeout(this.deadline);
      this.handshakeHash = transport.handshakeHash;
      this.session = new SecureSession(transport, this.socket, {
        compress: (this.hello?.caps ?? []).includes("deflate"),
        maxMessage: MAX_MESSAGE,
      });
      this.touch();
    };
    const fail = (code: ChannelErrorCode, message: string) => finish({ ok: false, code, message });
    if (!isHello(hello)) return fail("protocol_incompatible", "Unreadable hello");
    this.hello = hello;
    if (hello.env !== store.environmentId)
      return fail("host_identity_changed", "This is a different host");
    if (hello.channel.min > CHANNEL_VERSION || hello.channel.max < CHANNEL_VERSION)
      return fail("protocol_incompatible", "Channel version not supported");
    const publicKey = toBase64Url(this.remoteStatic!);
    const device = store.devices.byPublicKey(publicKey);
    const base = {
      ok: true as const,
      channel: 1 as const,
      env: store.environmentId,
      boot: BOOT_ID,
      time: Date.now(),
      host: hostInfo(this.host.keys),
    };
    if (device) {
      if (device.status === "pending") return fail("device_pending", "Waiting for approval on the host");
      if (!store.devices.acceptHandshake(device.deviceId, hello.n))
        return fail("replayed_handshake", "Handshake counter was already used");
      this.principal = device;
      store.devices.touch(device.deviceId, this.transport, {
        platform: hello.app.platform,
        model: hello.app.model,
        os: hello.app.os,
        version: hello.app.version,
      });
      this.state = "device";
      finish(this.welcome(base));
      this.authenticated();
      return;
    }
    if (store.devices.tombstoned(publicKey))
      return fail("device_revoked", "This phone was removed from the host");
    if (hello.pair && typeof hello.pair.offer === "string") {
      const offer = pairing.openOffer(hello.pair.offer);
      if (!offer) return fail("pairing_expired", "This code expired. Generate a new one.");
      this.state = "pairing";
      this.pairingOffer = hello.pair.offer;
      finish({ ...base, pairing: { offer: hello.pair.offer, expiresAt: offer.expiresAt } });
      this.stopPairingListener = pairing.on((offerId, status) => {
        if (offerId !== this.pairingOffer || !this.claimed) return;
        if (status.status === "approved" && status.device) this.approved(status.device.id);
        else if (["denied", "expired", "cancelled"].includes(status.status)) {
          this.send({ t: "evt", e: "pair.status", d: { status: status.status } }, 0);
          setTimeout(() => this.bye("pairing_closed"), 50);
        }
      });
      // A pairing channel must claim promptly.
      setTimeout(() => {
        if (this.state === "pairing" && !this.claimed) this.bye("pairing_closed");
      }, CLAIM_WINDOW_MS).unref?.();
      return;
    }
    return fail("unknown_device", "This phone is not paired with this host");
  }

  private welcome(base: Omit<Welcome, "device" | "capabilities" | "providers" | "endpoints" | "relay" | "push" | "limits">): Welcome {
    const principal = this.principal!;
    return {
      ...base,
      device: { id: principal.deviceId, name: principal.name, role: principal.role },
      capabilities: [...BASE_CAPABILITIES, ...CHANNEL_CAPABILITIES],
      providers: clientProviders(this.host.providers, this.hello?.providers),
      endpoints: this.host.endpoints(),
      relay: null,
      push: { enabled: false },
      limits: { maxMessage: MAX_MESSAGE, maxInFlight: MAX_IN_FLIGHT, maxWatchedSessions: MAX_WATCHED_SESSIONS },
    };
  }

  private authenticated(): void {
    this.host.register(this);
    this.lifetime = setTimeout(() => this.bye("rekey"), LIFETIME_MS);
    this.lifetime.unref?.();
    this.onAuthenticated?.();
    this.onAuthenticated = undefined;
  }

  /** The pairing channel becomes a device channel with no reconnect. */
  private approved(deviceId: string): void {
    const device = this.host.store.devices.byPublicKey(toBase64Url(this.remoteStatic!));
    if (!device || device.deviceId !== deviceId || this.state !== "pairing") return;
    this.principal = device;
    this.state = "device";
    this.stopPairingListener?.();
    this.authenticated();
    const welcome = this.welcome({
      ok: true,
      channel: 1,
      env: this.host.store.environmentId,
      boot: BOOT_ID,
      time: Date.now(),
      host: hostInfo(this.host.keys),
    });
    this.send({ t: "evt", e: "pair.status", d: { status: "approved", welcome } }, 0);
  }

  private async request(message: Extract<ClientMessage, { t: "req" }>): Promise<void> {
    const { id, m: method } = message;
    const params =
      message.p && typeof message.p === "object" && !Array.isArray(message.p) ? message.p : {};
    if (this.inFlight >= MAX_IN_FLIGHT) {
      this.send({ t: "res", id, ok: false, e: wireError(new HostError("rate_limited", "Too many requests", true)) }, 0);
      return;
    }
    this.inFlight++;
    try {
      const result = await this.call(method, params);
      const bulk = this.host.rpc.methods[method]?.bulk;
      this.send({ t: "res", id, ok: true, r: result ?? null }, bulk ? 2 : 1);
    } catch (error) {
      const wire = wireError(error);
      if (wire.code === "internal")
        console.error(`Channel request ${method} failed:`, error instanceof Error ? error.message : error);
      this.send({ t: "res", id, ok: false, e: wire }, 0);
    } finally {
      this.inFlight--;
    }
  }

  private call(method: string, params: Record<string, unknown>): unknown {
    if (this.state === "pairing") {
      if (method !== "pair.claim") throw new HostError("forbidden", "Finish pairing first");
      return this.claim(params);
    }
    if (method === "watch.set") {
      this.watcher ??= new Watcher(this.host.store, {
        send: (message, priority) => this.send(message, priority),
        backlog: () => (this.session?.queuedBytes ?? 0) + this.socket.bufferedAmount,
      });
      this.watcher.set(params);
      return {};
    }
    if (method === "pair.claim") throw new HostError("invalid_params", "This phone is already paired");
    return this.host.rpc.dispatch(method, params, {
      principal: this.principal!,
      transport: this.transport,
      channel: this,
    });
  }

  private claim(params: Record<string, unknown>) {
    if (this.claimed) throw new HostError("pairing_used", "This channel already claimed its code");
    if (Date.now() - this.openedAt > CLAIM_WINDOW_MS + HANDSHAKE_DEADLINE_MS)
      throw new HostError("pairing_expired", "Pairing took too long. Scan the code again.");
    if (params.offer !== this.pairingOffer)
      throw new HostError("invalid_params", "This channel was opened for another code");
    const platform = params.platform === "ios" || params.platform === "android" ? params.platform : undefined;
    if (!platform || typeof params.proof !== "string" || typeof params.appVersion !== "string")
      throw new HostError("invalid_params", "Invalid pairing claim");
    const str = (value: unknown) => (typeof value === "string" ? value.slice(0, 64) : undefined);
    this.claimed = true;
    const result = this.host.pairing.claim(this.pairingOffer!, params.proof, this.handshakeHash!, this.remoteStatic!, {
      name: str(params.name) ?? "Phone",
      platform,
      model: str(params.model),
      os: str(params.os),
      appVersion: str(params.appVersion),
      replacesDeviceId: str(params.replacesDeviceId),
    });
    if (result.status === "approved") {
      // Confirmation was off: the claim response itself carries the welcome.
      const device = this.host.store.devices.byPublicKey(toBase64Url(this.remoteStatic!))!;
      this.principal = device;
      this.state = "device";
      this.stopPairingListener?.();
      this.authenticated();
      return {
        ...result,
        welcome: this.welcome({
          ok: true,
          channel: 1,
          env: this.host.store.environmentId,
          boot: BOOT_ID,
          time: Date.now(),
          host: hostInfo(this.host.keys),
        }),
      };
    }
    return result;
  }

  /** Forwards a committed session change to this channel's watch. */
  sessionChanged(change: SessionChange): void {
    this.watcher?.onChange(change);
  }

  projectsChanged(): void {
    this.watcher?.projectsChanged();
  }

  send(message: unknown, priority: Priority): void {
    if (this.state === "closed" || !this.session) return;
    try {
      this.session.send(message, priority);
    } catch (error) {
      console.error("Channel send failed:", error instanceof Error ? error.message : error);
      this.bye("protocol_error");
    }
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.bye("idle_timeout"), IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  bye(code: ByeCode, message?: string): void {
    if (this.state === "closed") return;
    if (this.session) this.send({ t: "bye", code, ...(message ? { message } : {}) }, 0);
    setTimeout(() => this.close(1000, code), 20);
  }

  close(code = 1000, reason = ""): void {
    if (this.state === "closed") return;
    this.socket.close(code, reason);
    this.closed();
  }

  private closed(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    clearTimeout(this.deadline);
    clearTimeout(this.idleTimer);
    clearTimeout(this.lifetime);
    this.watcher?.close();
    this.session?.close();
    this.stopPairingListener?.();
    this.host.unregister(this);
  }
}
