// Turns a completed Noise handshake into a message channel: JSON messages,
// optional compression, fragmentation and three priority queues so a small
// approval event never waits behind a large snapshot (spec 03 §3.5).

import { fromUtf8, utf8 } from "./bytes";
import { FRAME_TRANSPORT, type Priority } from "./envelope";
import type { NoiseTransport } from "./noise";
import {
  MAX_MESSAGE,
  RECORD_DEFLATE,
  RECORD_JSON,
  Reassembler,
  RecordError,
  encodeRecords,
  inflateBounded,
  maybeCompress,
} from "./record";

export type FrameSink = {
  send(frame: Uint8Array): void;
  readonly bufferedAmount: number;
};

/** Frames already handed to the socket beyond this wait in our queues, where
 * a higher priority message can still overtake them. */
const HIGH_WATER = 256 * 1024;

export class SecureSession {
  private readonly queues: Uint8Array[][] = [[], [], []];
  private readonly heads = [0, 0, 0];
  private msgId = 0;
  private readonly reassembler: Reassembler;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly transport: NoiseTransport,
    private readonly sink: FrameSink,
    private readonly options: { compress: boolean; maxMessage?: number } = { compress: true },
  ) {
    this.reassembler = new Reassembler(options.maxMessage ?? MAX_MESSAGE);
  }

  get handshakeHash(): Uint8Array {
    return this.transport.handshakeHash;
  }

  /** Bytes queued here, not yet given to the socket. */
  get queuedBytes(): number {
    let total = 0;
    this.queues.forEach((queue, priority) => {
      for (let i = this.heads[priority]; i < queue.length; i++) total += queue[i].length;
    });
    return total;
  }

  send(message: unknown, priority: Priority = 1): void {
    if (this.closed) return;
    const json = utf8(JSON.stringify(message));
    if (json.length > (this.options.maxMessage ?? MAX_MESSAGE))
      throw new RecordError("Message is too large");
    const { type, payload } = this.options.compress
      ? maybeCompress(json)
      : { type: RECORD_JSON as typeof RECORD_JSON, payload: json };
    const id = this.msgId;
    this.msgId = (this.msgId + 1) >>> 0;
    this.queues[priority].push(...encodeRecords(id, type, payload));
    this.flush();
  }

  /** Encrypts at dequeue time, so nonces follow the order frames hit the wire. */
  flush(): void {
    if (this.closed) return;
    while (this.sink.bufferedAmount < HIGH_WATER) {
      const priority = this.heads.findIndex((head, index) => head < this.queues[index].length);
      if (priority < 0) return;
      const queue = this.queues[priority];
      const record = queue[this.heads[priority]];
      this.heads[priority]++;
      if (this.heads[priority] === queue.length) {
        queue.length = 0;
        this.heads[priority] = 0;
      }
      const sealed = this.transport.send.encrypt(record);
      const frame = new Uint8Array(sealed.length + 1);
      frame[0] = FRAME_TRANSPORT;
      frame.set(sealed, 1);
      this.sink.send(frame);
    }
    if (this.heads.every((head, index) => head >= this.queues[index].length)) return;
    if (this.retry === undefined)
      this.retry = setTimeout(() => {
        this.retry = undefined;
        this.flush();
      }, 10);
  }

  /** Returns a complete message, or undefined while fragments are pending.
   * Throws on any authentication or framing error; close the channel then. */
  receive(frame: Uint8Array): unknown {
    if (frame[0] !== FRAME_TRANSPORT) throw new RecordError("Unexpected frame kind");
    const record = this.transport.receive.decrypt(frame.subarray(1));
    const message = this.reassembler.push(record);
    if (!message) return undefined;
    const payload =
      message.type === RECORD_DEFLATE
        ? inflateBounded(message.payload, this.options.maxMessage ?? MAX_MESSAGE)
        : message.payload;
    return JSON.parse(fromUtf8(payload));
  }

  close(): void {
    this.closed = true;
    if (this.retry !== undefined) clearTimeout(this.retry);
    this.retry = undefined;
    this.queues.forEach((queue) => (queue.length = 0));
  }
}
