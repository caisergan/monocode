import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  encodeProjectDir,
  listClaudeSessions,
  readClaudeSession,
  type HostAgentSessionQuery,
} from "./agent-sessions";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { createHostServer } from "./server";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `monocode-${name}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function user(cwd: string, content: unknown, uuid = "u1", parentUuid: string | null = null) {
  return {
    type: "user",
    uuid,
    parentUuid,
    cwd,
    gitBranch: "main",
    isSidechain: false,
    timestamp: "2026-10-01T10:00:00.000Z",
    message: { role: "user", content },
    toolUseResult: { huge: "payload" },
  };
}

function assistant(text: string, uuid: string, parentUuid: string) {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    isSidechain: false,
    timestamp: "2026-10-01T10:00:05.000Z",
    message: {
      id: `msg-${uuid}`,
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text }],
    },
  };
}

function writeSession(root: string, cwd: string, id: string, records: unknown[]) {
  const dir = join(root, encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.jsonl`),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
}

function query(
  scope: string[],
  overrides: Partial<HostAgentSessionQuery> = {},
): HostAgentSessionQuery {
  return { scope, known: new Map(), projectId: "p1", ...overrides };
}

describe("Claude Code sessions on the host", () => {
  it("lists sessions that ran in the project or its worktrees", async () => {
    const root = temp("claude-root");
    const project = temp("project");
    const worktree = temp("worktree");
    writeSession(root, project, "one", [
      user(project, "fix the build"),
      user(project, [{ type: "tool_result", tool_use_id: "t", content: "ok" }]),
      user(project, "<local-command-stdout>done</local-command-stdout>"),
      user(project, [{ type: "text", text: "and   add\ntests" }]),
      { type: "ai-title", aiTitle: "Fix build" },
    ]);
    writeSession(root, worktree, "two", [user(worktree, "<command-name>/review</command-name><command-args>42</command-args>")]);
    // Same encoded directory, another folder's records.
    writeSession(root, project, "other", [user(`${project}/x`, "elsewhere")]);
    // Nothing to continue.
    writeSession(root, project, "empty", [user(project, "[Request interrupted by user]")]);

    const listing = await listClaudeSessions(root, query([project, worktree]));
    expect(listing.hasMore).toBe(false);
    const byId = new Map(listing.sessions.map((s) => [s.id, s]));
    expect([...byId.keys()].sort()).toEqual(["one", "two"]);
    expect(byId.get("one")).toMatchObject({
      harness: "claude",
      cwd: project,
      title: "Fix build",
      firstPrompt: "fix the build",
      lastPrompt: "and add tests",
      gitBranch: "main",
      folder: "ok",
      project: null,
      monocodeSessionId: null,
    });
    expect(byId.get("two")).toMatchObject({
      lastPrompt: "/review 42",
      project,
    });
  });

  it("counts conversations host sessions hold instead of listing them", async () => {
    const root = temp("claude-root");
    const project = temp("project");
    writeSession(root, project, "held", [user(project, "one")]);
    writeSession(root, project, "elsewhere", [user(project, "two")]);
    writeSession(root, project, "free", [user(project, "three")]);
    const known = new Map([
      ["held", { sessionId: "host-1", projectId: "p1" }],
      ["elsewhere", { sessionId: "host-2", projectId: "p2" }],
    ]);
    const hidden = await listClaudeSessions(root, query([project], { known }));
    expect(hidden.sessions.map((s) => s.id)).toEqual(["free"]);
    expect(hidden.importedCount).toBe(1);
    const shown = await listClaudeSessions(
      root,
      query([project], { known, includeImported: true }),
    );
    expect(
      shown.sessions.map((s) => [s.id, s.monocodeSessionId]).sort(),
    ).toEqual([
      ["free", null],
      ["held", "host-1"],
    ]);
  });

  it("searches prompts and pages by limit", async () => {
    const root = temp("claude-root");
    const project = temp("project");
    for (const [index, prompt] of ["alpha", "beta", "alphabet"].entries())
      writeSession(root, project, `s${index}`, [user(project, prompt)]);
    const found = await listClaudeSessions(root, query([project], { query: "ALPHA" }));
    expect(found.sessions.map((s) => s.firstPrompt).sort()).toEqual(["alpha", "alphabet"]);
    const page = await listClaudeSessions(root, query([project], { limit: 2 }));
    expect(page.sessions).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });

  it("finds the last prompt past a long run of tool output", async () => {
    const root = temp("claude-root");
    const project = temp("project");
    const output = "x".repeat(2_000);
    writeSession(root, project, "long", [
      user(project, "first"),
      user(project, "middle"),
      ...Array.from({ length: 400 }, (_, index) =>
        assistant(output, `a${index}`, "u1"),
      ),
      user(project, "last"),
      ...Array.from({ length: 200 }, (_, index) =>
        assistant(output, `b${index}`, "u1"),
      ),
    ]);
    const [session] = (await listClaudeSessions(root, query([project]))).sessions;
    expect(session).toMatchObject({ firstPrompt: "first", lastPrompt: "last" });
  });

  it("reads a transcript without heavy payloads", async () => {
    const root = temp("claude-root");
    const project = temp("project");
    writeSession(root, project, "one", [
      user(project, [
        { type: "text", text: "look" },
        { type: "image", source: { type: "base64", data: "AAAA" } },
      ]),
      { type: "attachment", uuid: "att", parentUuid: "u1", attachment: { big: true } },
      { type: "progress", data: {} },
      {
        type: "user",
        uuid: "u2",
        parentUuid: "att",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t",
              content: [{ type: "text", text: "y".repeat(20_000) }],
            },
          ],
        },
      },
    ]);
    const records = await readClaudeSession(root, project, "one");
    expect(records).toHaveLength(3);
    expect(records[0]).not.toHaveProperty("toolUseResult");
    const [, image] = (records[0].message as { content: Record<string, unknown>[] }).content;
    expect(image).toEqual({ type: "image" });
    expect(records[1]).toEqual({ type: "attachment", uuid: "att", parentUuid: "u1" });
    const [result] = (records[2].message as { content: { content: string }[] }).content;
    expect(result.content).toHaveLength(16 * 1024 + 1);
    await expect(readClaudeSession(root, project, "missing")).rejects.toThrow(
      "no longer exists",
    );
    await expect(readClaudeSession(root, project, "../x")).rejects.toThrow(
      "Invalid session id",
    );
  });
});

