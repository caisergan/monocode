// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HandoffMiniCard } from "./HandoffMiniCard";

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

function toggle() {
  return Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("context"),
  )!;
}

it("names the continued chat and reveals the recap on request", () => {
  act(() =>
    root.render(
      createElement(HandoffMiniCard, {
        card: {
          from: "claude",
          to: "claude",
          brief: "First request: fix the footer",
          files: 2,
          source: "Fix the footer",
        },
      }),
    ),
  );
  expect(container.textContent).toContain("Continued chat");
  expect(container.textContent).toContain("Fix the footer");
  expect(container.textContent).toContain("2 files");
  expect(container.querySelector("pre")).toBeNull();

  act(() => toggle().click());
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector("pre")?.textContent).toBe(
    "First request: fix the footer",
  );

  act(() => toggle().click());
  expect(container.querySelector("pre")).toBeNull();
});

it("keeps the provider names on a handoff to another agent", () => {
  act(() =>
    root.render(
      createElement(HandoffMiniCard, {
        card: { from: "claude", to: "codex", brief: "Recap", source: "Ignored" },
      }),
    ),
  );
  expect(container.textContent).toContain("Handoff");
  expect(container.textContent).toContain("Codex");
  expect(container.textContent).not.toContain("Ignored");
});
