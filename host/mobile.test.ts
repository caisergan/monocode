import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { SendTurnInput } from "../src/integrations/harness/core/types";
import type { HostProvider } from "./providers";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { createHostServer } from "./server";
import { phoneUrl, tailnetHost } from "./mobile";
import { serveRoute } from "./tailscale";

const reach = vi.hoisted(() => ({
  value: { state: "ready", url: "http://box.tailnet.ts.net:3774", secure: false } as unknown,
}));
vi.mock("./tailscale", async (original) => ({
  ...(await original<typeof import("./tailscale")>()),
  phoneReach: vi.fn(async () => reach.value),
}));

// The host asks Codex's CLI for its models; here it answers at once.
vi.mock("../src/integrations/harness/providers/codex/codexCatalog", () => ({
  discoverCodexModels: vi.fn(async () => [{ id: "codex:test", harness: "codex", name: "Test model" }]),
}));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-phone-test-"));
  const store = new HostStore(join(directory, "host.db"));
  const turns: Array<{ input: SendTurnInput; finish: () => void }> = [];
  const provider: HostProvider = {
    send: vi.fn(
      (input) =>
        new Promise<void>((resolve) => {
          turns.push({ input, finish: resolve });
        }),
    ),
    cancel: vi.fn(async () => turns.at(-1)?.finish()),
    stop: vi.fn(async () => turns.at(-1)?.finish()),
    bind: vi.fn(),
    approve: vi.fn(),
    answer: vi.fn(),
  };
  const engine = new HostEngine(store, { codex: provider });
  const project = await engine.openProject(directory);
  // Expo's push service, as the host would reach it.
  const pushes: unknown[][] = [];
  const pushReplies: unknown[] = [];
  const push = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      pushes.push(JSON.parse(body));
      response.end(JSON.stringify({ data: pushReplies.shift() ?? [{ status: "ok" }] }));
    });
  });
  const pushUrl = await listen(push);
  const server = createHostServer(engine, ["codex"], undefined, {
    port: 3774,
    pushEndpoint: pushUrl,
  });
  const base = await listen(server);
  cleanups.push(async () => {
    await engine.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const desktop = store.issueDevice("Laptop");
  /** The desktop's RPC, over its SSH tunnel. */
  const rpc = async (method: string, params: unknown = {}) => {
    const response = await fetch(`${base}/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${desktop.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, environmentId: store.environmentId, method, params }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    return body.result;
  };
  let next = 0;
  /** The phone, as its native link sends requests. */
  const phone = async (
    method: string,
    params: unknown = {},
    token?: string,
    id = `request-${++next}`,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${base}/mobile`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify({ version: 1, id, method, params }),
    });
    return { status: response.status, body: await response.json() };
  };
  const pair = async () => {
    const invite = await rpc("phones.invite");
    const enrolled = await phone("device.enroll", { code: invite.code, name: "Ege's iPhone" });
    expect(enrolled.body.ok).toBe(true);
    const token: string = enrolled.body.result.token;
    const call = async (method: string, params: unknown = {}, id?: string) => {
      const { body } = await phone(method, params, token, id);
      if (!body.ok) throw new Error(body.error);
      return body.result;
    };
    return { invite, token, call, enrolled: enrolled.body.result };
  };
  return { directory, store, engine, project, provider, turns, rpc, phone, pair, pushes, pushReplies };
}

function decode(link: string) {
  const code = new URL(link).searchParams.get("i")!;
  return JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
}

