// Pairing proof, confirmation code and host fingerprint (spec 03 §3.2, §3.6).

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, equalBytes, toCrockford, utf8 } from "./bytes";

/** HMAC-SHA256(secret, "monocode/pair/1" || h) */
export function pairingProof(secret: Uint8Array, handshakeHash: Uint8Array): Uint8Array {
  return hmac(sha256, secret, concat(utf8("monocode/pair/1"), handshakeHash));
}

export function verifyPairingProof(
  secret: Uint8Array,
  handshakeHash: Uint8Array,
  proof: Uint8Array,
): boolean {
  return equalBytes(pairingProof(secret, handshakeHash), proof);
}

/** Six digits both screens show; equal codes mean the same channel. */
export function confirmationCode(handshakeHash: Uint8Array): string {
  const digest = sha256(concat(utf8("monocode/sas/1"), handshakeHash));
  const value =
    ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  return String(value % 1_000_000).padStart(6, "0");
}

/** "482913" → "482 913" */
export function formatCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/** First 20 bytes of SHA-256(host key), Crockford base32, in groups of four. */
export function hostFingerprint(hostPublicKey: Uint8Array): string {
  const text = toCrockford(sha256(hostPublicKey).subarray(0, 20));
  return text.match(/.{1,4}/g)!.join("-");
}

/** Short id shown in logs and lists, never the full key. */
export function keyHash(publicKey: Uint8Array): Uint8Array {
  return sha256(publicKey);
}
