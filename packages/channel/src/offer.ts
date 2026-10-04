// Pairing offers (spec 04 §4.2): the JSON a QR code or link carries.

import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from "./bytes";
import type { Endpoint } from "./envelope";

export type OfferAppearance = {
  theme: "dark" | "light" | "system";
  hue: number;
  sat: number;
  dark: number;
  accent: string | null;
};

export type Offer = {
  v: 1;
  env: string;
  name: string;
  key: string;
  offer: string;
  secret: string;
  exp: number;
  direct?: Endpoint[];
  relay?: { url: string; room: string };
  ui?: OfferAppearance;
};

export class OfferError extends Error {
  constructor(
    readonly reason: "malformed" | "version",
    message: string,
  ) {
    super(message);
  }
}

const MAX_OFFER_JSON = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOSTNAME = /^[a-z0-9.-]{1,253}$/i;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function encodeOfferLink(offer: Offer, linkBase: string): string {
  return `${linkBase}#o=${toBase64Url(utf8(JSON.stringify(offer)))}`;
}

function isAddress(addr: string): boolean {
  const v4 = addr.match(IPV4);
  if (v4) return v4.slice(1).every((part) => Number(part) <= 255);
  if (addr.includes(":")) return /^[0-9a-f:.]+$/i.test(addr);
  return HOSTNAME.test(addr);
}

function bytesOfLength(value: unknown, length: number): boolean {
  if (typeof value !== "string") return false;
  try {
    return fromBase64Url(value).length === length;
  } catch {
    return false;
  }
}

/** Accepts any MonoCode pairing link (https, monocode://, monocode-dev://) or
 * the bare encoded offer. Validates before any network traffic. */
export function parseOfferLink(text: string, options: { allowInsecureRelay?: boolean } = {}): Offer {
  const trimmed = text.trim();
  const fragment = trimmed.includes("#") ? trimmed.slice(trimmed.indexOf("#") + 1) : trimmed;
  const encoded = fragment
    .split("&")
    .map((part) => part.split("="))
    .find(([name]) => name === "o")?.[1] ?? (fragment.includes("=") ? undefined : fragment);
  if (!encoded) throw new OfferError("malformed", "This isn't a MonoCode pairing code.");
  let value: unknown;
  try {
    const bytes = fromBase64Url(encoded);
    if (bytes.length > MAX_OFFER_JSON) throw new Error("too large");
    value = JSON.parse(fromUtf8(bytes));
  } catch {
    throw new OfferError("malformed", "This isn't a MonoCode pairing code.");
  }
  return validateOffer(value, options);
}

export function validateOffer(value: unknown, options: { allowInsecureRelay?: boolean } = {}): Offer {
  const bad = () => new OfferError("malformed", "This isn't a MonoCode pairing code.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad();
  const offer = value as Record<string, unknown>;
  if (offer.v !== 1)
    throw new OfferError("version", "Update MonoCode to pair with this machine.");
  if (typeof offer.env !== "string" || !UUID.test(offer.env)) throw bad();
  if (!bytesOfLength(offer.key, 32) || !bytesOfLength(offer.secret, 32)) throw bad();
  if (!bytesOfLength(offer.offer, 16)) throw bad();
  if (typeof offer.exp !== "number" || !Number.isFinite(offer.exp)) throw bad();
  const name = typeof offer.name === "string" && offer.name.trim()
    ? offer.name.trim().slice(0, 64)
    : "Computer";
  const direct: Endpoint[] = [];
  if (offer.direct !== undefined) {
    if (!Array.isArray(offer.direct)) throw bad();
    for (const raw of offer.direct.slice(0, 8)) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      if (entry.kind !== "lan" && entry.kind !== "tailscale" && entry.kind !== "manual") continue;
      if (typeof entry.addr !== "string" || !isAddress(entry.addr)) throw bad();
      if (!Number.isInteger(entry.port) || Number(entry.port) < 1 || Number(entry.port) > 65_535)
        throw bad();
      const endpoint = { kind: entry.kind, addr: entry.addr, port: Number(entry.port) } as Endpoint;
      if (entry.kind === "tailscale" && typeof entry.dns === "string" && HOSTNAME.test(entry.dns))
        (endpoint as Extract<Endpoint, { kind: "tailscale" }>).dns = entry.dns;
      direct.push(endpoint);
    }
  }
  let relay: Offer["relay"];
  if (offer.relay !== undefined) {
    const raw = offer.relay as Record<string, unknown> | null;
    if (!raw || typeof raw.url !== "string" || typeof raw.room !== "string") throw bad();
    const secure = raw.url.startsWith("wss://");
    if (!secure && !(options.allowInsecureRelay && raw.url.startsWith("ws://"))) throw bad();
    relay = { url: raw.url, room: raw.room };
  }
  if (!direct.length && !relay) throw bad();
  return {
    v: 1,
    env: offer.env,
    name,
    key: offer.key as string,
    offer: offer.offer as string,
    secret: offer.secret as string,
    exp: offer.exp,
    ...(direct.length ? { direct } : {}),
    ...(relay ? { relay } : {}),
    ...(offer.ui && typeof offer.ui === "object" ? { ui: offer.ui as OfferAppearance } : {}),
  };
}