describe("pairing a phone with a host", () => {
  it("makes a one-use code whose link says where the phone reaches the host", async () => {
    const { rpc, phone, store } = await setup();
    const describe = await rpc("environment.describe");
    expect(describe.capabilities).toContain("phones.direct");
    const invite = await rpc("phones.invite");
    expect(invite.url).toBe("http://box.tailnet.ts.net:3774");
    const payload = decode(invite.link);
    expect(payload).toMatchObject({
      version: 1,
      kind: "host",
      environmentId: store.environmentId,
      url: "http://box.tailnet.ts.net:3774",
      code: invite.code,
    });
    expect(await rpc("phones.inviteStatus", { code: invite.code })).toEqual({
      paired: null,
      expired: false,
    });

    const first = await phone("device.enroll", { code: invite.code, name: "Ege's iPhone" });
    expect(first.body.ok).toBe(true);
    expect(first.body.result).toMatchObject({ environmentId: store.environmentId });
    expect(store.authenticated(first.body.result.token)).toBe(true);
    expect(await rpc("phones.inviteStatus", { code: invite.code })).toEqual({
      paired: "Ege's iPhone",
      expired: false,
    });
    // Each code works once.
    const again = await phone("device.enroll", { code: invite.code, name: "Other" });
    expect(again.body).toMatchObject({ ok: false, error: expect.stringContaining("expired or was used") });
  });

  it("refuses phones without a credential, after leaving, and from browsers", async () => {
    const { phone, pair } = await setup();
    expect((await phone("workspace.list")).status).toBe(401);
    const paired = await pair();
    expect((await phone("workspace.list", {}, paired.token, "x", { Origin: "https://evil.example" })).status).toBe(403);
    await paired.call("device.leave");
    expect((await phone("workspace.list", {}, paired.token)).status).toBe(401);
  });

  it("takes an address given for the link, but only an encrypted or tailnet one", async () => {
    const { rpc } = await setup();
    const invite = await rpc("phones.invite", { url: "https://host.example.com/" });
    expect(decode(invite.link).url).toBe("https://host.example.com");
    await expect(rpc("phones.invite", { url: "http://203.0.113.4:3774" })).rejects.toThrow(/https/);
    reach.value = { state: "serve", url: "https://box.tailnet.ts.net", secure: true, command: ["tailscale"] };
    try {
      // Until Serve is on, the desktop shows how to turn it on, with no link.
      const pending = await rpc("phones.invite");
      expect(pending.link).toBeNull();
      expect(pending.reach.state).toBe("serve");
    } finally {
      reach.value = { state: "ready", url: "http://box.tailnet.ts.net:3774", secure: false };
    }
  });
});

