// The phone's pairing steps (04 §4.7): validate the offer, make a device key
// for this host, connect with the offer, prove the secret, then wait while
// the person at the computer compares the code and allows it.

import * as Device from "expo-device";
import {
  ChannelRequestError,
  HandshakeFailure,
  OfferError,
  confirmationCode,
  fromBase64Url,
  generateKeyPair,
  isPairingWelcome,
  pairingProof,
  parseOfferLink,
  toBase64Url,
  type Channel,
  type Offer,
  type Welcome,
} from "@monocode/channel";
import { projectColor } from "@monocode/design";
import { addPairedHost } from "@/hosts/registry";
import { appInfo, race } from "@/hosts/connect";
import type { HostRecord } from "@/hosts/types";

export type PairingStep =
  | { kind: "connecting" }
  | { kind: "confirm"; code: string; expiresAt: number }
  | { kind: "paired"; record: HostRecord }
  | { kind: "failed"; message: string };

export function readOffer(text: string): Offer {
  return parseOfferLink(text, { allowInsecureRelay: __DEV__ });
}

export function offerError(error: unknown): string {
  if (error instanceof OfferError) return error.message;
  return "This isn't a MonoCode pairing code.";
}

const MESSAGES: Record<string, (host: string) => string> = {
  handshake_failed: (host) => `This code doesn't match ${host}. Generate a new code and scan again.`,
  pairing_expired: (host) => `This code expired. Generate a new one on ${host}.`,
  pairing_used: () => "This code was already used. Generate a new one.",
  pairing_cancelled: () => "This code was cancelled. Generate a new one.",
  pairing_proof_invalid: () => "Pairing failed. Generate a new code and try again.",
  protocol_incompatible: (host) => `${host} runs an older MonoCode host. Update it, then try again.`,
  device_key_in_use: (host) => `This phone is already paired with ${host}.`,
};

function explain(error: unknown, host: string): string {
  const code = error instanceof HandshakeFailure || error instanceof ChannelRequestError ? error.code : undefined;
  if (code && MESSAGES[code]) return MESSAGES[code](host);
  return `Can't reach ${host}. Check that your phone is on the same network or Tailscale.`;
}

/** Runs the whole flow; `onStep` drives the screen. Returns a cancel function. */
export function pair(offer: Offer, phoneName: string, onStep: (step: PairingStep) => void): () => void {
  let channel: Channel | undefined;
  let cancelled = false;
  const deviceKey = generateKeyPair();
  onStep({ kind: "connecting" });
  void (async () => {
    try {
      const connected = await race({
        env: offer.env,
        hostKey: offer.key,
        deviceKey,
        endpoints: offer.direct ?? [],
        nextCounter: async () => 0,
        pairOffer: offer.offer,
      });
      channel = connected.channel;
      if (cancelled) {
        channel.close();
        return;
      }
      if (!isPairingWelcome(connected.reply)) throw new Error("Unexpected welcome");
      const approved = new Promise<Welcome>((resolve, reject) => {
        channel!.onEvent((name, data) => {
          if (name !== "pair.status") return;
          const status = data as { status: string; welcome?: Welcome };
          if (status.status === "approved" && status.welcome) resolve(status.welcome);
          else if (status.status === "denied") reject(new Error(`${offer.name} didn't allow this phone.`));
          else if (status.status === "expired") reject(new Error("Nobody approved the connection in time."));
          else reject(new Error("Pairing was cancelled on the computer."));
        });
        channel!.onClose(() => reject(new Error("The connection closed before pairing finished.")));
      });
      const info = appInfo();
      const claim = await channel.request<{ status: string; code: string; deviceId: string; welcome?: Welcome }>(
        "pair.claim",
        {
          offer: offer.offer,
          proof: toBase64Url(pairingProof(fromBase64Url(offer.secret), channel.handshakeHash)),
          name: phoneName.trim() || Device.deviceName || "iPhone",
          platform: info.platform,
          model: Device.modelName ?? info.model,
          os: info.os,
          appVersion: info.version,
        },
      );
      // Both screens derive the code from this channel's handshake hash.
      const code = confirmationCode(channel.handshakeHash);
      if (claim.code !== code) throw new Error("The confirmation codes don't match. Don't approve this phone.");
      let welcome = claim.welcome;
      if (!welcome) {
        onStep({ kind: "confirm", code, expiresAt: Date.now() + 120_000 });
        welcome = await approved;
      }
      const record: HostRecord = {
        env: offer.env,
        label: offer.name,
        color: projectColor(offer.env),
        hostName: welcome.host.name,
        platform: welcome.host.platform,
        fingerprint: welcome.host.fingerprint,
        hostKey: offer.key,
        deviceId: welcome.device.id,
        role: welcome.device.role,
        endpoints: welcome.endpoints.length ? welcome.endpoints : offer.direct ?? [],
        pairedAt: Date.now(),
        lastOnlineAt: Date.now(),
        lastWelcome: {
          host: welcome.host,
          capabilities: welcome.capabilities,
          providers: welcome.providers,
          limits: welcome.limits,
        },
      };
      // This pairing channel would keep working, but the runtime opens its
      // own device channel; close this one cleanly.
      channel.sayBye("replaced");
      await addPairedHost(record, deviceKey);
      if (!cancelled) onStep({ kind: "paired", record });
    } catch (error) {
      channel?.close();
      if (cancelled) return;
      onStep({ kind: "failed", message: error instanceof Error && !(error instanceof HandshakeFailure) && !(error instanceof ChannelRequestError) && !/reach/.test(error.message) ? error.message : explain(error, offer.name) });
    }
  })();
  return () => {
    cancelled = true;
    channel?.close();
  };
}
