// Host keys (spec 03 §3.2): the X25519 Noise static key phones pin, and the
// Ed25519 key that will authenticate the host to a relay.

import { existsSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { fromBase64Url, toBase64Url } from "@monocode/channel/bytes";
import { generateKeyPair, keyPairFromSecret, type KeyPair } from "@monocode/channel/noise";
import { hostFingerprint } from "@monocode/channel/pairing";

export type HostKeys = {
  createdAt: number;
  host: KeyPair;
  relay: { publicKey: Uint8Array; secretKey: Uint8Array };
  fingerprint: string;
};

type KeyFile = {
  v: 1;
  createdAt: number;
  host: { public: string; private: string };
  relay: { public: string; private: string };
};

/** Writes atomically (temp file, fsync, rename) with mode 0600. */
export function writePrivateFile(path: string, contents: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, contents, { mode: 0o600 });
  const fd = openSync(temp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

function fresh(): KeyFile {
  const host = generateKeyPair();
  const relaySecret = ed25519.utils.randomSecretKey();
  return {
    v: 1,
    createdAt: Date.now(),
    host: { public: toBase64Url(host.publicKey), private: toBase64Url(host.secretKey) },
    relay: {
      public: toBase64Url(ed25519.getPublicKey(relaySecret)),
      private: toBase64Url(relaySecret),
    },
  };
}

function decode(file: KeyFile): HostKeys {
  const host = keyPairFromSecret(fromBase64Url(file.host.private));
  if (toBase64Url(host.publicKey) !== file.host.public) throw new Error("keys.json is corrupt");
  return {
    createdAt: file.createdAt,
    host,
    relay: { publicKey: fromBase64Url(file.relay.public), secretKey: fromBase64Url(file.relay.private) },
    fingerprint: hostFingerprint(host.publicKey),
  };
}

export function loadOrCreateKeys(directory: string): HostKeys {
  const path = join(directory, "keys.json");
  if (existsSync(path)) return decode(JSON.parse(readFileSync(path, "utf8")) as KeyFile);
  const file = fresh();
  writePrivateFile(path, JSON.stringify(file, null, 2));
  return decode(file);
}

/** New host and relay keys. Every phone pinned the old key and must re-pair. */
export function rotateKeys(directory: string): HostKeys {
  const file = fresh();
  writePrivateFile(join(directory, "keys.json"), JSON.stringify(file, null, 2));
  return decode(file);
}
