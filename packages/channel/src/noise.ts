// Noise_IK_25519_ChaChaPoly_SHA256 (Noise spec rev 34), specialised to the one
// pattern MonoCode uses:
//
//   <- s
//   ...
//   -> e, es, s, ss     (phone → host, payload: hello)
//   <- e, ee, se        (host → phone, payload: welcome or error)
//
// Verified against the cacophony and snow test vectors (noise.test.ts).

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, utf8 } from "./bytes";

export const NOISE_PROTOCOL = "Noise_IK_25519_ChaChaPoly_SHA256";
export const MAX_NOISE_MESSAGE = 65_535;
export const DH_LEN = 32;
export const TAG_LEN = 16;
const EMPTY = new Uint8Array(0);

export type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array };

export function generateKeyPair(): KeyPair {
  return keyPairFromSecret(x25519.utils.randomSecretKey());
}

export function keyPairFromSecret(secretKey: Uint8Array): KeyPair {
  if (secretKey.length !== DH_LEN) throw new Error("Invalid X25519 secret key");
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

function dh(pair: KeyPair, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(pair.secretKey, publicKey);
}

/** 32 bits of zeros followed by the little-endian 64-bit counter. */
function nonce(n: number): Uint8Array {
  const out = new Uint8Array(12);
  let value = n;
  for (let i = 4; i < 12; i++) {
    out[i] = value % 256;
    value = Math.floor(value / 256);
  }
  return out;
}

function hkdf2(chainingKey: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmac(sha256, chainingKey, input);
  const first = hmac(sha256, temp, Uint8Array.of(1));
  const second = hmac(sha256, temp, concat(first, Uint8Array.of(2)));
  return [first, second];
}

export class CipherState {
  private n = 0;
  constructor(private readonly key?: Uint8Array) {}

  hasKey(): boolean {
    return !!this.key;
  }

  /** Messages sent or received so far. */
  get count(): number {
    return this.n;
  }

  encrypt(plaintext: Uint8Array, ad: Uint8Array = EMPTY): Uint8Array {
    if (!this.key) return plaintext;
    if (this.n >= Number.MAX_SAFE_INTEGER) throw new Error("Noise nonce exhausted");
    const out = chacha20poly1305(this.key, nonce(this.n), ad).encrypt(plaintext);
    this.n++;
    return out;
  }

  /** Throws when authentication fails. The caller must then close the channel. */
  decrypt(ciphertext: Uint8Array, ad: Uint8Array = EMPTY): Uint8Array {
    if (!this.key) return ciphertext;
    if (this.n >= Number.MAX_SAFE_INTEGER) throw new Error("Noise nonce exhausted");
    const out = chacha20poly1305(this.key, nonce(this.n), ad).decrypt(ciphertext);
    this.n++;
    return out;
  }
}

class SymmetricState {
  h: Uint8Array;
  private ck: Uint8Array;
  private cipher = new CipherState();

  constructor() {
    const name = utf8(NOISE_PROTOCOL);
    if (name.length <= 32) {
      this.h = new Uint8Array(32);
      this.h.set(name);
    } else this.h = sha256(name);
    this.ck = this.h;
  }

  mixKey(input: Uint8Array): void {
    const [ck, key] = hkdf2(this.ck, input);
    this.ck = ck;
    this.cipher = new CipherState(key);
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(concat(this.h, data));
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encrypt(plaintext, this.h);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decrypt(ciphertext, this.h);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [first, second] = hkdf2(this.ck, EMPTY);
    return [new CipherState(first), new CipherState(second)];
  }
}

/** The result of a completed handshake: one cipher per direction, plus the
 * handshake hash that names this channel (pairing proof, confirmation code). */
export type NoiseTransport = {
  send: CipherState;
  receive: CipherState;
  handshakeHash: Uint8Array;
  remoteStatic: Uint8Array;
};

export class IKInitiator {
  private readonly state = new SymmetricState();
  private ephemeral?: KeyPair;
  private done = false;

  constructor(
    private readonly options: {
      staticKey: KeyPair;
      remoteStatic: Uint8Array;
      prologue: Uint8Array;
      /** Tests only: a fixed ephemeral key. */
      ephemeral?: KeyPair;
    },
  ) {
    if (options.remoteStatic.length !== DH_LEN) throw new Error("Invalid host key");
    this.state.mixHash(options.prologue);
    this.state.mixHash(options.remoteStatic);
  }

  /** -> e, es, s, ss */
  writeMessage1(payload: Uint8Array): Uint8Array {
    if (this.ephemeral) throw new Error("Handshake message 1 was already written");
    const e = this.options.ephemeral ?? generateKeyPair();
    this.ephemeral = e;
    this.state.mixHash(e.publicKey);
    this.state.mixKey(dh(e, this.options.remoteStatic));
    const encryptedStatic = this.state.encryptAndHash(this.options.staticKey.publicKey);
    this.state.mixKey(dh(this.options.staticKey, this.options.remoteStatic));
    const encryptedPayload = this.state.encryptAndHash(payload);
    const message = concat(e.publicKey, encryptedStatic, encryptedPayload);
    if (message.length > MAX_NOISE_MESSAGE) throw new Error("Handshake payload is too large");
    return message;
  }

  /** <- e, ee, se */
  readMessage2(message: Uint8Array): { payload: Uint8Array; transport: NoiseTransport } {
    if (!this.ephemeral || this.done) throw new Error("Unexpected handshake message 2");
    if (message.length < DH_LEN + TAG_LEN) throw new Error("Handshake message 2 is too short");
    const re = message.subarray(0, DH_LEN);
    this.state.mixHash(re);
    this.state.mixKey(dh(this.ephemeral, re));
    this.state.mixKey(dh(this.options.staticKey, re));
    const payload = this.state.decryptAndHash(message.subarray(DH_LEN));
    const [initiatorToResponder, responderToInitiator] = this.state.split();
    this.done = true;
    return {
      payload,
      transport: {
        send: initiatorToResponder,
        receive: responderToInitiator,
        handshakeHash: this.state.h,
        remoteStatic: this.options.remoteStatic,
      },
    };
  }
}

export class IKResponder {
  private readonly state = new SymmetricState();
  private remoteEphemeral?: Uint8Array;
  private remoteStatic?: Uint8Array;
  private done = false;

  constructor(
    private readonly options: {
      staticKey: KeyPair;
      prologue: Uint8Array;
      /** Tests only: a fixed ephemeral key. */
      ephemeral?: KeyPair;
    },
  ) {
    this.state.mixHash(options.prologue);
    this.state.mixHash(options.staticKey.publicKey);
  }

  /** Throws when the message was not made for this host key and prologue. */
  readMessage1(message: Uint8Array): { payload: Uint8Array; remoteStatic: Uint8Array } {
    if (this.remoteEphemeral) throw new Error("Unexpected handshake message 1");
    if (message.length < DH_LEN + DH_LEN + TAG_LEN + TAG_LEN)
      throw new Error("Handshake message 1 is too short");
    const re = message.subarray(0, DH_LEN);
    this.remoteEphemeral = re;
    this.state.mixHash(re);
    this.state.mixKey(dh(this.options.staticKey, re));
    const rs = this.state.decryptAndHash(message.subarray(DH_LEN, DH_LEN * 2 + TAG_LEN));
    this.remoteStatic = rs;
    this.state.mixKey(dh(this.options.staticKey, rs));
    const payload = this.state.decryptAndHash(message.subarray(DH_LEN * 2 + TAG_LEN));
    return { payload, remoteStatic: rs };
  }

  /** <- e, ee, se */
  writeMessage2(payload: Uint8Array): { message: Uint8Array; transport: NoiseTransport } {
    if (!this.remoteEphemeral || !this.remoteStatic || this.done)
      throw new Error("Unexpected handshake message 2");
    const e = this.options.ephemeral ?? generateKeyPair();
    this.state.mixHash(e.publicKey);
    this.state.mixKey(dh(e, this.remoteEphemeral));
    this.state.mixKey(dh(e, this.remoteStatic));
    const encryptedPayload = this.state.encryptAndHash(payload);
    const message = concat(e.publicKey, encryptedPayload);
    if (message.length > MAX_NOISE_MESSAGE) throw new Error("Handshake payload is too large");
    const [initiatorToResponder, responderToInitiator] = this.state.split();
    this.done = true;
    return {
      message,
      transport: {
        send: responderToInitiator,
        receive: initiatorToResponder,
        handshakeHash: this.state.h,
        remoteStatic: this.remoteStatic,
      },
    };
  }
}
