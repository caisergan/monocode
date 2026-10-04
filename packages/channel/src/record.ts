// Record layer (spec 03 §3.5). Every TRANSPORT frame decrypts to one record:
//
//   offset  size  field
//   0       1     type    0x01 = JSON, 0x02 = JSON, deflate-raw compressed
//   1       1     flags   bit 0 = FIN (last fragment); bits 1-7 MUST be 0
//   2       4     msgId   big-endian u32, per sender, +1 per message, wraps
//   6       ≤65,513 fragment

import { Inflate, deflateSync } from "fflate";
import { MAX_NOISE_MESSAGE, TAG_LEN } from "./noise";

export const RECORD_JSON = 0x01;
export const RECORD_DEFLATE = 0x02;
export const RECORD_HEADER = 6;
export const MAX_FRAGMENT = MAX_NOISE_MESSAGE - TAG_LEN - RECORD_HEADER;
export const MAX_MESSAGE = 16 * 1024 * 1024;
const MAX_PARTIALS = 32;
const MAX_BUFFERED = 48 * 1024 * 1024;
/** Smaller messages are never worth compressing. */
export const COMPRESS_MIN = 1024;

export class RecordError extends Error {}

export type RecordType = typeof RECORD_JSON | typeof RECORD_DEFLATE;

/** Cuts one serialised message into records. Empty messages still produce one. */
export function encodeRecords(msgId: number, type: RecordType, payload: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = [];
  let offset = 0;
  do {
    const end = Math.min(payload.length, offset + MAX_FRAGMENT);
    const record = new Uint8Array(RECORD_HEADER + end - offset);
    record[0] = type;
    record[1] = end === payload.length ? 1 : 0;
    record[2] = (msgId >>> 24) & 0xff;
    record[3] = (msgId >>> 16) & 0xff;
    record[4] = (msgId >>> 8) & 0xff;
    record[5] = msgId & 0xff;
    record.set(payload.subarray(offset, end), RECORD_HEADER);
    records.push(record);
    offset = end;
  } while (offset < payload.length);
  return records;
}

/** Compresses when it helps; returns the record type to use. */
export function maybeCompress(payload: Uint8Array): { type: RecordType; payload: Uint8Array } {
  if (payload.length < COMPRESS_MIN) return { type: RECORD_JSON, payload };
  const compressed = deflateSync(payload, { level: 6 });
  return compressed.length < payload.length
    ? { type: RECORD_DEFLATE, payload: compressed }
    : { type: RECORD_JSON, payload };
}

/** Streams the inflate so a compression bomb stops at `max` bytes. */
export function inflateBounded(payload: Uint8Array, max = MAX_MESSAGE): Uint8Array {
  const parts: Uint8Array[] = [];
  let size = 0;
  const inflate = new Inflate((chunk) => {
    size += chunk.length;
    if (size > max) throw new RecordError("Decompressed message is too large");
    parts.push(chunk);
  });
  inflate.push(payload, true);
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

type Partial = { type: RecordType; parts: Uint8Array[]; size: number };

/** Reassembles fragments. Messages may interleave; fragments of one message
 * arrive in order. Violations throw `RecordError`, and the channel closes. */
export class Reassembler {
  private partials = new Map<number, Partial>();
  private buffered = 0;

  constructor(private readonly maxMessage = MAX_MESSAGE) {}

  push(record: Uint8Array): { type: RecordType; payload: Uint8Array } | undefined {
    if (record.length < RECORD_HEADER) throw new RecordError("Record is too short");
    const type = record[0];
    const flags = record[1];
    if (type !== RECORD_JSON && type !== RECORD_DEFLATE)
      throw new RecordError("Unknown record type");
    if (flags & 0xfe) throw new RecordError("Reserved record flags are set");
    const msgId = ((record[2] << 24) | (record[3] << 16) | (record[4] << 8) | record[5]) >>> 0;
    const fragment = record.subarray(RECORD_HEADER);
    const fin = (flags & 1) === 1;
    let partial = this.partials.get(msgId);
    if (!partial) {
      if (fin) return { type, payload: fragment };
      if (this.partials.size >= MAX_PARTIALS) throw new RecordError("Too many partial messages");
      partial = { type, parts: [], size: 0 };
      this.partials.set(msgId, partial);
    } else if (partial.type !== type) throw new RecordError("Record type changed mid-message");
    partial.parts.push(fragment.slice());
    partial.size += fragment.length;
    this.buffered += fragment.length;
    if (partial.size > this.maxMessage) throw new RecordError("Message is too large");
    if (this.buffered > MAX_BUFFERED) throw new RecordError("Too much buffered data");
    if (!fin) return undefined;
    this.partials.delete(msgId);
    this.buffered -= partial.size;
    const payload = new Uint8Array(partial.size);
    let offset = 0;
    for (const part of partial.parts) {
      payload.set(part, offset);
      offset += part.length;
    }
    return { type: partial.type, payload };
  }
}
