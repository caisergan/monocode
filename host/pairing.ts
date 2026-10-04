// In-memory pairing offers (spec 04 §4.6, 09 §9.5). Secrets never touch disk:
// a host restart cancels every open offer.

import { randomBytes } from "node:crypto";
import { fromBase64Url, toBase64Url } from "@monocode/channel/bytes";
import type { Endpoint } from "@monocode/channel/envelope";
import { encodeOfferLink, type Offer, type OfferAppearance } from "@monocode/channel/offer";
import { confirmationCode, verifyPairingProof } from "@monocode/channel/pairing";
import type { PairingOffer, PairingStatus } from "@monocode/core/wire";
import type { DeviceStore } from "./devices";
import { HostError } from "./errors";

const MAX_OPEN = 8;
const DECISION_MS = 2 * 60_000;
const MAX_FAILURES = 3;

type OfferState = {
  id: string;
  secret: Uint8Array;
  status: PairingStatus["status"];
  expiresAt: number;
  decideBy?: number;
  createdBy: string;
  requireConfirmation: boolean;
  deviceId?: string;
  device?: PairingStatus["device"];
  code?: string;
  failures: number;
  replaces?: string;
};

export type ClaimInfo = {
  name: string;
  platform: string;
  model?: string;
  os?: string;
  appVersion?: string;
  replacesDeviceId?: string;
};

type Listener = (offerId: string, status: PairingStatus) => void;

