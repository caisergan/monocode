import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (name: string, callback: (event: { payload: unknown }) => void) => {
      mocks.listeners.set(name, callback);
      return () => mocks.listeners.delete(name);
    },
  ),
}));

import {
  decodePtyChunk,
  holdPty,
  killPty,
  ptyExitCode,
  spawnPty,
  subscribePty,
  trimReplay,
} from "./pty";

const KB = 1024;

describe("decodePtyChunk", () => {
  it("decodes a valid base64 payload", () => {
    // "hi" in base64
    const chunk = decodePtyChunk("aGk=");
    expect(chunk).not.toBeNull();
    expect(Array.from(chunk!)).toEqual([104, 105]);
  });

  it("returns null instead of throwing on a malformed payload", () => {
    expect(() => decodePtyChunk("not valid base64!!!")).not.toThrow();
    expect(decodePtyChunk("not valid base64!!!")).toBeNull();
  });
});

describe("trimReplay", () => {
  it("keeps a small buffer whole", () => {
    const sizes = [KB, KB, KB];
    expect(trimReplay(sizes, 3 * KB)).toEqual({ drop: 0, bytes: 3 * KB });
  });

  it("drops oldest chunks once the byte budget is exceeded", () => {
    // Ten 32KB chunks is 320KB, over the 256KB budget.
    const sizes = Array(10).fill(32 * KB);
    const { drop, bytes } = trimReplay(sizes, 320 * KB);
    expect(drop).toBe(2);
    expect(bytes).toBe(256 * KB);
  });

  it("bounds a flood of tiny chunks by count", () => {
    const sizes = Array(250).fill(4);
    const { drop } = trimReplay(sizes, 1000);
    expect(sizes.length - drop).toBe(200);
  });

  it("keeps the newest chunk even when it alone exceeds the budget", () => {
    const sizes = [KB, 512 * KB];
    const { drop, bytes } = trimReplay(sizes, 513 * KB);
    expect(drop).toBe(1);
    expect(bytes).toBe(512 * KB);
  });

  it("never drops the only chunk", () => {
    const sizes = [512 * KB];
    expect(trimReplay(sizes, 512 * KB)).toEqual({ drop: 0, bytes: 512 * KB });
  });
});

describe("spawnPty", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
  });

  it("sends no launch for a plain shell, exactly as before", async () => {
    await spawnPty("t1", "/repo", 80, 24);
    expect(mocks.invoke).toHaveBeenCalledWith("pty_spawn", {
      id: "t1",
      cwd: "/repo",
      cols: 80,
      rows: 24,
    });
  });

  it("passes the launch through for an agent CLI", async () => {
    const launch = {
      harness: "claude" as const,
      args: ["--resume", "abc"],
      providerAccountId: "work",
    };
    await spawnPty("session:s1", "/repo", 100, 30, launch);
    expect(mocks.invoke).toHaveBeenCalledWith("pty_spawn", {
      id: "session:s1",
      cwd: "/repo",
      cols: 100,
      rows: 30,
      launch,
    });
  });
});

describe("a held PTY outlives its view", () => {
  const emitData = (id: string, text: string) =>
    mocks.listeners.get("pty-data")?.({
      payload: { id, data: btoa(text) },
    });
  const emitExit = (id: string, code: number | null) =>
    mocks.listeners.get("pty-exit")?.({ payload: { id, code } });
  const text = (chunks: Uint8Array[]) =>
    chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");

  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
  });

  it("buffers output while nothing is mounted and replays it on the next mount", () => {
    holdPty("session:replay");
    // Subscribing once brings the event bridge up, as any mounted view would.
    subscribePty("session:replay", () => undefined, () => undefined)();
    emitData("session:replay", "hello ");
    emitData("session:replay", "again");

    const seen: Uint8Array[] = [];
    const stop = subscribePty("session:replay", (c) => seen.push(c), () => undefined);
    expect(text(seen)).toBe("hello again");
    stop();
    void killPty("session:replay");
  });

  it("remembers an exit that happened while unmounted and reports it on mount", () => {
    holdPty("session:exit");
    subscribePty("session:exit", () => undefined, () => undefined)();
    emitExit("session:exit", 3);
    expect(ptyExitCode("session:exit")).toBe(3);

    const onExit = vi.fn();
    subscribePty("session:exit", () => undefined, onExit)();
    expect(onExit).toHaveBeenCalledWith(3);
  });

  it("forgets the exit once the PTY is spawned or killed again", async () => {
    holdPty("session:respawn");
    subscribePty("session:respawn", () => undefined, () => undefined)();
    emitExit("session:respawn", 0);
    expect(ptyExitCode("session:respawn")).toBe(0);
    await spawnPty("session:respawn", "/repo", 80, 24);
    expect(ptyExitCode("session:respawn")).toBeUndefined();

    holdPty("session:kill");
    subscribePty("session:kill", () => undefined, () => undefined)();
    emitExit("session:kill", 1);
    await killPty("session:kill");
    expect(ptyExitCode("session:kill")).toBeUndefined();
  });

  it("does not keep an unheld terminal's exit, as before", () => {
    const stop = subscribePty("term:plain", () => undefined, () => undefined);
    stop();
    emitExit("term:plain", 0);
    expect(ptyExitCode("term:plain")).toBeUndefined();
  });

  it("stops buffering after the PTY is killed", async () => {
    holdPty("session:gone");
    subscribePty("session:gone", () => undefined, () => undefined)();
    await killPty("session:gone");
    emitData("session:gone", "late");
    const seen: Uint8Array[] = [];
    subscribePty("session:gone", (c) => seen.push(c), () => undefined)();
    expect(seen).toEqual([]);
  });
});
