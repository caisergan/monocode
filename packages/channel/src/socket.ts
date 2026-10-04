// One binary WebSocket message is one frame. Both transports (direct and
// relay) and the in-memory demo transport implement this.

export interface FrameSocket {
  send(frame: Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount: number;
  onFrame: ((frame: Uint8Array) => void) | null;
  onClose: ((code: number, reason: string) => void) | null;
}

/** The subset of the WHATWG WebSocket (React Native, browsers, `ws`) used here. */
export type WebSocketLike = {
  binaryType: string;
  readonly bufferedAmount: number;
  readonly readyState: number;
  send(data: ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onopen: ((event: unknown) => void) | null;
};

const OPEN = 1;

/** Wraps an already-open WebSocket. Text messages close it with 1003. */
export function webSocketFrames(ws: WebSocketLike): FrameSocket {
  ws.binaryType = "arraybuffer";
  const socket: FrameSocket = {
    onFrame: null,
    onClose: null,
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    send(frame) {
      if (ws.readyState !== OPEN) return;
      ws.send(
        frame.byteOffset === 0 && frame.byteLength === frame.buffer.byteLength
          ? (frame.buffer as ArrayBuffer)
          : (frame.slice().buffer as ArrayBuffer),
      );
    },
    close(code, reason) {
      try {
        ws.close(code ?? 1000, reason);
      } catch {
        /* already closed */
      }
    },
  };
  ws.onmessage = (event) => {
    const data = event.data;
    if (data instanceof ArrayBuffer) socket.onFrame?.(new Uint8Array(data));
    else if (ArrayBuffer.isView(data))
      socket.onFrame?.(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    else socket.close(1003, "Binary frames only");
  };
  let closed = false;
  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    socket.onClose?.(code, reason);
  };
  ws.onclose = (event) => finish(event.code, event.reason);
  ws.onerror = () => finish(1006, "Socket error");
  return socket;
}

/** Opens a WebSocket and resolves once it is open. */
export function openWebSocket(
  create: () => WebSocketLike,
  options: { timeoutMs: number; signal?: AbortSignalLike },
): Promise<FrameSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = create();
    ws.binaryType = "arraybuffer";
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("Connection timed out")), options.timeoutMs);
    options.signal?.addEventListener?.("abort", () => fail(new Error("Aborted")));
    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(webSocketFrames(ws));
    };
    ws.onerror = () => fail(new Error("Connection failed"));
    ws.onclose = (event) => fail(new Error(`Connection closed (${event.code})`));
  });
}

export type AbortSignalLike = {
  readonly aborted: boolean;
  addEventListener?(type: "abort", listener: () => void): void;
};

/** Two connected sockets in one process: the demo host and tests. */
export function memorySocketPair(): [FrameSocket, FrameSocket] {
  const a = new MemorySocket();
  const b = new MemorySocket();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

class MemorySocket implements FrameSocket {
  onFrame: ((frame: Uint8Array) => void) | null = null;
  onClose: ((code: number, reason: string) => void) | null = null;
  readonly bufferedAmount = 0;
  peer?: MemorySocket;
  closed = false;

  send(frame: Uint8Array): void {
    if (this.closed) return;
    const peer = this.peer!;
    const copy = frame.slice();
    setTimeout(() => {
      if (!peer.closed) peer.onFrame?.(copy);
    }, 0);
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    const peer = this.peer!;
    setTimeout(() => {
      this.onClose?.(code, reason);
      if (!peer.closed) {
        peer.closed = true;
        peer.onClose?.(code, reason);
      }
    }, 0);
  }
}
