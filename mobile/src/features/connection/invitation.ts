import type { Desktop, Identity } from "./nativeLink";

export type DesktopInvitation = Omit<Desktop, "deviceId" | "machine"> & {
  kind?: undefined;
  version: number;
  expires: number;
  identity: Identity;
};
/** A MonoCode host on another machine, from desktop Settings → Connections or
 *  its `monocode-host phone`: where it answers, and a one-use code. */
export type MachineInvitation = {
  kind: "host";
  version: number;
  name: string;
  environmentId: string;
  url: string;
  code: string;
  expires: number;
};
export type Invitation = DesktopInvitation | MachineInvitation;

export function parseInvitation(text: string): Invitation {
  if (text.length > 12_000) throw new Error("This pairing code is too large");
  const url = new URL(text.trim());
  if (url.protocol !== "monocode:" || url.hostname !== "pair")
    throw new Error(
      "Scan a Monocode pairing code from desktop Settings → Connections",
    );
  const code = url.searchParams.get("i");
  if (!code || !/^[A-Za-z0-9_-]+$/.test(code))
    throw new Error("Invalid pairing code");
  const base64 = code.replaceAll("-", "+").replaceAll("_", "/");
  const bytes = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const invitation = JSON.parse(
    decodeURIComponent(
      Array.from(
        bytes,
        (byte) => `%${byte.charCodeAt(0).toString(16).padStart(2, "0")}`,
      ).join(""),
    ),
  ) as Invitation;
  if (invitation.kind === "host") return machineInvitation(invitation);
  if (
    invitation.version !== 1 ||
    typeof invitation.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(invitation.fingerprint) ||
    !Array.isArray(invitation.addresses) ||
    invitation.addresses.length < 1 ||
    invitation.addresses.length > 16 ||
    !invitation.addresses.every(
      (address) =>
        typeof address.host === "string" &&
        address.host.length > 0 &&
        address.host.length <= 253 &&
        Number.isInteger(address.port) &&
        address.port > 0 &&
        address.port <= 65535,
    ) ||
    typeof invitation.identity?.certificate !== "string" ||
    typeof invitation.identity?.privateKey !== "string" ||
    typeof invitation.expires !== "number"
  )
    throw new Error("Invalid pairing code");
  if (invitation.expires <= Date.now() / 1000)
    throw new Error(
      "This code expired. Choose Pair phone on desktop to make a new one.",
    );
  return invitation;
}

function machineInvitation(invitation: MachineInvitation): MachineInvitation {
  if (
    invitation.version !== 1 ||
    typeof invitation.name !== "string" ||
    !invitation.name.trim() ||
    invitation.name.length > 255 ||
    typeof invitation.environmentId !== "string" ||
    !/^[A-Za-z0-9-]{1,64}$/.test(invitation.environmentId) ||
    typeof invitation.code !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(invitation.code) ||
    typeof invitation.expires !== "number" ||
    typeof invitation.url !== "string" ||
    !machineAddress(invitation.url)
  )
    throw new Error("Invalid pairing code");
  if (invitation.expires <= Date.now() / 1000)
    throw new Error(
      "This code expired. Choose Pair phone for the machine on desktop to make a new one.",
    );
  return invitation;
}

/** HTTPS anywhere, or HTTP inside a tailnet, as the link itself insists. */
function machineAddress(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host.endsWith(".ts.net") || host === "localhost" || host === "127.0.0.1") return true;
  const octets = host.split(".").map(Number);
  if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255))
    return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  return host.startsWith("fd7a:115c:a1e0:");
}
