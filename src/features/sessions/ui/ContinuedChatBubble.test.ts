// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContinuedChatBubble } from "./ContinuedChatBubble";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("names the source chat and opens it on click", () => {
  const onOpenSession = vi.fn();
  act(() =>
    root.render(
      createElement(ContinuedChatBubble, {
        card: {
          from: "claude",
          to: "claude",
          kind: "handoff",
          files: 2,
          source: "Fix the footer",
          sourceId: "source-1",
        },
        chat: true,
        onOpenSession,
      }),
    ),
  );
  expect(container.textContent).toContain("Continued from");
  expect(container.textContent).toContain("Fix the footer");
  expect(container.textContent).toContain("2 files");
  const button = container.querySelector("button")!;
  expect(button.title).toBe("Open Fix the footer");
  act(() => button.click());
  expect(onOpenSession).toHaveBeenCalledWith("source-1");
});

it("stays a plain label on an older turn that saved no source", () => {
  act(() =>
    root.render(
      createElement(ContinuedChatBubble, {
        card: { from: "claude", to: "claude", kind: "handoff" },
        chat: true,
        onOpenSession: vi.fn(),
      }),
    ),
  );
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).toContain("Continued chat");
  expect(container.textContent).toContain("Claude Code");
});
