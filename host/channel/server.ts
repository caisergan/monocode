// The direct listener phones connect to over LAN or Tailscale (spec 05 §5.3).

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Endpoint } from "@monocode/channel/envelope";
import { webSocketFrames, type WebSocketLike } from "@monocode/channel/socket";
import type { RemoteProvider } from "../../src/features/connections/model/protocol";
import type { HostConfig } from "../config";
import type { HostKeys } from "../keys";
import type { PairingManager } from "../pairing";
import type { HostRpc } from "../rpc";
import type { HostStore } from "../store";
import { ChannelConnection, type ChannelHost } from "./connection";
import { discoverEndpoints } from "./endpoints";

const MAX_PAYLOAD = 70 * 1024;
const PER_IP_PENDING = 8;
const PER_IP_PER_MINUTE = 20;
const TOTAL_PENDING = 64;
const MAX_CHANNELS = 64;
const CHANNELS_PER_DEVICE = 4;
const SCAN_MS = 15_000;

export class ChannelServer {
  private servers = new Map<string, Server>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  private channels = new Set<ChannelConnection>();
  private pending = new Map<string, number>();
  private attempts = new Map<string, number[]>();
  private endpoints: Endpoint[] = [];
  private scanTimer?: ReturnType<typeof setInterval>;
  private stopStore: () => void;
  private host: ChannelHost;
  private stopping = false;

  constructor(
    private readonly options: {
      store: HostStore;
      rpc: HostRpc;
      keys: HostKeys;
      pairing: PairingManager;
      providers: RemoteProvider[];
      config: () => HostConfig;
      log?: (message: string) => void;
    },
  ) {
    this.host = {
      store: options.store,
      rpc: options.rpc,
      keys: options.keys,
      pairing: options.pairing,
      providers: options.providers,
      endpoints: () => this.endpoints,
      register: (connection) => this.register(connection),
      unregister: (connection) => this.channels.delete(connection),
    };
    this.stopStore = options.store.onChange((change) => {
      for (const channel of this.channels) channel.sessionChanged(change);
    });
  }

  get listening(): string[] {
    return [...this.servers.keys()];
  }

  get currentEndpoints(): Endpoint[] {
    return this.endpoints;
  }

  async start(): Promise<void> {
    await this.rescan();
    this.scanTimer = setInterval(() => void this.rescan().catch(() => undefined), SCAN_MS);
    this.scanTimer.unref?.();
  }

  /** Re-reads interfaces; binds new private addresses and drops gone ones. */
  async rescan(): Promise<void> {
    if (this.stopping) return;
    const config = this.options.config();
    const { mode, port, advertise } = config.direct;
    const { endpoints, bind } = await discoverEndpoints(port, advertise);
    const before = JSON.stringify(this.endpoints);
    this.endpoints = mode === "off" ? [] : endpoints;
    if (before !== JSON.stringify(this.endpoints))
      for (const channel of this.channels)
        channel.send({ t: "evt", e: "host.endpoints", d: { endpoints: this.endpoints } }, 1);
    const wanted = mode === "off" ? [] : mode === "all" ? ["::"] : bind;
    for (const [address, server] of this.servers)
      if (!wanted.includes(address)) {
        server.close();
        this.servers.delete(address);
      }
    for (const address of wanted)
      if (!this.servers.has(address)) await this.listen(address, port).catch((error) => {
        this.options.log?.(`Could not listen on ${address}:${port}: ${error instanceof Error ? error.message : error}`);
      });
  }

  /** `config.changed`: rebinds every listener with the new settings, then
   * sends each device channel `evt host.config` with the resulting view. */
  async reconfigure(view: () => unknown): Promise<void> {
    if (this.stopping) return;
    // Open channels keep their sockets; only the listening sockets close.
    for (const server of this.servers.values()) server.close();
    this.servers.clear();
    await this.rescan();
    const data = view();
    for (const channel of this.channels)
      if (channel.state === "device") channel.send({ t: "evt", e: "host.config", d: data }, 1);
  }

  private listen(address: string, port: number): Promise<void> {
    const server = createServer((request, response) => {
      response.writeHead(request.headers.origin ? 403 : 404).end();
    });
    server.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: address, port, ipv6Only: address.includes(":") && address !== "::" }, () => {
        server.off("error", reject);
        server.on("error", (error) => this.options.log?.(`Listener ${address} failed: ${error.message}`));
        this.servers.set(address, server);
        this.options.log?.(`Phones can connect on ${address.includes(":") ? `[${address}]` : address}:${port}`);
        resolve();
      });
    });
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const ip = request.socket.remoteAddress ?? "unknown";
    const refuse = (status: number) => {
      socket.end(`HTTP/1.1 ${status} ${status === 429 ? "Too Many Requests" : "Forbidden"}\r\n\r\n`);
    };
    if (this.stopping) return refuse(503);
    if (request.headers.origin) return refuse(403);
    if (new URL(request.url ?? "/", "http://host").pathname !== "/v1/channel") return refuse(404);
    const now = Date.now();
    const recent = (this.attempts.get(ip) ?? []).filter((at) => now - at < 60_000);
    const pendingForIp = this.pending.get(ip) ?? 0;
    const pendingTotal = [...this.pending.values()].reduce((sum, count) => sum + count, 0);
    if (
      recent.length >= PER_IP_PER_MINUTE ||
      pendingForIp >= PER_IP_PENDING ||
      pendingTotal >= TOTAL_PENDING ||
      this.channels.size >= MAX_CHANNELS
    )
      return refuse(429);
    recent.push(now);
    this.attempts.set(ip, recent);
    this.wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      this.pending.set(ip, (this.pending.get(ip) ?? 0) + 1);
      let counted = true;
      const release = () => {
        if (!counted) return;
        counted = false;
        const left = (this.pending.get(ip) ?? 1) - 1;
        if (left > 0) this.pending.set(ip, left);
        else this.pending.delete(ip);
      };
      const frames = webSocketFrames(ws as unknown as WebSocketLike);
      const connection = new ChannelConnection(frames, this.host, "direct", ip, release);
      this.channels.add(connection);
      ws.once("close", release);
      void connection;
    });
  }

  private register(connection: ChannelConnection): void {
    this.channels.add(connection);
    const mine = [...this.channels].filter(
      (other) => other !== connection && other.deviceId === connection.deviceId && other.state === "device",
    );
    for (const old of mine.slice(0, Math.max(0, mine.length - (CHANNELS_PER_DEVICE - 1)))) old.bye("replaced");
  }

  /** Closes every channel of a revoked device at once. */
  deviceRevoked(deviceId: string): void {
    for (const channel of this.channels) if (channel.deviceId === deviceId) channel.bye("device_revoked");
  }

  /** Re-checks every channel's device after the CLI changed the devices table. */
  devicesChanged(): void {
    for (const channel of this.channels)
      if (channel.deviceId && !this.options.store.devices.get(channel.deviceId)) channel.bye("device_revoked");
  }

  projectsChanged(): void {
    for (const channel of this.channels) channel.projectsChanged();
  }

  async close(): Promise<void> {
    this.stopping = true;
    clearInterval(this.scanTimer);
    this.stopStore();
    for (const channel of this.channels) channel.bye("host_stopping");
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const channel of this.channels) channel.close(1001, "host_stopping");
    for (const server of this.servers.values()) {
      server.closeAllConnections();
      server.close();
    }
    this.servers.clear();
    this.wss.close();
  }
}
