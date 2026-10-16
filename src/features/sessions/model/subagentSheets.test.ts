import { expect, it, vi } from "vitest";
import {
  closeSubagentSheet,
  holdSubagentSheet,
  openSubagentSheet,
  peekSubagentSheet,
  shownSubagentSheet,
  subscribeSubagentSheets,
  toggleSubagentSheet,
} from "./subagentSheets";

const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

it("keeps one open run per session, each on its own", () => {
  const listener = vi.fn();
  const unsubscribe = subscribeSubagentSheets(listener);
  openSubagentSheet("sheets-a", "run-1");
  openSubagentSheet("sheets-b", "run-2");
  expect(peekSubagentSheet("sheets-a")).toBe("run-1");
  expect(peekSubagentSheet("sheets-b")).toBe("run-2");

  // Opening another run of the same session switches to it.
  openSubagentSheet("sheets-a", "run-3");
  expect(peekSubagentSheet("sheets-a")).toBe("run-3");
  // Opening the open run again changes nothing.
  listener.mockClear();
  openSubagentSheet("sheets-a", "run-3");
  expect(listener).not.toHaveBeenCalled();

  toggleSubagentSheet("sheets-a", "run-3");
  expect(peekSubagentSheet("sheets-a")).toBeNull();
  toggleSubagentSheet("sheets-a", "run-1");
  expect(peekSubagentSheet("sheets-a")).toBe("run-1");

  closeSubagentSheet("sheets-a");
  closeSubagentSheet("sheets-b");
  expect(peekSubagentSheet("sheets-a")).toBeNull();
  expect(peekSubagentSheet("sheets-b")).toBeNull();
  unsubscribe();
});

it("shows the open run only while a pane holds its session", async () => {
  openSubagentSheet("sheets-held", "run");
  // Opened from the sidebar before the session's pane has mounted.
  expect(shownSubagentSheet("sheets-held")).toBeNull();
  const release = holdSubagentSheet("sheets-held");
  expect(shownSubagentSheet("sheets-held")).toBe("run");

  release();
  await settle();
  // Leaving the session closes its sheet, as the pane's own state did.
  expect(peekSubagentSheet("sheets-held")).toBeNull();
  expect(shownSubagentSheet("sheets-held")).toBeNull();
});

it("keeps the sheet open through a remount in the same commit", async () => {
  openSubagentSheet("sheets-remount", "run");
  const first = holdSubagentSheet("sheets-remount");
  // StrictMode runs an effect's cleanup and the effect again back to back.
  first();
  const second = holdSubagentSheet("sheets-remount");
  await settle();
  expect(shownSubagentSheet("sheets-remount")).toBe("run");

  // A second pane on the session keeps it open when the first goes.
  const other = holdSubagentSheet("sheets-remount");
  second();
  second();
  await settle();
  expect(shownSubagentSheet("sheets-remount")).toBe("run");
  other();
  await settle();
  expect(peekSubagentSheet("sheets-remount")).toBeNull();
});
