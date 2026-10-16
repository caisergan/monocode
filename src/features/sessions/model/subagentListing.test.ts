import { expect, it, vi } from "vitest";
import {
  listSubagents,
  subagentsListed,
  subscribeSubagentListing,
} from "./subagentListing";

const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

it("lists a session while any row holds it", async () => {
  const listener = vi.fn();
  const unsubscribe = subscribeSubagentListing(listener);
  expect(subagentsListed("listing-a")).toBe(false);

  const first = listSubagents("listing-a");
  const second = listSubagents("listing-a");
  expect(subagentsListed("listing-a")).toBe(true);
  expect(subagentsListed("listing-b")).toBe(false);
  expect(listener).toHaveBeenCalledTimes(1);

  first();
  first();
  await settle();
  expect(subagentsListed("listing-a")).toBe(true);

  second();
  await settle();
  expect(subagentsListed("listing-a")).toBe(false);
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
});

it("stays listed through a row mounted again in the same commit", async () => {
  const listener = vi.fn();
  const release = listSubagents("listing-remount");
  const unsubscribe = subscribeSubagentListing(listener);
  release();
  expect(subagentsListed("listing-remount")).toBe(true);
  const again = listSubagents("listing-remount");
  await settle();
  expect(subagentsListed("listing-remount")).toBe(true);
  // The dock never hears of the gap, so it never rises in between.
  expect(listener).not.toHaveBeenCalled();
  again();
  await settle();
  expect(subagentsListed("listing-remount")).toBe(false);
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
});
