// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PromptCacheWarning,
  usePromptCacheExpired,
} from "./PromptCacheWarning";
import type { PromptCacheState } from "../model/promptCache";

const HOUR = 3_600_000;
const cache = { ttlMs: HOUR, lastUsedAt: 0, expiresAt: HOUR };

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Probe({ state }: { state?: PromptCacheState }) {
  return createElement("span", null, String(usePromptCacheExpired(state)));
}

it("flips to expired 30s before the cache runs out, without a re-render", () => {
  vi.setSystemTime(HOUR - 31_000);
  act(() => root.render(createElement(Probe, { state: cache })));
  expect(container.textContent).toBe("false");

  act(() => vi.advanceTimersByTime(1_000));
  expect(container.textContent).toBe("true");
});

it("is never expired without a cache window", () => {
  vi.setSystemTime(10 * HOUR);
  act(() => root.render(createElement(Probe, {})));
  expect(container.textContent).toBe("false");
});

it("explains the expiry on hover", () => {
  vi.setSystemTime(HOUR + 12 * 60_000);
  act(() =>
    root.render(
      createElement(PromptCacheWarning, { cache, contextUsed: 164_000 }),
    ),
  );
  const warning = container.querySelector('[role="img"]')!;
  expect(warning.getAttribute("aria-label")).toContain("Prompt cache expired");

  act(() => {
    warning.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  const text = document.body.textContent ?? "";
  expect(text).toContain("Idle for 1h 12m");
  expect(text).toContain("about 164K tokens of context uncached");
});