describe("a phone working with the host's sessions", () => {
  it("lists the workspace, starts a session, and streams its turn through a watch", async () => {
    const { pair, turns, project, pushes, store } = await setup();
    const { call } = await pair();
    const empty = await call("workspace.list");
    expect(empty.projects).toEqual([
      expect.objectContaining({ id: project.id, path: project.cwd, defaultHarness: "codex", defaultRuntimeMode: "supervised" }),
    ]);
    expect(empty).toMatchObject({ monos: [], sessions: [], push: true, approvals: true });

    await call("device.push", { token: "ExponentPushToken[abc]", disabled: [] });
    const { sessionId } = await call(
      "session.start",
      { projectId: project.id, text: "Fix the build", harness: "codex", model: "codex:test", runtimeMode: "auto" },
      "start-1",
    );
    // A retried start gets the same session, not another.
    expect(await call("session.start", { projectId: project.id, text: "Fix the build", harness: "codex", model: "codex:test", runtimeMode: "auto" }, "start-1")).toEqual({ sessionId });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0].input.text).toBe("Fix the build");

    const listed = await call("workspace.list");
    expect(listed.sessions).toEqual([
      expect.objectContaining({ id: sessionId, projectId: project.id, harness: "codex", busy: true, runtimeMode: "auto" }),
    ]);

    const { watchId } = await call("conversation.watch", { conversationId: sessionId, tail: 3, incremental: true });
    const first = await call("watch.next", { watchId, after: 0, wait: 1000 });
    expect(first.seq).toBe(1);
    expect(first.updates[0]).toMatchObject({ busy: true, order: [expect.any(String)] });
    expect(JSON.stringify(first.updates[0])).toContain("Fix the build");

    // Nothing new: the poll waits for the reply to stream.
    const waiting = call("watch.next", { watchId, after: 1, wait: 5000 });
    turns[0].input.onEvent({ type: "message.delta", text: "Found the typo." });
    const streamed = await waiting;
    expect(streamed.seq).toBe(2);
    expect(JSON.stringify(streamed.updates)).toContain("Found the typo.");
    // A lost reply is sent again; a phone far behind reopens.
    expect(await call("watch.next", { watchId, after: 1, wait: 0 })).toEqual(streamed);
    await expect(call("watch.next", { watchId, after: 0, wait: 0 })).rejects.toThrow(/reopen/);

    turns[0].finish();
    await vi.waitFor(() => expect(store.session(sessionId).status).toBe("idle"));
    // The phone started it, so the phone hears it finished, with the reply.
    await vi.waitFor(() => expect(pushes).toHaveLength(1));
    expect(pushes[0]).toEqual([
      expect.objectContaining({
        to: "ExponentPushToken[abc]",
        body: "Found the typo.",
        data: { projectId: project.id, sessionId },
        channelId: "sessions",
      }),
    ]);
    const read = await call("conversation.read", { conversationId: sessionId });
    expect(read).toMatchObject({ id: sessionId, busy: false, question: null, approval: null });
    expect(read.messages.map((message: { text: string }) => message.text)).toEqual(["Fix the build", "Found the typo."]);
  });

  it("shows an approval to answer from the phone, and notifies of it", async () => {
    const { pair, turns, project, provider, pushes, store } = await setup();
    const { call } = await pair();
    await call("device.push", { token: "ExponentPushToken[abc]", disabled: ["agentFinished"] });
    const { sessionId } = await call("session.start", { projectId: project.id, text: "Deploy" });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const { watchId } = await call("conversation.watch", { conversationId: sessionId });
    const opened = await call("watch.next", { watchId, after: 0, wait: 1000 });
    expect(opened.updates[0].approval).toBeNull();

    turns[0].input.onEvent({
      type: "tool.started",
      callId: "call-1",
      title: "Run npm run deploy",
      kind: "shell",
    } as never);
    turns[0].input.onEvent({ type: "approval.requested", requestId: 7, title: "Run npm run deploy", callId: "call-1" } as never);
    const asked = await call("watch.next", { watchId, after: 1, wait: 5000 });
    const frame = asked.updates.find((update: { approval?: unknown }) => update.approval);
    expect(frame.approval).toMatchObject({ requestId: 7, title: "Run npm run deploy" });
    const listed = await call("workspace.list");
    expect(listed.sessions[0].waiting).toBe("approval");
    await vi.waitFor(() => expect(pushes).toHaveLength(1));
    expect(pushes[0][0]).toMatchObject({ body: "Needs your approval" });

    await expect(call("session.approve", { conversationId: sessionId, requestId: 8, decision: "allow" })).rejects.toThrow(/already answered/);
    await call("session.approve", { conversationId: sessionId, requestId: 7, decision: "allow" });
    await vi.waitFor(() => expect(provider.approve).toHaveBeenCalled());
    turns[0].finish();
    await vi.waitFor(() => expect(store.session(sessionId).status).toBe("idle"));
    // Finished alerts are off on this phone.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pushes).toHaveLength(1);
  });

  it("answers a question with only the options it asked", async () => {
    const { pair, turns, project, provider } = await setup();
    const { call } = await pair();
    const { sessionId } = await call("session.start", { projectId: project.id, text: "Pick one" });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    turns[0].input.onEvent({
      type: "question.asked",
      requestId: 3,
      questions: [
        {
          id: "q",
          prompt: "Which?",
          multiSelect: false,
          allowCustom: false,
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      ],
    } as never);
    await vi.waitFor(async () =>
      expect((await call("conversation.read", { conversationId: sessionId })).question?.requestId).toBe(3),
    );
    await expect(
      call("session.answerQuestion", { conversationId: sessionId, requestId: 3, reply: { kind: "answered", answers: { q: ["nope"] } } }),
    ).rejects.toThrow(/Choose an answer/);
    await call("session.answerQuestion", {
      conversationId: sessionId,
      requestId: 3,
      reply: { kind: "answered", answers: { q: ["b"] } },
    });
    await vi.waitFor(() => expect(provider.answer).toHaveBeenCalled());
    expect(JSON.stringify(vi.mocked(provider.answer).mock.calls[0])).toContain('"b"');
    turns[0].finish();
  });

  it("stores a message's attachments once, however often it is retried", async () => {
    const { pair, turns, project, store } = await setup();
    const { call } = await pair();
    const { sessionId } = await call("session.start", { projectId: project.id, text: "Hi" });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    turns[0].finish();
    await vi.waitFor(() => expect(store.session(sessionId).status).toBe("idle"));
    const params = {
      conversationId: sessionId,
      text: "Look at this",
      attachments: [{ name: "note.txt", mimeType: "text/plain", data: Buffer.from("hello").toString("base64") }],
    };
    await call("conversation.send", params, "send-1");
    await call("conversation.send", params, "send-1");
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    const block = store.session(sessionId).session.blocks.filter((entry) => entry.role === "user").at(-1)!;
    expect(block.attachments).toHaveLength(1);
    expect(readFileSync(block.attachments![0].path!, "utf8")).toBe("hello");
    expect(existsSync(block.attachments![0].path!)).toBe(true);
    // Mid-turn, a provider that can't steer says so.
    await expect(call("conversation.send", { conversationId: sessionId, text: "More" }, "send-2")).rejects.toThrow(/mid-turn/);
    turns[1].finish();
  });

  it("renames, archives and deletes sessions, and leaves Monos to the desktop", async () => {
    const { pair, turns, project, store } = await setup();
    const { call } = await pair();
    const { sessionId } = await call("session.start", { projectId: project.id, text: "Hi" });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    await expect(call("session.delete", { conversationId: sessionId })).rejects.toThrow(/Stop this session/);
    await call("session.cancel", { conversationId: sessionId });
    await vi.waitFor(() => expect(store.session(sessionId).status).not.toBe("running"));
    await call("session.rename", { conversationId: sessionId, title: "Renamed" });
    expect((await call("workspace.list")).sessions[0].title).toBe("Renamed");
    await call("session.archive", { conversationId: sessionId });
    expect((await call("workspace.list")).sessions).toEqual([]);
    await call("session.delete", { conversationId: sessionId });
    expect(() => store.session(sessionId)).toThrow();
    await expect(call("mono.profile", { monoId: "x" })).rejects.toThrow(/desktop/);
  });
});

