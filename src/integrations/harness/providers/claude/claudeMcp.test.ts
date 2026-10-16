import { afterEach, beforeEach, expect, it, vi } from "vitest";

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;
let onExit: ((code?: number | null) => void) | undefined;

vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (
    _id: string,
    line: (l: string) => void,
    exit: (code?: number | null) => void,
  ) => {
    onLine = line;
    onExit = exit;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));

const {
  cancelClaudeTurn,
  claudeMcpStatus,
  reconnectClaudeMcp,
  sendClaudeTurn,
  stopClaudeSession,
  __claudeTestReset,
} = await import("./claude");

type Sent = {
  type?: string;
  request_id?: string;
  request?: { subtype?: string; serverName?: string };
};

function parse(): Sent[] {
  return sent.map((line) => JSON.parse(line) as Sent);
}

function emit(rec: Record<string, unknown>) {
  onLine!(JSON.stringify(rec));
}

async function waitFor<T>(
  find: () => T | undefined,
  label: string,
): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const found = find();
    if (found !== undefined) return found;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}; sent=${sent.join("\n")}`);
}

/** The id of the first `subtype` request MonoCode writes after `after`. */
function nextRequest(subtype: string, after?: string) {
  return waitFor(() => {
    const lines = parse();
    const from = after ? lines.findIndex((m) => m.request_id === after) + 1 : 0;
    return lines.slice(from).find((m) => m.request?.subtype === subtype)
      ?.request_id;
  }, subtype);
}

function reply(requestId: string, response: Record<string, unknown>) {
  emit({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  });
}

function refuse(requestId: string, error: string) {
  emit({
    type: "control_response",
    response: { subtype: "error", request_id: requestId, error },
  });
}

async function startSession() {
  const turn = sendClaudeTurn({
    sessionId: "s1",
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "supervised",
    text: "hello",
    attachments: [],
    onEvent: () => undefined,
  });
  await nextRequest("initialize");
  emit({ type: "system", subtype: "init", session_id: "sess_1" });
  await waitFor(() => parse().find((m) => m.type === "user"), "prompt");
  emit({ type: "result", subtype: "success", session_id: "sess_1" });
  await turn;
}

beforeEach(() => {
  sent.length = 0;
  onLine = undefined;
  onExit = undefined;
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("s1");
});

it("answers null without a running Claude", async () => {
  expect(await claudeMcpStatus("s1")).toBeNull();
  expect(await reconnectClaudeMcp("s1", "docs")).toBeNull();
  expect(sent).toEqual([]);
});

it("reads server statuses from mcp_status", async () => {
  await startSession();
  const status = claudeMcpStatus("s1");
  reply(await nextRequest("mcp_status"), {
    mcpServers: [
      { name: "docs", status: "connected", scope: "project" },
      { name: "linear", status: "failed", error: "HTTP 500" },
      { status: "connected" },
    ],
  });
  expect(await status).toEqual([
    { name: "docs", status: "connected", scope: "project" },
    { name: "linear", status: "failed", error: "HTTP 500" },
  ]);
});

it("treats a Claude that refuses mcp_status as unable to say", async () => {
  await startSession();
  const status = claudeMcpStatus("s1");
  refuse(await nextRequest("mcp_status"), "unknown subtype");
  expect(await status).toBeNull();
});

it("reconnects one server and returns the statuses afterwards", async () => {
  await startSession();
  const reconnect = reconnectClaudeMcp("s1", "linear");
  const id = await nextRequest("mcp_reconnect");
  expect(parse().find((m) => m.request_id === id)?.request?.serverName).toBe(
    "linear",
  );
  reply(id, {});
  reply(await nextRequest("mcp_status", id), {
    mcpServers: [{ name: "linear", status: "connected" }],
  });
  expect(await reconnect).toEqual([{ name: "linear", status: "connected" }]);
});

it("explains a failed reconnect with the server's own error", async () => {
  await startSession();
  const reconnect = reconnectClaudeMcp("s1", "linear");
  const failed = expect(reconnect).rejects.toThrow("HTTP 401");
  const id = await nextRequest("mcp_reconnect");
  refuse(id, "Connection failed");
  reply(await nextRequest("mcp_status", id), {
    mcpServers: [{ name: "linear", status: "failed", error: "HTTP 401" }],
  });
  await failed;
});

it("tells a server that needs sign-in apart from a broken one", async () => {
  await startSession();
  const reconnect = reconnectClaudeMcp("s1", "notion");
  const failed = expect(reconnect).rejects.toThrow("Needs authentication");
  const id = await nextRequest("mcp_reconnect");
  refuse(id, "Server status: needs-auth");
  reply(await nextRequest("mcp_status", id), {
    mcpServers: [{ name: "notion", status: "needs-auth" }],
  });
  await failed;
});

it("explains a server the running Claude has not loaded", async () => {
  await startSession();
  const reconnect = reconnectClaudeMcp("s1", "new-one");
  const failed = expect(reconnect).rejects.toThrow("session restarts");
  const id = await nextRequest("mcp_reconnect");
  refuse(id, "Server not found: new-one");
  reply(await nextRequest("mcp_status", id), { mcpServers: [] });
  await failed;
});

it("fails a pending reconnect when Claude exits", async () => {
  await startSession();
  const reconnect = reconnectClaudeMcp("s1", "linear");
  const failed = expect(reconnect).rejects.toThrow("Claude Code exited");
  await nextRequest("mcp_reconnect");
  onExit!(1);
  await failed;
});

it("fails a pending reconnect when the session is stopped", async () => {
  await startSession();
  const reconnect = reconnectClaudeMcp("s1", "linear");
  const failed = expect(reconnect).rejects.toThrow("Claude Code stopped");
  await nextRequest("mcp_reconnect");
  await stopClaudeSession("s1");
  await failed;
});

it("still hears the reply after the turn was stopped", async () => {
  await startSession();
  // Stopping a turn mutes Claude's stream until the next one starts.
  await cancelClaudeTurn("s1");
  const status = claudeMcpStatus("s1");
  reply(await nextRequest("mcp_status"), {
    mcpServers: [{ name: "docs", status: "connected" }],
  });
  expect(await status).toEqual([{ name: "docs", status: "connected" }]);
});

it("gives up on a Claude that never answers", async () => {
  await startSession();
  vi.useFakeTimers();
  try {
    const status = claudeMcpStatus("s1");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await status).toBeNull();
    const reconnect = reconnectClaudeMcp("s1", "linear");
    const failed = expect(reconnect).rejects.toThrow("did not answer");
    await vi.advanceTimersByTimeAsync(90_000);
    await failed;
  } finally {
    vi.useRealTimers();
  }
});
