// Byte helpers that run the same on Node and Hermes (no Buffer, no TextEncoder
// assumptions beyond what both provide).

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64URL.length; i++) table[B64URL.charCodeAt(i)] = i;
  // Accept standard base64 too, so pasted values decode either way.
  table["+".charCodeAt(0)] = 62;
  table["/".charCodeAt(0)] = 63;
  return table;
})();

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[n >> 18] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64URL[n >> 18] + B64URL[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64URL[(n >> 6) & 63];
  }
  return out;
}

/** Throws on characters outside base64/base64url. Padding is ignored. */
export function fromBase64Url(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  if (clean.length % 4 === 1) throw new Error("Invalid base64url length");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const digit = code < 128 ? B64_LOOKUP[code] : -1;
    if (digit < 0) throw new Error("Invalid base64url character");
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2) throw new Error("Invalid hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("Invalid hex");
    out[i] = byte;
  }
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// The package type-checks without DOM or Node types, so declare the two
// globals it uses. Hermes has TextEncoder; older Hermes builds lack
// TextDecoder, so decoding falls back to a plain implementation.
type Encoder = { encode(text: string): Uint8Array };
type Decoder = { decode(bytes: Uint8Array): string };
const globals = globalThis as unknown as {
  TextEncoder?: new () => Encoder;
  TextDecoder?: new (label: string, options: { fatal: boolean }) => Decoder;
};
const encoder: Encoder | undefined = globals.TextEncoder ? new globals.TextEncoder() : undefined;
const decoder: Decoder | undefined = (() => {
  try {
    return globals.TextDecoder ? new globals.TextDecoder("utf-8", { fatal: true }) : undefined;
  } catch {
    return undefined;
  }
})();

export function utf8(text: string): Uint8Array {
  if (encoder) return encoder.encode(text);
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code < 0xdc00 && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low < 0xe000) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000)
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
  }
  return Uint8Array.from(out);
}

export function fromUtf8(bytes: Uint8Array): string {
  if (decoder) return decoder.decode(bytes);
  let out = "";
  const chunk: number[] = [];
  for (let i = 0; i < bytes.length; ) {
    const a = bytes[i++];
    let code: number;
    if (a < 0x80) code = a;
    else if (a >= 0xc2 && a < 0xe0) code = ((a & 31) << 6) | (bytes[i++] & 63);
    else if (a >= 0xe0 && a < 0xf0)
      code = ((a & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else if (a >= 0xf0 && a < 0xf5)
      code =
        ((a & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else throw new Error("Invalid UTF-8");
    if (code > 0xffff) {
      code -= 0x10000;
      chunk.push(0xd800 + (code >> 10), 0xdc00 + (code & 1023));
    } else chunk.push(code);
    if (chunk.length > 8192) {
      out += String.fromCharCode(...chunk);
      chunk.length = 0;
    }
  }
  return out + String.fromCharCode(...chunk);
}

/** Crockford base32, used for human-readable fingerprints. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function toCrockford(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}
