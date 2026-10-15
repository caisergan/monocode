import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import { join } from "node:path";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import type { ChildBackend } from "../src/integrations/harness/core/child";
import {
  isRemoteProvider,
  type RemoteProvider,
} from "../src/features/connections/model/protocol";
import { providerLaunch, resolveProvider } from "./process";

const exec = promisify(execFile);
const ALLOWED_EXEC_ARGS = new Set([
  "--version",
  "--list-models",
  "models --verbose",
  "models --json",
  "models",
  "status --json",
  "agent list",
]);

function loopbackUrl(value: unknown): string {
  const url = new URL(String(value));
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("OpenCode HTTP is limited to localhost");
  return url.href;
}

/** Native process implementation for the headless execution proof. */
export class HostChildBackend implements ChildBackend {
  private events = new EventEmitter();
  private children = new Map<string, ChildProcessWithoutNullStreams>();
  private streams = new Map<string, AbortController>();
  private closing = false;

  constructor(
    private readonly binaries: Partial<Record<RemoteProvider, string>> = {},
  ) {
    this.events.setMaxListeners(0);
  }

  async resolve(provider: RemoteProvider): Promise<string> {
    if (this.binaries[provider]) return this.binaries[provider]!;
    return resolveProvider(provider);
  }

  async listen<T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<() => void> {
    this.events.on(event, handler);
    return () => {
      this.events.off(event, handler);
    };
  }

  private emit(event: string, payload: unknown): void {
    this.events.emit(event, { payload });
  }

  async invoke<T>(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const id = String(args.sessionId ?? "");
    if (command.startsWith("harness_resolve_")) {
      const provider = command.slice("harness_resolve_".length);
      if (!isRemoteProvider(provider))
        throw new Error(`Unsupported provider: ${provider}`);
      return {
        path: await this.resolve(provider),
        ...(provider === "antigravity"
          ? { args: process.platform === "linux" ? ["--uid="] : [] }
          : {}),
      } as T;
    }
    switch (command) {
      case "harness_exec": {
        const provider = args.binaryProvider;
        if (!isRemoteProvider(provider))
          throw new Error("Unsupported headless catalog command");
        const commandPath = await this.resolve(provider);
        if (
          args.command !== commandPath ||
          !Array.isArray(args.args) ||
          !args.args.every((arg) => typeof arg === "string") ||
          !ALLOWED_EXEC_ARGS.has(args.args.join(" "))
        )
          throw new Error("Unsupported headless catalog command");
        const launch = await providerLaunch(commandPath, args.args as string[]);
        const { stdout } = await exec(launch.command, launch.args, {
          cwd: typeof args.cwd === "string" ? args.cwd : undefined,
          timeout: 10_000,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
        });
        return stdout as T;
      }
      case "harness_free_port": {
        const server = createServer();
        try {
          return await new Promise<T>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              if (!address || typeof address === "string")
                reject(new Error("Could not reserve a local port"));
              else resolve(address.port as T);
            });
          });
        } finally {
          server.close();
        }
      }
      case "harness_http": {
        const url = loopbackUrl(args.url);
        const response = await fetch(url, {
          method: String(args.method),
          headers: args.headers as Record<string, string> | undefined,
          body: args.body as string | undefined,
          redirect: "error",
          signal: AbortSignal.timeout(
            typeof args.timeoutMs === "number"
              ? Math.max(1, args.timeoutMs)
              : 30_000,
          ),
        });
        return { status: response.status, body: await response.text() } as T;
      }
      case "harness_sse_open": {
        const url = loopbackUrl(args.url);
        this.stopStream(id);
        const controller = new AbortController();
        this.streams.set(id, controller);
        void this.readStream(
          id,
          url,
          args.headers as Record<string, string> | undefined,
          controller,
        );
        return undefined as T;
      }
      case "harness_sse_close":
        this.stopStream(id);
        return undefined as T;
      case "harness_read_text_file": {
        const path = String(args.path ?? "");
        const info = await stat(path);
        if (!info.isFile() || info.size > 8 * 1024 * 1024)
          throw new Error("File is not a readable text file of at most 8 MiB");
        const bytes = await readFile(path);
        if (bytes.includes(0))
          throw new Error("Binary file is not readable as text");
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes) as T;
      }
      case "harness_read_text_range":
        return (await readTextRange(
          String(args.path ?? ""),
          Number(args.offset ?? 0),
          typeof args.maxBytes === "number" ? args.maxBytes : undefined,
        )) as T;
      case "harness_spawn":
        return (await this.start(id, args)) as T;
      case "harness_write": {
        const child = this.children.get(id);
        if (!child || child.stdin.destroyed)
          throw new Error("Provider process is not running");
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Provider stdin write timed out")),
            15_000,
          );
          child.stdin.write(`${String(args.line)}\n`, (error) => {
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
          });
        });
        return undefined as T;
      }
      case "harness_kill":
        await this.kill(id);
        return undefined as T;
      case "harness_kill_all":
        await this.close();
        return undefined as T;
      default:
        throw new Error(`Unsupported headless process operation: ${command}`);
    }
  }

  private stopStream(id: string): void {
    this.streams.get(id)?.abort();
    this.streams.delete(id);
  }

  private async readStream(
    id: string,
    url: string,
    headers: Record<string, string> | undefined,
    controller: AbortController,
  ): Promise<void> {
    let error: string | undefined;
    try {
      const response = await fetch(url, {
        headers: { Accept: "text/event-stream", ...headers },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok || !response.body)
        throw new Error(
          `OpenCode event stream returned HTTP ${response.status}`,
        );
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let data: string[] = [];
      let dataLength = 0;
      while (!controller.signal.aborted) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        if (buffer.length > 8 * 1024 * 1024)
          throw new Error("OpenCode event stream frame is too large");
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, "");
          buffer = buffer.slice(index + 1);
          if (!line) {
            if (data.length)
              this.emit("harness-sse", {
                sessionId: id,
                data: data.join("\n"),
              });
            data = [];
            dataLength = 0;
          } else if (line.startsWith("data:")) {
            const piece = line.slice(5).replace(/^ /, "");
            dataLength += piece.length;
            if (dataLength > 8 * 1024 * 1024)
              throw new Error("OpenCode event stream frame is too large");
            data.push(piece);
          }
        }
      }
    } catch (reason) {
      if (!controller.signal.aborted)
        error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      if (this.streams.get(id) === controller) this.streams.delete(id);
      this.emit("harness-sse-end", { sessionId: id, error });
    }
  }

  private async start(
    id: string,
    args: Record<string, unknown>,
  ): Promise<number> {
    if (this.closing) throw new Error("Host is stopping");
    await this.kill(id);
    if (this.closing) throw new Error("Host is stopping");
    const account = args.account as { id?: string } | undefined;
    if (account?.id && account.id !== "default")
      throw new Error(
        "Named provider accounts are not supported by this host yet",
      );
    const launch = await providerLaunch(
      String(args.command),
      args.args as string[],
    );
    if (this.closing) throw new Error("Host is stopping");
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./provider-guard.mjs", import.meta.url)),
        launch.command,
        ...launch.args,
      ],
      {
        cwd: String(args.cwd),
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
        env: { ...process.env, MONOCODE_HOST: "1" },
      },
    );
    this.children.set(id, child);
    child.stdin.on("error", () => {
      /* write callbacks report failures */
    });
    this.lines(child, id, "stdout");
    this.lines(child, id, "stderr");
    child.on("close", (code) => {
      if (this.children.get(id) === child) this.children.delete(id);
      this.emit("harness-exit", { sessionId: id, code, pid: child.pid });
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return child.pid!;
  }

  private lines(
    child: ChildProcessWithoutNullStreams,
    id: string,
    stream: "stdout" | "stderr",
  ): void {
    let buffer = "";
    child[stream].setEncoding("utf8");
    child[stream].on("data", (data: string) => {
      buffer += data;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line.length > 8 * 1024 * 1024) {
          void this.kill(id);
          return;
        }
        this.emit(`harness-${stream}`, { sessionId: id, line });
      }
      if (buffer.length > 8 * 1024 * 1024) {
        buffer = "";
        void this.kill(id);
      }
    });
    child[stream].on("end", () => {
      if (buffer)
        this.emit(`harness-${stream}`, { sessionId: id, line: buffer });
    });
  }

  private signal(
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals,
  ): void {
    try {
      if (process.platform === "win32") child.kill(signal);
      else if (child.pid) process.kill(-child.pid, signal);
    } catch {
      /* already exited */
    }
  }

  async kill(id: string): Promise<void> {
    const child = this.children.get(id);
    if (!child) return;
    this.children.delete(id);
    if (process.platform === "win32") {
      // Kill descendants while the leader still exists. Closing stdin first
      // can let the leader exit, making its remaining children untraceable.
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          await exec(
            join(
              process.env.SystemRoot ?? "C:\\Windows",
              "System32",
              "taskkill.exe",
            ),
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, timeout: 10_000 },
          );
        } catch {
          child.kill();
        }
      }
      child.stdin.destroy();
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      return;
    }
    child.stdin.destroy();
    this.signal(child, "SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.signal(child, "SIGKILL");
        resolve();
        // The guard needs a full second to escalate against the provider's
        // separate process group before we may kill the guard itself.
      }, 3_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const id of this.streams.keys()) this.stopStream(id);
    await Promise.all([...this.children.keys()].map((id) => this.kill(id)));
  }
}

