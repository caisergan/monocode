import { describe, expect, it } from "vitest";
import { redirectSystemPath } from "@/app/+native-intent";
import {
  isPairingLink,
  pendingPairingLink,
  subscribePairingLink,
  takePairingLink,
} from "@/features/connection/pairingLink";

const LINK = "monocode://pair?i=eyJ2ZXJzaW9uIjoxfQ";

describe("pairing links opened from outside the app", () => {
  it.each([LINK, "MONOCODE://pair?i=abc", " monocode://pair/?i=abc", "monocode://pair"])(
    "recognises %s",
    (path) => expect(isPairingLink(path)).toBe(true),
  );

  it.each([
    "monocode://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081",
    "monocode://pairing?i=abc",
    "monocode:///project/abc",
    "/settings",
    "https://example.com/pair?i=abc",
  ])("leaves %s to the router", (path) => {
    expect(isPairingLink(path)).toBe(false);
    expect(redirectSystemPath({ path, initial: false })).toBe(path);
    expect(pendingPairingLink()).toBeNull();
  });

  it("keeps the link for the connection, opening at home or staying put", () => {
    let notified = 0;
    const stop = subscribePairingLink(() => notified++);
    expect(redirectSystemPath({ path: LINK, initial: true })).toBe("/");
    expect(pendingPairingLink()).toBe(LINK);
    const newer = `${LINK}x`;
    expect(redirectSystemPath({ path: newer, initial: false })).toBeNull();
    expect(pendingPairingLink()).toBe(newer);
    // Taking an older link leaves the newer one waiting.
    takePairingLink(LINK);
    expect(pendingPairingLink()).toBe(newer);
    takePairingLink(newer);
    expect(pendingPairingLink()).toBeNull();
    expect(notified).toBe(3);
    stop();
  });
});
