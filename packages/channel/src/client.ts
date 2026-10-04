// The phone's side of a channel: run the IK handshake over any FrameSocket,
// then match requests to responses and dispatch events. Knows nothing about
// React, storage or which transport carries the frames.

import { fromBase64Url, fromUtf8, utf8 } from "./bytes";
import {
  FRAME_HANDSHAKE_1,
  FRAME_HANDSHAKE_2,
  FRAME_REJECT,
  ChannelRequestError,
  channelPrologue,
  type ByeCode,
  type ChannelErrorCode,
  type HandshakeReply,
  type Hello,
  type HostMessage,
  type PairingWelcome,
  type Presence,
  type Welcome,
} from "./envelope";
import { IKInitiator, type KeyPair } from "./noise";
import { SecureSession } from "./session";
import type { FrameSocket } from "./socket";

/** A failed handshake. `authenticated` is true when the host proved its
 * identity (the error came inside message 2), so it can be trusted. */
export class HandshakeFailure extends Error {
  constructor(
    readonly code: ChannelErrorCode,
    message: string,
    readonly authenticated: boolean,
  ) {
    super(message);
  }
}

export type ChannelCloseInfo = { code: number; reason: string; bye?: ByeCode };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export const READ_TIMEOUT_MS = 30_000;

export class Channel {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventListeners = new Set<(event: string, data: unknown) => void>();
  private readonly closeListeners = new Set<(info: ChannelCloseInfo) => void>();
  private readonly pongWaiters = new Map<number, (now: number) => void>();
  private bye?: ByeCode;
  closed = false;

  constructor(
    private readonly session: SecureSession,
    private readonly socket: FrameSocket,
  ) {
    socket.onFrame = (frame) => {
      let message: HostMessage | undefined;
      try {
        message = session.receive(frame) as HostMessage | undefined;
      } catch {
        this.close(1002, "protocol_error");
        return;
      }
      if (message) this.handle(message);
    };
    socket.onClose = (code, reason) => this.finish({ code, reason, bye: this.bye });
  }

  get handshakeHash(): Uint8Array {
    return this.session.handshakeHash;
  }

  private handle(message: HostMessage): void {
    switch (message.t) {
      case "res": {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.ok) waiter.resolve(message.r);
        else waiter.reject(new ChannelRequestError(message.e));
        return;
      }
      case "evt":
        for (const listener of this.eventListeners) {
          try {
            listener(message.e, message.d);
          } catch (error) {
            console.error("Channel event listener failed", error);
          }
        }
        return;
      case "pong":
        this.pongWaiters.get(message.ts)?.(message.now);
        this.pongWaiters.delete(message.ts);
        return;
      case "bye":
        this.bye = message.code;
        this.close(1000, message.code);
        return;
    }
  }

  request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options: { timeoutMs?: number; key?: string } = {},
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(
        new ChannelRequestError({ code: "offline", message: "Not connected", retryable: true }),
      );
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.session.send({ t: "cancel", id }, 0);
        reject(
          new ChannelRequestError({ code: "timeout", message: "The host did not answer", retryable: true }),
        );
      }, options.timeoutMs ?? READ_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.session.send(
        { t: "req", id, m: method, ...(params ? { p: params } : {}), ...(options.key ? { key: options.key } : {}) },
        0,
      );
    });
  }

  /** Resolves with the round trip and the host clock, or rejects on timeout. */
  ping(presence?: Presence, timeoutMs = 5_000): Promise<{ rttMs: number; hostNow: number }> {
    const ts = Date.now() + Math.random();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pongWaiters.delete(ts);
        reject(new Error("Ping timed out"));
      }, timeoutMs);
      this.pongWaiters.set(ts, (hostNow) => {
        clearTimeout(timer);
        resolve({ rttMs: Date.now() - ts, hostNow });
      });
      this.session.send({ t: "ping", ts, ...(presence ? { presence } : {}) }, 0);
    });
  }

  onEvent(listener: (event: string, data: unknown) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onClose(listener: (info: ChannelCloseInfo) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Says goodbye, then closes the socket. */
  sayBye(code: ByeCode): void {
    if (this.closed) return;
    this.session.send({ t: "bye", code }, 0);
    this.close(1000, code);
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.socket.close(code, reason);
    this.finish({ code, reason, bye: this.bye });
  }

  private finish(info: ChannelCloseInfo): void {
    if (this.closed && !this.pending.size && !this.closeListeners.size) return;
    this.closed = true;
    this.session.close();
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(
        new ChannelRequestError({ code: "offline", message: "Connection lost", retryable: true }),
      );
    }
    this.pending.clear();
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const listener of listeners) listener(info);
  }
}

export type OpenChannelOptions = {
  env: string;
  /** The host's static X25519 key, base64url (from the offer or saved host). */
  hostKey: string;
  deviceKey: KeyPair;
  hello: Hello;
  timeoutMs?: number;
  compress?: boolean;
};

/** Runs the handshake on an open socket. Resolves with a usable channel and
 * the host's welcome; rejects with `HandshakeFailure` or a timeout. */
export function openChannel(
  socket: FrameSocket,
  options: OpenChannelOptions,
): Promise<{ channel: Channel; reply: Welcome | PairingWelcome }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.onFrame = null;
      socket.onClose = null;
      socket.close(1000, "handshake");
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new HandshakeFailure("timeout", "The host did not answer the handshake", false)),
      options.timeoutMs ?? 5_000,
    );
    let initiator: IKInitiator;
    try {
      initiator = new IKInitiator({
        staticKey: options.deviceKey,
        remoteStatic: fromBase64Url(options.hostKey),
        prologue: utf8(channelPrologue(options.env)),
      });
    } catch (error) {
      fail(error as Error);
      return;
    }
    socket.onClose = (code) =>
      fail(new HandshakeFailure("handshake_failed", `Connection closed (${code})`, false));
    socket.onFrame = (frame) => {
      if (settled) return;
      if (frame[0] === FRAME_REJECT) {
        let code: ChannelErrorCode = "handshake_failed";
        try {
          code = JSON.parse(fromUtf8(frame.subarray(1))).code ?? code;
        } catch {
          /* keep the default */
        }
        fail(new HandshakeFailure(code, "The host rejected the handshake", false));
        return;
      }
      if (frame[0] !== FRAME_HANDSHAKE_2) {
        fail(new HandshakeFailure("handshake_failed", "Unexpected handshake frame", false));
        return;
      }
      let reply: HandshakeReply;
      let session: SecureSession;
      try {
        const { payload, transport } = initiator.readMessage2(frame.subarray(1));
        reply = JSON.parse(fromUtf8(payload)) as HandshakeReply;
        session = new SecureSession(transport, socket, {
          compress: options.compress ?? true,
          maxMessage: reply.ok && "limits" in reply ? reply.limits.maxMessage : undefined,
        });
      } catch {
        fail(new HandshakeFailure("handshake_failed", "The host's identity could not be verified", false));
        return;
      }
      if (!reply.ok) {
        fail(new HandshakeFailure(reply.code, reply.message, true));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ channel: new Channel(session, socket), reply });
    };
    const message1 = initiator.writeMessage1(utf8(JSON.stringify(options.hello)));
    const frame = new Uint8Array(message1.length + 1);
    frame[0] = FRAME_HANDSHAKE_1;
    frame.set(message1, 1);
    socket.send(frame);
  });
}
