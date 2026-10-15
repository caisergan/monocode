// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...original,
    invoke: async (command: string, args?: unknown) =>
      command === "mcp_discover"
        ? []
        : command === "claude_mcp_list"
          ? ""
          : original.invoke(command, args),
  };
});
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import { Composer } from "./Composer";
import type { PromptCacheState } from "../model/promptCache";
import { saveConfirmExpiredCacheSend } from "../../settings/model/settings";

const HOUR = 3_600_000;
const expired: PromptCacheState = {
  ttlMs: HOUR,
  lastUsedAt: 0,
  expiresAt: HOUR,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderComposer({
  onSubmit,
  sessionId = "s1",
  promptCache = expired,
  contextUsed = 164_000,
  busy = false,
}: {
  onSubmit: () => void;
  sessionId?: string;
  promptCache?: PromptCacheState;
  contextUsed?: number;
  busy?: boolean;
}) {
  await act(async () =>
    root.render(
      createElement(Composer, {
        key: sessionId,
        focused: true,
        harness: "claude",
        model: "claude-sonnet",
        runtimeMode: "supervised",
        executionCwd: "/repo",
        initialDraft: "hello again",
        sessionId,
        hideProjectPicker: true,
        hideBranchPicker: true,
        onFocus: () => {},
        onCwdChange: () => {},
        onModelChange: () => {},
        onRuntimeModeChange: () => {},
        onSubmit,
        promptCache,
        context: { used: contextUsed, window: 200_000 },
        busy,
      }),
    ),
  );
}

async function pressEnter() {
  const textarea = container.querySelector("textarea")!;
  await act(async () =>
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  );
}

function warning() {
  return container.querySelector('[aria-label^="Prompt cache expired"]');
}

it("shows the warning and asks before re-reading an expired cache", async () => {
  const onSubmit = vi.fn(() => true);
  await renderComposer({ onSubmit });
  expect(warning()).not.toBeNull();

  await pressEnter();
  expect(onSubmit).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Re-read the whole chat?");
  await act(
    () => new Promise<void>((done) => requestAnimationFrame(() => done())),
  );
  expect(document.activeElement).toBe(button("Send anyway"));

  await act(async () => button("Send anyway")!.click());
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit.mock.calls[0][0]).toBe("hello again");
  expect(button("Send anyway")).toBeUndefined();
});

it("keeps the draft when the confirmation is cancelled", async () => {
  const onSubmit = vi.fn(() => true);
  await renderComposer({ onSubmit });
  await pressEnter();
  await act(async () => button("Cancel")!.click());
  expect(onSubmit).not.toHaveBeenCalled();
  expect(container.querySelector("textarea")!.value).toBe("hello again");

  // Cancelling does not count as confirming: the next send asks again.
  await pressEnter();
  expect(onSubmit).not.toHaveBeenCalled();
  expect(button("Send anyway")).toBeDefined();
});

it("stops asking in a chat once told to", async () => {
  const onSubmit = vi.fn(() => true);
  await renderComposer({ onSubmit, sessionId: "skip-me" });
  await pressEnter();
  const skip = document.body.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  )!;
  await act(async () => skip.click());
  await act(async () => button("Send anyway")!.click());
  expect(onSubmit).toHaveBeenCalledTimes(1);

  await renderComposer({ onSubmit, sessionId: "other" });
  await renderComposer({ onSubmit, sessionId: "skip-me" });
  await pressEnter();
  expect(onSubmit).toHaveBeenCalledTimes(2);
});

it("sends straight away when the setting is off", async () => {
  saveConfirmExpiredCacheSend(false);
  const onSubmit = vi.fn(() => true);
  await renderComposer({ onSubmit });
  expect(warning()).not.toBeNull();
  await pressEnter();
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it("neither warns nor asks for a small context, a warm cache or a running turn", async () => {
  const onSubmit = vi.fn(() => true);
  const warm = {
    ttlMs: HOUR,
    lastUsedAt: Date.now(),
    expiresAt: Date.now() + HOUR,
  };
  for (const props of [
    { sessionId: "small", contextUsed: 12_000 },
    { sessionId: "warm", promptCache: warm },
    { sessionId: "busy", busy: true },
  ]) {
    onSubmit.mockClear();
    await renderComposer({ onSubmit, ...props });
    expect(warning()).toBeNull();
    await pressEnter();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  }
});
