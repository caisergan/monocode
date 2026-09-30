// @vitest-environment happy-dom
// Keep this as .ts because the project test glob intentionally excludes .test.tsx.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pty = vi.hoisted(() => ({
  spawnPty: vi.fn(),
  killPty: vi.fn(),
  holdPty: vi.fn(),
  getPtyStatus: vi.fn(),
  resizePty: vi.fn(),
  writePty: vi.fn(),
  ptyExitCode: vi.fn(),
  subscribePty: vi.fn(),
  exitHandler: undefined as undefined | ((code: number | null) => void),
  unsubscribe: vi.fn(),
  lines: [] as string[],
}));

vi.mock("../../../platform/tauri/pty", () => ({
  spawnPty: pty.spawnPty,
  killPty: pty.killPty,
  holdPty: pty.holdPty,
  getPtyStatus: pty.getPtyStatus,
  resizePty: pty.resizePty,
  writePty: pty.writePty,
  ptyExitCode: pty.ptyExitCode,
  subscribePty: pty.subscribePty,
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    element = document.createElement("div");
    options: Record<string, unknown> = {};
    buffer = {
      active: { type: "normal" },
      onBufferChange: () => ({ dispose() {} }),
    };
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    open() {}
    onData() {
      return { dispose() {} };
    }
    onRender() {
      return { dispose() {} };
    }
    attachCustomKeyEventHandler() {}
    attachCustomWheelEventHandler() {}
    write() {}
    writeln(line: string) {
      pty.lines.push(line);
    }
    focus() {}
    hasSelection() {
      return false;
    }
    getSelection() {
      return "";
    }
    paste() {}
    clear() {}
    input() {}
    dispose() {}
  },
}));
vi.mock("../model/terminalLayout", () => ({
  applyTerminalChrome: () => undefined,
  fitTerminal: () => ({ cols: 100, rows: 30 }),
  resetGridStretch: () => undefined,
}));

import { TerminalView } from "./TerminalView";

let container: HTMLDivElement;
let root: Root;

const notRunning = () =>
  pty.getPtyStatus.mockRejectedValue(new Error("Terminal is not running"));

const launchSpec = { harness: "claude" as const, args: ["--resume", "abc"] };

type Props = Parameters<typeof TerminalView>[0];

function render(props: Partial<Props> = {}) {
  return act(async () =>
    root.render(
      createElement(TerminalView, {
        id: "session:s1",
        cwd: "/work/app",
        active: true,
        ...props,
      }),
    ),
  );
}

/** Lets startup promises and animation frames run. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  pty.lines.length = 0;
  pty.exitHandler = undefined;
  for (const fn of [
    pty.spawnPty,
    pty.killPty,
    pty.holdPty,
    pty.getPtyStatus,
    pty.resizePty,
    pty.writePty,
    pty.ptyExitCode,
    pty.subscribePty,
    pty.unsubscribe,
  ]) {
    fn.mockReset();
  }
  pty.spawnPty.mockResolvedValue(undefined);
  pty.killPty.mockResolvedValue(undefined);
  pty.resizePty.mockResolvedValue(undefined);
  pty.writePty.mockResolvedValue(undefined);
  // Running by default; tests that need an empty slot reject it.
  pty.getPtyStatus.mockResolvedValue({ foreground: null });
  pty.ptyExitCode.mockReturnValue(undefined);
  pty.subscribePty.mockImplementation(
    (_id: string, _data: unknown, onExit: (code: number | null) => void) => {
      pty.exitHandler = onExit;
      return pty.unsubscribe;
    },
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("a plain terminal", () => {
  it("starts the user's shell and kills it when the view goes away", async () => {
    await render();
    await settle();
    expect(pty.spawnPty).toHaveBeenCalledWith("session:s1", "/work/app", 80, 24);
    expect(pty.holdPty).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    await settle();
    expect(pty.killPty).toHaveBeenCalledWith("session:s1");
    root = createRoot(container);
  });
});

describe("a persistent terminal", () => {
  it("starts the agent with its launch when nothing is running", async () => {
    notRunning();
    const launch = vi.fn().mockResolvedValue(launchSpec);
    await render({ persistent: true, launch });
    await settle();
    expect(pty.holdPty).toHaveBeenCalledWith("session:s1");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(pty.spawnPty).toHaveBeenCalledWith("session:s1", "/work/app", 80, 24, launchSpec);
  });

  it("holds the PTY before it asks whether one is running, so an early exit is not missed", async () => {
    const order: string[] = [];
    pty.holdPty.mockImplementation(() => void order.push("hold"));
    pty.getPtyStatus.mockImplementation(async () => {
      order.push("status");
      return { foreground: null };
    });
    await render({ persistent: true, launch: async () => launchSpec });
    await settle();
    expect(order.slice(0, 2)).toEqual(["hold", "status"]);
  });

  it("attaches to a running agent without starting another, then nudges it to redraw", async () => {
    const launch = vi.fn();
    await render({ persistent: true, launch });
    await settle();
    expect(launch).not.toHaveBeenCalled();
    expect(pty.spawnPty).not.toHaveBeenCalled();
    // Shrink by a row and restore, which makes a running TUI repaint.
    const sizes = pty.resizePty.mock.calls.map(([, cols, rows]) => [cols, rows]);
    expect(sizes).toContainEqual([80, 23]);
    expect(sizes.at(-1)).toEqual([80, 24]);
    expect(sizes.indexOf(sizes.find(([, rows]) => rows === 23)!)).toBeLessThan(
      sizes.length - 1,
    );
  });

  it("leaves the agent running when the view goes away", async () => {
    notRunning();
    await render({ persistent: true, launch: async () => launchSpec });
    await settle();
    await act(async () => root.unmount());
    await settle();
    expect(pty.killPty).not.toHaveBeenCalled();
    expect(pty.unsubscribe).toHaveBeenCalled();
    root = createRoot(container);
  });

  it("does not start a new agent behind the back of one that already ended", async () => {
    pty.ptyExitCode.mockReturnValue(2);
    const launch = vi.fn();
    await render({ persistent: true, launch });
    await settle();
    expect(pty.spawnPty).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(pty.getPtyStatus).not.toHaveBeenCalled();
  });

  it("reports an exit, including one that was waiting for a view", async () => {
    notRunning();
    const onExit = vi.fn();
    await render({ persistent: true, launch: async () => launchSpec, onExit });
    await settle();
    await act(async () => pty.exitHandler?.(3));
    expect(onExit).toHaveBeenCalledWith(3);
    expect(pty.lines.join("\n")).toContain("[process exited (3)]");
  });

  it("lets go of the PTY and shows the error when the agent cannot start", async () => {
    notRunning();
    pty.spawnPty.mockRejectedValue(new Error("Claude Code CLI not found."));
    await render({ persistent: true, launch: async () => launchSpec });
    await settle();
    expect(pty.killPty).toHaveBeenCalledWith("session:s1");
    expect(pty.lines.join("\n")).toContain("Claude Code CLI not found.");
  });

  it("lets go of the PTY when the launch cannot even be worked out", async () => {
    notRunning();
    await render({
      persistent: true,
      launch: async () => {
        throw new Error("bad launch");
      },
    });
    await settle();
    expect(pty.spawnPty).not.toHaveBeenCalled();
    expect(pty.killPty).toHaveBeenCalledWith("session:s1");
  });
});
