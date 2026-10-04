// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  createPresence,
  IDLE_MS,
  PRESENCE_INTERVAL_MS,
  SEND_THROTTLE_MS,
  useHostPresence,
  type PresenceUpdate,
} from "./presence";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

let sent: [string, PresenceUpdate][];
let focused: boolean;
let presence: ReturnType<typeof createPresence>;
let target: EventTarget;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  focused = true;
  target = new EventTarget();
  presence = createPresence({
    send: async (machineId, update) => {
      sent.push([machineId, update]);
    },
    now: () => Date.now(),
    target: target as Window,
    hasFocus: () => focused,
  });
});
afterEach(() => {
  presence.dispose();
  vi.useRealTimers();
});

it("reports the focused host session, then every 30 s while visible", () => {
  presence.claim("pane", { machineId: "m", sessionId: "s" });
  expect(sent).toEqual([["m", { visible: true, focusedSessionId: "s" }]]);
  vi.advanceTimersByTime(PRESENCE_INTERVAL_MS);
  expect(sent).toHaveLength(2);
  // Re-claiming the pane that is already focused says nothing new.
  presence.claim("pane", { machineId: "m", sessionId: "s" });
  expect(sent).toHaveLength(2);
});

it("throttles quick focus changes to one update per machine", () => {
  presence.claim("a", { machineId: "m", sessionId: "s1" });
  presence.claim("b", { machineId: "m", sessionId: "s2" });
  presence.claim("c", { machineId: "m", sessionId: "s3" });
  expect(sent).toHaveLength(1);
  vi.advanceTimersByTime(SEND_THROTTLE_MS);
  expect(sent).toEqual([
    ["m", { visible: true, focusedSessionId: "s1" }],
    ["m", { visible: true, focusedSessionId: "s3" }],
  ]);
});

it("is not visible when the window is blurred or idle for 2 minutes", () => {
  presence.claim("pane", { machineId: "m", sessionId: "s" });
  focused = false;
  target.dispatchEvent(new Event("blur"));
  vi.advanceTimersByTime(SEND_THROTTLE_MS);
  expect(sent.at(-1)).toEqual(["m", { visible: false, focusedSessionId: "s" }]);
  // Nothing more while hidden.
  const count = sent.length;
  vi.advanceTimersByTime(PRESENCE_INTERVAL_MS * 3);
  expect(sent).toHaveLength(count);

  focused = true;
  target.dispatchEvent(new Event("focus"));
  vi.advanceTimersByTime(SEND_THROTTLE_MS);
  expect(sent.at(-1)).toEqual(["m", { visible: true, focusedSessionId: "s" }]);
  vi.advanceTimersByTime(IDLE_MS);
  expect(sent.at(-1)).toEqual(["m", { visible: false, focusedSessionId: "s" }]);
  vi.advanceTimersByTime(SEND_THROTTLE_MS);
  target.dispatchEvent(new Event("keydown"));
  vi.advanceTimersByTime(SEND_THROTTLE_MS);
  expect(sent.at(-1)).toEqual(["m", { visible: true, focusedSessionId: "s" }]);
});

it("tells the previous machine when its session leaves the screen", () => {
  presence.claim("a", { machineId: "m1", sessionId: "s1" });
  presence.claim("b", { machineId: "m2", sessionId: "s2" });
  expect(sent).toEqual([
    ["m1", { visible: true, focusedSessionId: "s1" }],
    ["m2", { visible: true, focusedSessionId: "s2" }],
  ]);
  vi.advanceTimersByTime(SEND_THROTTLE_MS);
  expect(sent.at(-1)).toEqual(["m1", { visible: true }]);
  presence.release("b");
  vi.advanceTimersByTime(SEND_THROTTLE_MS);
  expect(sent.at(-1)).toEqual(["m1", { visible: true, focusedSessionId: "s1" }]);
});

it("ignores failed reports", async () => {
  const failing = createPresence({
    send: () => Promise.reject(new Error("offline")),
    target: new EventTarget() as Window,
    hasFocus: () => true,
  });
  failing.claim("pane", { machineId: "m", sessionId: "s" });
  await Promise.resolve();
  failing.dispose();
});

it("only reports sessions on hosts with presence", async () => {
  vi.useRealTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(invoke).mockResolvedValue({});
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  const Pane = ({ active }: { active: boolean }) => {
    useHostPresence("machine", "session", active);
    return null;
  };
  await act(async () => root.render(createElement(Pane, { active: false })));
  expect(invoke).not.toHaveBeenCalled();
  await act(async () => root.render(createElement(Pane, { active: true })));
  expect(invoke).toHaveBeenCalledWith("remote_request", {
    machineId: "machine",
    method: "presence.update",
    params: { visible: expect.any(Boolean), focusedSessionId: "session" },
  });
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