describe("importing over the host API", () => {
  async function setup() {
    const directory = temp("host");
    const config = temp("claude-config");
    vi.stubEnv("CLAUDE_CONFIG_DIR", config);
    const store = new HostStore(join(directory, "host.db"));
    const bind = vi.fn();
    const engine = new HostEngine(store, {
      claude: {
        send: async () => {},
        stop: async () => {},
        cancel: async () => {},
        bind,
        approve: () => {},
        answer: () => {},
      },
    });
    const projectDir = join(directory, "app");
    mkdirSync(projectDir);
    const project = await engine.openProject(projectDir);
    const server = createHostServer(engine, ["claude"]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`;
    const { token } = store.issueDevice("Laptop");
    cleanups.unshift(async () => {
      await engine.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    });
    const call = async (method: string, params: unknown = {}) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          version: 1,
          environmentId: store.environmentId,
          method,
          params,
        }),
      });
      return (await response.json()) as { result?: any; error?: string };
    };
    return { root: join(config, "projects"), store, project, bind, call };
  }

  it("imports a terminal session as a host session that resumes it", async () => {
    const s = await setup();
    writeSession(s.root, s.project.cwd, "conv-1", [
      user(s.project.cwd, "fix the build"),
      assistant("Done.", "a1", "u1"),
    ]);

    const described = await s.call("environment.describe");
    expect(described.result.capabilities).toContain("agentSessions.import");

    const listed = await s.call("agentSessions.list", { projectId: s.project.id });
    expect(listed.result.sessions.map((row: { id: string }) => row.id)).toEqual(["conv-1"]);

    const imported = await s.call("agentSessions.import", {
      projectId: s.project.id,
      harness: "claude",
      cwd: s.project.cwd,
      sessionId: "conv-1",
    });
    expect(imported.result.existing).toBe(false);
    const sessionId = imported.result.sessionId as string;
    expect(s.bind).toHaveBeenCalledWith(sessionId, "conv-1", s.project.cwd);
    const saved = s.store.session(sessionId);
    expect(saved).toMatchObject({ projectId: s.project.id, status: "idle" });
    expect(saved.session).toMatchObject({
      harness: "claude",
      cwd: s.project.cwd,
      providerSessionId: "conv-1",
    });
    expect(saved.session.blocks.map((block) => [block.role, block.text])).toEqual([
      ["user", "fix the build"],
      ["assistant", "Done."],
    ]);

    // It now counts as already on the host, and importing again opens it.
    const after = await s.call("agentSessions.list", { projectId: s.project.id });
    expect(after.result).toMatchObject({ sessions: [], importedCount: 1 });
    const again = await s.call("agentSessions.import", {
      projectId: s.project.id,
      harness: "claude",
      cwd: s.project.cwd,
      sessionId: "conv-1",
    });
    expect(again.result).toEqual({ sessionId, existing: true });
    expect(s.store.summaries(s.project.id)).toHaveLength(1);
  });

  it("rejects folders outside the project and other agents", async () => {
    const s = await setup();
    const outside = temp("outside");
    writeSession(s.root, outside, "conv-2", [user(outside, "hi")]);
    const params = {
      projectId: s.project.id,
      harness: "claude",
      cwd: outside,
      sessionId: "conv-2",
    };
    expect((await s.call("agentSessions.import", params)).error).toMatch(/worktree/);
    expect(
      (await s.call("agentSessions.import", { ...params, harness: "codex" })).error,
    ).toMatch(/Only Claude Code/);
  });
});