const MAX_TEXT_RANGE_BYTES = 4 * 1024 * 1024;

/**
 * Whole lines of a growing provider transcript from `offset` on, the same
 * contract as the desktop's `read_text_file_range`: an unfinished last line
 * waits for the next read, and one longer than a read is stepped over.
 */
export async function readTextRange(
  path: string,
  offset: number,
  maxBytes = MAX_TEXT_RANGE_BYTES,
): Promise<{ text: string; nextOffset: number; size: number; path: string }> {
  const resolved = await realpath(path);
  const handle = await open(resolved, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Not a file");
    const size = info.size;
    const start = Math.min(Math.max(0, Math.floor(offset) || 0), size);
    const limit = Math.min(
      Math.max(1, Math.floor(maxBytes)),
      MAX_TEXT_RANGE_BYTES,
    );
    const buffer = Buffer.alloc(Math.min(limit, size - start));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const bytes = buffer.subarray(0, bytesRead);
    const end = bytes.lastIndexOf(0x0a);
    if (end < 0) {
      if (bytesRead < limit) {
        return { text: "", nextOffset: start, size, path: resolved };
      }
      // One line too long to hand over: step past it.
      let position = start + limit;
      const chunk = Buffer.alloc(64 * 1024);
      while (position < size) {
        const { bytesRead: read } = await handle.read(
          chunk,
          0,
          chunk.length,
          position,
        );
        if (read === 0) break;
        const at = chunk.subarray(0, read).indexOf(0x0a);
        if (at >= 0) {
          return {
            text: "",
            nextOffset: position + at + 1,
            size,
            path: resolved,
          };
        }
        position += read;
      }
      return { text: "", nextOffset: start + limit, size, path: resolved };
    }
    return {
      text: bytes.subarray(0, end + 1).toString("utf8"),
      nextOffset: start + end + 1,
      size,
      path: resolved,
    };
  } finally {
    await handle.close();
  }
}
