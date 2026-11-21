import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * How a phone reaches this host without the desktop: through Tailscale Serve,
 * which forwards the tailnet to the loopback port the host listens on. The
 * host itself never listens anywhere else.
 *
 * - `ready`: Serve already forwards `url` to this host.
 * - `serve`: Tailscale is up; `command` turns Serve on for this host.
 * - `stopped`: Tailscale is installed but not connected to a tailnet.
 * - `missing`: no Tailscale CLI was found.
 */
export type PhoneReach =
  | { state: "ready"; url: string; secure: boolean }
  | { state: "serve"; url: string; secure: boolean; command: string[] }
  | { state: "stopped" }
  | { state: "missing" };

type Status = {
  BackendState?: string;
  Self?: { DNSName?: string };
  CertDomains?: string[] | null;
};
type ServeConfig = {
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean; TCPForward?: string }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
};

/** The Tailscale CLI: on PATH, or where the macOS app keeps it. */
async function cli(): Promise<string | undefined> {
  const candidates = [
    "tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/local/bin/tailscale",
  ];
  for (const candidate of candidates) {
    if (candidate.startsWith("/") && !existsSync(candidate)) continue;
    try {
      await exec(candidate, ["version"], { timeout: 3_000 });
      return candidate;
    } catch {
      // Try the next place.
    }
  }
  return undefined;
}

async function json<T>(binary: string, args: string[]): Promise<T> {
  const { stdout } = await exec(binary, args, {
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

/** Whether `proxy` is Serve forwarding to this host's loopback port. */
function forwardsHere(proxy: string | undefined, port: number): boolean {
  if (!proxy) return false;
  const target = proxy.replace(/\/+$/, "");
  return [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    String(port),
  ].includes(target);
}

/**
 * Where Serve forwards to this host, read from `tailscale serve status`;
 * otherwise the port a new forward should take, without touching any other.
 */
export function serveRoute(
  config: ServeConfig,
  dns: string,
  port: number,
  secure: boolean,
): { url: string; secure: boolean; existing: boolean; servePort: number } {
  for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
    const [host, rawPort] = hostPort.split(/:(?=\d+$)/);
    if (host !== dns) continue;
    if (!forwardsHere(web.Handlers?.["/"]?.Proxy, port)) continue;
    const servePort = Number(rawPort);
    const tcp = config.TCP?.[rawPort];
    const https = tcp?.HTTPS === true;
    return {
      url: `${https ? "https" : "http"}://${dns}${(https && servePort === 443) || (!https && servePort === 80) ? "" : `:${servePort}`}`,
      secure: https,
      existing: true,
      servePort,
    };
  }
  // A new forward: 443 for HTTPS when nothing else holds it, else the
  // host's own port number, which is free on the tailnet address.
  const taken = new Set(Object.keys(config.TCP ?? {}).map(Number));
  const servePort = secure && !taken.has(443) ? 443 : port;
  return {
    url: `${secure ? "https" : "http"}://${dns}${secure && servePort === 443 ? "" : `:${servePort}`}`,
    secure,
    existing: false,
    servePort,
  };
}

export async function phoneReach(port: number): Promise<PhoneReach> {
  const binary = await cli();
  if (!binary) return { state: "missing" };
  let status: Status;
  try {
    status = await json<Status>(binary, ["status", "--json"]);
  } catch {
    return { state: "stopped" };
  }
  const dns = status.Self?.DNSName?.replace(/\.$/, "");
  if (status.BackendState !== "Running" || !dns) return { state: "stopped" };
  // HTTPS needs the tailnet's certificates turned on; without them Serve
  // forwards plain HTTP, which only travels inside the encrypted tailnet.
  const secure = (status.CertDomains ?? []).includes(dns);
  const config = await json<ServeConfig>(binary, [
    "serve",
    "status",
    "--json",
  ]).catch((): ServeConfig => ({}));
  const route = serveRoute(config, dns, port, secure);
  if (route.existing)
    return { state: "ready", url: route.url, secure: route.secure };
  return {
    state: "serve",
    url: route.url,
    secure: route.secure,
    command: [
      "tailscale",
      "serve",
      "--bg",
      `--${route.secure ? "https" : "http"}=${route.servePort}`,
      `http://127.0.0.1:${port}`,
    ],
  };
}

/**
 * Turns Serve on for this host as `phoneReach` proposed. Tailscale needs an
 * operator or root to change Serve; without one, a password-free sudo is
 * tried, and otherwise the error says what to run.
 */
export async function enablePhoneServe(port: number): Promise<PhoneReach> {
  const reach = await phoneReach(port);
  if (reach.state !== "serve") return reach;
  const binary = (await cli()) ?? "tailscale";
  const args = reach.command.slice(1);
  try {
    await exec(binary, args, { timeout: 15_000 });
  } catch (error) {
    const denied = /access denied|permission|operator|root/i.test(String(error));
    if (!denied || process.platform === "win32") throw serveError(error, reach);
    try {
      await exec("sudo", ["-n", binary, ...args], { timeout: 15_000 });
    } catch (sudoError) {
      throw serveError(sudoError, reach);
    }
  }
  return phoneReach(port);
}

function serveError(error: unknown, reach: Extract<PhoneReach, { state: "serve" }>) {
  const detail = String((error as { stderr?: string }).stderr || error)
    .trim()
    .split("\n")
    .slice(-2)
    .join(" ");
  return new Error(
    `Tailscale Serve could not be turned on (${detail}). Run \`sudo ${reach.command.join(" ")}\` on this machine.`,
  );
}