describe("addresses a phone may be sent to", () => {
  it("accepts HTTPS anywhere and HTTP only inside a tailnet", () => {
    expect(phoneUrl("https://host.example.com/path")).toBe("https://host.example.com");
    expect(phoneUrl("http://box.tailnet.ts.net:3774")).toBe("http://box.tailnet.ts.net:3774");
    expect(phoneUrl("http://100.110.106.27:3774")).toBe("http://100.110.106.27:3774");
    expect(() => phoneUrl("http://192.168.1.4:3774")).toThrow();
    expect(() => phoneUrl("https://user:pass@host.example.com")).toThrow();
    expect(tailnetHost("100.63.0.1")).toBe(false);
    expect(tailnetHost("100.127.255.1")).toBe(true);
  });

  it("finds Serve's forward to this host and proposes one that leaves others alone", () => {
    const dns = "box.tailnet.ts.net";
    expect(
      serveRoute(
        {
          TCP: { "443": { HTTPS: true } },
          Web: { [`${dns}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3774" } } } },
        },
        dns,
        3774,
        true,
      ),
    ).toMatchObject({ url: `https://${dns}`, existing: true });
    // Another service holds 443 and Postgres is forwarded: a new HTTPS
    // forward takes the host's port instead.
    expect(
      serveRoute(
        {
          TCP: { "443": { HTTPS: true }, "5432": { TCPForward: "127.0.0.1:5432" } },
          Web: { [`${dns}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } } } },
        },
        dns,
        3774,
        true,
      ),
    ).toMatchObject({ url: `https://${dns}:3774`, existing: false, servePort: 3774 });
    // Without the tailnet's certificates, plain HTTP inside the tailnet.
    expect(serveRoute({}, dns, 3774, false)).toMatchObject({ url: `http://${dns}:3774`, secure: false });
  });
});