export class PairingManager {
  private offers = new Map<string, OfferState>();
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly devices: DeviceStore,
    private readonly host: {
      environmentId: string;
      name: () => string;
      hostKey: Uint8Array;
      fingerprint: string;
      endpoints: () => Endpoint[];
      linkBase: () => string;
      defaultTtlSeconds: () => number;
      requireConfirmation: () => boolean;
    },
  ) {
    this.timer = setInterval(() => this.expire(), 1_000);
    this.timer.unref?.();
  }

  /** Called with every status change (approved, denied, expired, cancelled). */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(offer: OfferState): void {
    const status = this.view(offer);
    for (const listener of this.listeners) listener(offer.id, status);
  }

  private view(offer: OfferState): PairingStatus {
    return {
      offerId: offer.id,
      status: offer.status,
      expiresAt: offer.expiresAt,
      ...(offer.device ? { device: offer.device } : {}),
      ...(offer.code ? { code: offer.code } : {}),
    };
  }

  private get(offerId: string): OfferState {
    const offer = this.offers.get(offerId);
    if (!offer) throw new HostError("pairing_expired", "This code expired. Generate a new one.");
    return offer;
  }

  create(input: {
    createdBy: string;
    ttlSeconds?: number;
    label?: string;
    ui?: OfferAppearance;
    autoApprove?: boolean;
  }): PairingOffer & { offer: Offer } {
    const endpoints = this.host.endpoints();
    if (!endpoints.length)
      throw new HostError(
        "invalid_params",
        "Turn on direct connections or the relay first. No private network address was found on this host.",
      );
    const open = [...this.offers.values()].filter((offer) => offer.status === "open");
    if (open.length >= MAX_OPEN) this.finish(open[0], "cancelled");
    const ttl = Math.max(60, Math.min(1_800, Math.floor(input.ttlSeconds ?? this.host.defaultTtlSeconds())));
    const id = toBase64Url(randomBytes(16));
    const secret = new Uint8Array(randomBytes(32));
    const expiresAt = Date.now() + ttl * 1_000;
    this.offers.set(id, {
      id,
      secret,
      status: "open",
      expiresAt,
      createdBy: input.createdBy,
      requireConfirmation: !input.autoApprove && this.host.requireConfirmation(),
      failures: 0,
    });
    const offer: Offer = {
      v: 1,
      env: this.host.environmentId,
      name: (input.label?.trim() || this.host.name()).slice(0, 64),
      key: toBase64Url(this.host.hostKey),
      offer: id,
      secret: toBase64Url(secret),
      exp: Math.floor(expiresAt / 1_000),
      direct: endpoints,
      ...(input.ui ? { ui: input.ui } : {}),
    };
    return {
      offerId: id,
      url: encodeOfferLink(offer, this.host.linkBase()),
      expiresAt,
      fingerprint: this.host.fingerprint,
      reachable: {
        lan: endpoints.some((endpoint) => endpoint.kind === "lan"),
        tailscale: endpoints.some((endpoint) => endpoint.kind === "tailscale"),
        manual: endpoints.some((endpoint) => endpoint.kind === "manual"),
        relay: false,
      },
      offer,
    };
  }

  /** For the handshake: an offer a phone may still claim. */
  openOffer(offerId: string): { expiresAt: number } | undefined {
    const offer = this.offers.get(offerId);
    return offer && offer.status === "open" && offer.expiresAt > Date.now()
      ? { expiresAt: offer.expiresAt }
      : undefined;
  }

  status(offerId: string): PairingStatus {
    return this.view(this.get(offerId));
  }

  claim(
    offerId: string,
    proof: string,
    handshakeHash: Uint8Array,
    remoteStatic: Uint8Array,
    info: ClaimInfo,
  ): { status: "pending" | "approved"; deviceId: string; code: string } {
    const offer = this.get(offerId);
    if (offer.status === "expired" || offer.expiresAt <= Date.now())
      throw new HostError("pairing_expired", "This code expired. Generate a new one.");
    if (offer.status === "cancelled")
      throw new HostError("pairing_cancelled", "This code was cancelled. Generate a new one.");
    if (offer.status !== "open")
      throw new HostError("pairing_used", "This code was already used. Generate a new one.");
    let valid = false;
    try {
      valid = verifyPairingProof(offer.secret, handshakeHash, fromBase64Url(proof));
    } catch {
      valid = false;
    }
    if (!valid) {
      offer.failures++;
      if (offer.failures >= MAX_FAILURES) this.finish(offer, "cancelled");
      throw new HostError("pairing_proof_invalid", "Pairing failed. Generate a new code and try again.");
    }
    const publicKey = toBase64Url(remoteStatic);
    const existing = this.devices.byPublicKey(publicKey);
    if (existing?.status === "active")
      throw new HostError("device_key_in_use", "This phone is already paired with this host.");
    if (existing) this.devices.discardPending(existing.deviceId, "superseded");
    const name = info.name.trim().slice(0, 64) || "Phone";
    const deviceId = this.devices.addMobile({
      name,
      publicKey,
      platform: info.platform,
      model: info.model,
      os: info.os,
      appVersion: info.appVersion,
      offerId,
    });
    offer.status = "claimed";
    offer.deviceId = deviceId;
    offer.device = { id: deviceId, name, platform: info.platform, ...(info.model ? { model: info.model } : {}) };
    offer.code = confirmationCode(handshakeHash);
    offer.decideBy = Date.now() + DECISION_MS;
    offer.replaces = info.replacesDeviceId;
    if (!offer.requireConfirmation) {
      this.approve(offer);
      return { status: "approved", deviceId, code: offer.code };
    }
    this.emit(offer);
    return { status: "pending", deviceId, code: offer.code };
  }

  decide(offerId: string, allow: boolean, by: string): PairingStatus {
    const offer = this.get(offerId);
    if (offer.status !== "claimed")
      throw new HostError("invalid_params", "Nothing is waiting for a decision on this code.");
    if (allow) this.approve(offer, by);
    else this.finish(offer, "denied");
    return this.view(offer);
  }

  cancel(offerId: string): PairingStatus {
    const offer = this.get(offerId);
    if (offer.status === "open" || offer.status === "claimed") this.finish(offer, "cancelled");
    return this.view(offer);
  }

  private approve(offer: OfferState, by?: string): void {
    this.devices.activate(offer.deviceId!);
    if (offer.replaces && offer.replaces !== offer.deviceId) {
      const old = this.devices.get(offer.replaces);
      if (old?.kind === "mobile") this.devices.revoke(offer.replaces, by ?? offer.deviceId);
    }
    offer.status = "approved";
    offer.secret.fill(0);
    this.emit(offer);
  }

  private finish(offer: OfferState, status: "denied" | "expired" | "cancelled"): void {
    if (offer.deviceId && offer.status === "claimed") this.devices.discardPending(offer.deviceId, status);
    offer.status = status;
    offer.secret.fill(0);
    this.emit(offer);
  }

  private expire(): void {
    const now = Date.now();
    for (const offer of this.offers.values()) {
      if (offer.status === "open" && offer.expiresAt <= now) this.finish(offer, "expired");
      else if (offer.status === "claimed" && (offer.decideBy ?? 0) <= now) this.finish(offer, "expired");
      // Keep closed offers briefly so a polling desktop or CLI sees the outcome.
      else if (
        offer.status !== "open" &&
        offer.status !== "claimed" &&
        now - Math.max(offer.expiresAt, offer.decideBy ?? 0) > 10 * 60_000
      )
        this.offers.delete(offer.id);
    }
  }

  close(): void {
    clearInterval(this.timer);
    for (const offer of this.offers.values())
      if (offer.status === "open" || offer.status === "claimed") this.finish(offer, "cancelled");
  }
}
