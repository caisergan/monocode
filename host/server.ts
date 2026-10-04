import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  HOST_PROTOCOL_VERSION,
  type RemoteProvider,
} from "../src/features/connections/model/protocol";
import type { HostEngine } from "./engine";
import { createHostRpc, type HostRpc } from "./rpc";
import { toHostError } from "./errors";

// A 1 MiB text file can expand to 6 MiB when JSON escapes control characters.
// Existing files.write sends both the original and replacement contents.
const MAX_BODY = 16 * 1024 * 1024;

async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid request");
  return value as Record<string, unknown>;
}

/** The desktop's HTTP front door. Phones use the channel instead; both run
 * the same handlers through `rpc.dispatch`. */
export function createHostServer(
  engine: HostEngine,
  providers: RemoteProvider[],
  lifecycle?: (request: IncomingMessage, response: ServerResponse) => void,
  rpc: HostRpc = createHostRpc(engine, providers),
) {
  return createServer(
    { requestTimeout: 20_000, headersTimeout: 10_000, maxHeaderSize: 8192 },
    async (request, response) => {
      if (request.url === "/lifecycle" && lifecycle) {
        lifecycle(request, response);
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      try {
        // Desktop native HTTP supplies credentials. This endpoint intentionally
        // accepts no browser origin and provides no permissive CORS escape hatch.
        if (
          request.headers.origin ||
          request.method !== "POST" ||
          request.url !== "/rpc"
        ) {
          response
            .writeHead(403)
            .end(
              JSON.stringify({ error: "Unsupported request origin or route" }),
            );
          return;
        }
        const token = request.headers.authorization?.match(
          /^Bearer ([A-Za-z0-9_-]{43})$/,
        )?.[1];
        if (!token || !engine.store.authenticated(token)) {
          response.writeHead(401).end(
            JSON.stringify({
              error: "Device credential is invalid or revoked",
              code: "unauthorized",
            }),
          );
          return;
        }
        const input = await body(request);
        // Reading a request body yields: a device may have been revoked since
        // the headers arrived. Reject it before dispatching any operation.
        const principal = engine.store.deviceByToken(token);
        if (!principal) {
          response.writeHead(401).end(JSON.stringify({
            error: "Device credential is invalid or revoked",
            code: "unauthorized",
          }));
          return;
        }
        if (input.version !== HOST_PROTOCOL_VERSION)
          throw new Error("Incompatible protocol version");
        if (
          input.method !== "environment.describe" &&
          input.environmentId !== engine.store.environmentId
        )
          throw new Error(
            "Host identity changed; reconnect this machine explicitly",
          );
        const params =
          input.params &&
          typeof input.params === "object" &&
          !Array.isArray(input.params)
            ? (input.params as Record<string, unknown>)
            : {};
        engine.store.devices.touch(principal.deviceId, "http");
        const result = await rpc.dispatch(String(input.method), params, {
          principal,
          transport: "http",
        });
        response.end(JSON.stringify({ result }));
      } catch (error) {
        const host = toHostError(error);
        if (!response.destroyed)
          response.writeHead(400).end(
            JSON.stringify({
              error: host.message || "Host request failed",
              code: host.code,
            }),
          );
      }
    },
  );
}
