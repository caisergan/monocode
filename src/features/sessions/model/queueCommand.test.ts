import { describe, expect, it } from "vitest";
import { consumeQueueCommand } from "./queueCommand";

describe("consumeQueueCommand", () => {
  it("strips a leading /queue and keeps the message", () => {
    expect(consumeQueueCommand("/queue run the tests")).toEqual({
      text: "run the tests",
      matched: true,
    });
    expect(consumeQueueCommand("  /QUEUE\nline one\nline two")).toEqual({
      text: "line one\nline two",
      matched: true,
    });
  });

  it("matches the bare command with nothing to send", () => {
    expect(consumeQueueCommand("/queue")).toEqual({ text: "", matched: true });
  });

  it("leaves other prompts alone", () => {
    for (const text of ["/queued items", "please /queue this", "/plan x"]) {
      expect(consumeQueueCommand(text)).toEqual({ text, matched: false });
    }
  });
});
