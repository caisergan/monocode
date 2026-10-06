/**
 * A revision counter that waiters can block on. Waiting from a revision that
 * is already stale returns at once, so a change between a caller's check and
 * its wait is never missed.
 */
export function createChangeFeed() {
  let revision = 0;
  const listeners = new Set<() => void>();
  return {
    revision: () => revision,
    bump() {
      revision += 1;
      for (const listener of [...listeners]) listener();
    },
    changed(since: number, timeoutMs: number): Promise<void> {
      if (revision > since) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          listeners.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, timeoutMs));
        listeners.add(done);
      });
    },
  };
}
