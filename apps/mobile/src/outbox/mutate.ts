// Mutating methods that aren't commands (06 §6.8): with `mutations.idempotent`
// each call carries an envelope key and is retried in memory with that same
// key for up to 60 s. Without the capability a mutation is tried once. Pure;
// the app passes its runtime's request and a UUID source.

import { backoffMs, toChannelError } from "./policy";

/** How long a keyed mutation keeps retrying while the app is alive. */
export const MUTATION_RETRY_MS = 60_000;

export const RESULT_UNKNOWN = "Result unknown. Refresh to check.";

/** The mutation may or may not have run; only a refresh can tell. */
export class MutationUnknownError extends Error {
  readonly code = "timeout";
  readonly retryable = false;
  constructor(readonly last: unknown) {
    super(RESULT_UNKNOWN);
  }
}

export type MutationDeps = {
  /** The host advertises `mutations.idempotent`. */
  idempotent: boolean;
  request: (key: string | undefined) => Promise<unknown>;
  newKey: () => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  retryForMs?: number;
};

export async function runMutation<T>(deps: MutationDeps): Promise<T> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!deps.idempotent) return (await deps.request(undefined)) as T;
  const key = deps.newKey();
  const deadline = now() + (deps.retryForMs ?? MUTATION_RETRY_MS);
  for (let failures = 1; ; failures++) {
    try {
      return (await deps.request(key)) as T;
    } catch (error) {
      if (!toChannelError(error).retryable) throw error;
      const wait = backoffMs(failures);
      if (now() + wait > deadline) throw new MutationUnknownError(error);
      await sleep(wait);
    }
  }
}
