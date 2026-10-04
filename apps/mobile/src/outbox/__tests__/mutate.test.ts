import { describe, expect, it } from "vitest";
import { MUTATION_RETRY_MS, MutationUnknownError, runMutation } from "../mutate";

const failure = (code: string, retryable: boolean) => Object.assign(new Error(code), { code, retryable });

function harness(answers: (() => unknown)[]) {
  let t = 0;
  const keys: (string | undefined)[] = [];
  return {
    keys,
    deps: {
      newKey: () => "key-1",
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      request: async (key: string | undefined) => {
        keys.push(key);
        const next = answers.shift();
        if (!next) throw failure("offline", true);
        return next();
      },
    },
  };
}

describe("mutations", () => {
  it("retries with the same key until the host answers", async () => {
    const { deps, keys } = harness([
      () => {
        throw failure("offline", true);
      },
      () => {
        throw failure("timeout", true);
      },
      () => ({ ok: 1 }),
    ]);
    await expect(runMutation({ ...deps, idempotent: true })).resolves.toEqual({ ok: 1 });
    expect(keys).toEqual(["key-1", "key-1", "key-1"]);
  });

  it("gives up after 60 s with Result unknown", async () => {
    const { deps, keys } = harness([]);
    const result = runMutation({ ...deps, idempotent: true });
    await expect(result).rejects.toBeInstanceOf(MutationUnknownError);
    await expect(result).rejects.toThrow("Result unknown. Refresh to check.");
    // 1 + 2 + 4 + 8 + 16 + 30 = 61 s would pass the deadline: six tries.
    expect(keys).toHaveLength(6);
    expect(MUTATION_RETRY_MS).toBe(60_000);
  });

  it("never retries a host error that isn't retryable", async () => {
    const { deps, keys } = harness([
      () => {
        throw failure("invalid_params", false);
      },
    ]);
    await expect(runMutation({ ...deps, idempotent: true })).rejects.toMatchObject({ code: "invalid_params" });
    expect(keys).toHaveLength(1);
  });

  it("tries once, without a key, when the host lacks mutations.idempotent", async () => {
    const { deps, keys } = harness([]);
    await expect(runMutation({ ...deps, idempotent: false })).rejects.toMatchObject({ code: "offline" });
    expect(keys).toEqual([undefined]);
  });
});
