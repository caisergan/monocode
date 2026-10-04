import { describe, expect, it } from "vitest";
import { DESKTOP_PRESENCE_MS, PHONE_PRESENCE_MS, PresenceMap, parsePresence } from "./presence";

describe("presence", () => {
  it("validates reports", () => {
    expect(parsePresence({ visible: true, focusedSessionId: "s1" })).toEqual({ visible: true, focusedSessionId: "s1" });
    expect(parsePresence({ visible: false, focusedSessionId: null })).toEqual({ visible: false });
    for (const bad of [null, [], {}, { visible: 1 }, { visible: true, focusedSessionId: 5 }, { visible: true, focusedSessionId: "" }])
      expect(() => parsePresence(bad)).toThrow(expect.objectContaining({ code: "invalid_params" }));
  });

  it("counts a device as present only while its report is fresh", () => {
    const presence = new PresenceMap();
    presence.update("phone", { visible: true, focusedSessionId: "s1" }, "direct", 1_000);
    presence.update("desktop", { visible: true, focusedSessionId: "s1" }, "http", 1_000);
    presence.update("hidden", { visible: false, focusedSessionId: "s1" }, "relay", 1_000);
    expect(presence.watching("s1", 60_000, 1_000)).toEqual(["phone", "desktop"]);
    expect(presence.watching("s1", 20_000, 1_000 + 30_000)).toEqual([]);
    expect(presence.watching("s1", 60_000, 1_000 + PHONE_PRESENCE_MS + 1)).toEqual(["desktop"]);
    expect(presence.isPresent("desktop", 1_000 + DESKTOP_PRESENCE_MS)).toBe(true);
    expect(presence.isPresent("desktop", 1_000 + DESKTOP_PRESENCE_MS + 1)).toBe(false);
    expect(presence.isPresent("hidden", 1_000)).toBe(false);
    presence.clear("phone");
    expect(presence.get("phone")).toBeUndefined();
  });
});
