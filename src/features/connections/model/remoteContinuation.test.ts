// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { rememberRemoteProject, remotePath } from "./remoteProjects";
import { readRemoteContinuationSource } from "./remoteContinuation";
import type { HostSession, HostWorktree, RemoteMachine } from "./protocol";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const machine: RemoteMachine = {
  id: "machine",
  environmentId: "env",
  name: "home",
  endpoint: "http://127.0.0.1:1",
};
const project = remotePath("env", "/home/me/repo");

let capabilities: string[];
let online: boolean;
let sessionCwd: string;
let worktrees: HostWorktree[];

const hostSession = (): HostSession => ({
  projectId: "project",
  revision: 3,
  status: "idle",
  updatedAt: 1,
  session: {
    id: "source",
    cwd: sessionCwd,
    harness: "claude",
    model: "claude:test",
    runtimeMode: "supervised",
    title: "Claude · Remote work",
    blocks: [{ id: "u1", role: "user", text: "Fix the host" }],
  },
});

beforeEach(() => {
  localStorage.clear();
  rememberRemoteProject("env", {
    id: "project",
    name: "repo",
    cwd: "/home/me/repo",
  });
  capabilities = ["sessions", "sessions.handoff"];
  online = true;
  sessionCwd = "/home/me/repo";
  worktrees = [];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, input) => {
    if (command === "remote_machines") return [machine];
    if (command !== "remote_request") return undefined;
    const { method } = input as { method: string };
    if (!online) throw "Connection refused";
    if (method === "environment.describe")
      return {
        protocolVersion: 1,
        environmentId: "env",
        name: "home",
        providers: ["claude"],
        capabilities,
      };
    if (method === "sessions.sync")
      return { kind: "snapshot", value: hostSession() };
    if (method === "git.worktrees")
      return { worktrees, defaultRoot: "/home/me/repo-worktrees" };
    throw new Error(`Unexpected ${method}`);
  });
});

it("reads a host chat that ran in the project folder", async () => {
  const source = await readRemoteContinuationSource(project, "source");
  expect(source.worktree).toBeUndefined();
  expect(source.session.blocks).toEqual([
    { id: "u1", role: "user", text: "Fix the host" },
  ]);
});

it("keeps the worktree a host chat ran in", async () => {
  sessionCwd = "/home/me/repo-worktrees/feature";
  worktrees = [
    { path: "/home/me/repo", branch: "main", head: "a", isMain: true, missing: false },
    { path: sessionCwd, branch: "feature", head: "b", isMain: false, missing: false },
  ];
  await expect(
    readRemoteContinuationSource(project, "source"),
  ).resolves.toMatchObject({ worktree: sessionCwd });
});

it("refuses a chat whose worktree is gone", async () => {
  sessionCwd = "/home/me/repo-worktrees/feature";
  worktrees = [
    { path: sessionCwd, branch: "feature", head: "b", isMain: false, missing: true },
  ];
  await expect(readRemoteContinuationSource(project, "source")).rejects.toThrow(
    "This chat’s worktree no longer exists on home.",
  );
});

it("refuses a host that would drop the recap", async () => {
  capabilities = ["sessions"];
  await expect(readRemoteContinuationSource(project, "source")).rejects.toThrow(
    "The host on home is too old to continue chats in a new session.",
  );
  expect(
    vi.mocked(invoke).mock.calls.some(
      ([, input]) => (input as { method?: string })?.method === "sessions.sync",
    ),
  ).toBe(false);
});

it("explains an offline machine", async () => {
  online = false;
  await expect(readRemoteContinuationSource(project, "source")).rejects.toThrow(
    "Couldn’t reach home. Reconnect it to continue this chat.",
  );
});
