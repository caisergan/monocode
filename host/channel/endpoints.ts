// Addresses phones are offered (spec 05 §5.2).

import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { execFile } from "node:child_process";
import type { Endpoint } from "@monocode/channel/envelope";

const VIRTUAL = /^(docker|br-|veth|virbr|vmnet|vboxnet|bridge|awdl|llw|lo|utun|anpi|ap\d)/;
const PRIMARY = /^(en0|eth0|wlan0)$/;
const MAX_ENDPOINTS = 8;

function ipv4Parts(address: string): number[] {
  return address.split(".").map(Number);
}

export function isTailscaleAddress(address: string, family: string): boolean {
  if (family === "IPv4") {
    const [a, b] = ipv4Parts(address);
    return a === 100 && b >= 64 && b <= 127;
  }
  return address.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

export function isLanAddress(address: string, family: string): boolean {
  if (family === "IPv4") {
    const [a, b] = ipv4Parts(address);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const lower = address.toLowerCase();
  return (lower.startsWith("fc") || lower.startsWith("fd")) && !lower.startsWith("fd7a:115c:a1e0:");
}

export type ClassifiedAddress = { kind: "lan" | "tailscale"; addr: string; iface: string; family: string };

/** Classifies `os.networkInterfaces()` output. Pure, for tests. */
export function classifyInterfaces(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): ClassifiedAddress[] {
  const out: ClassifiedAddress[] = [];
  for (const [iface, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.internal) continue;
      const family = String(info.family);
      if (family === "IPv6" && info.address.toLowerCase().startsWith("fe80")) continue;
      if (family === "IPv4" && info.address.startsWith("169.254.")) continue;
      // Tailscale runs on a utun interface on macOS; accept its range anywhere.
      if (isTailscaleAddress(info.address, family))
        out.push({ kind: "tailscale", addr: info.address, iface, family });
      else if (!VIRTUAL.test(iface) && isLanAddress(info.address, family))
        out.push({ kind: "lan", addr: info.address, iface, family });
    }
  }
  const rank = (entry: ClassifiedAddress) =>
    (entry.kind === "lan" ? 0 : 2) + (PRIMARY.test(entry.iface) ? 0 : 1) + (entry.family === "IPv4" ? 0 : 0.5);
  return out.sort((a, b) => rank(a) - rank(b));
}

let tailscaleName: { value?: string; at: number } = { at: 0 };

/** MagicDNS name from `tailscale status --json`, cached for five minutes. */
function tailscaleDns(): Promise<string | undefined> {
  if (Date.now() - tailscaleName.at < 300_000) return Promise.resolve(tailscaleName.value);
  return new Promise((resolve) => {
    execFile("tailscale", ["status", "--json"], { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      let value: string | undefined;
      if (!error) {
        try {
          const name = String(JSON.parse(stdout)?.Self?.DNSName ?? "").replace(/\.$/, "");
          value = name || undefined;
        } catch {
          value = undefined;
        }
      }
      tailscaleName = { value, at: Date.now() };
      resolve(value);
    });
  });
}

export async function discoverEndpoints(
  port: number,
  advertise: { addr: string; port: number }[],
  interfaces = networkInterfaces(),
): Promise<{ endpoints: Endpoint[]; bind: string[] }> {
  const classified = classifyInterfaces(interfaces);
  const dns = classified.some((entry) => entry.kind === "tailscale") ? await tailscaleDns() : undefined;
  const endpoints: Endpoint[] = [];
  let namedTailscale = false;
  for (const entry of classified) {
    if (entry.kind === "tailscale" && dns && !namedTailscale && entry.family === "IPv4") {
      endpoints.push({ kind: "tailscale", addr: entry.addr, port, dns });
      namedTailscale = true;
    } else endpoints.push({ kind: entry.kind, addr: entry.addr, port });
  }
  for (const manual of advertise) endpoints.push({ kind: "manual", addr: manual.addr, port: manual.port });
  return { endpoints: endpoints.slice(0, MAX_ENDPOINTS), bind: classified.map((entry) => entry.addr) };
}
