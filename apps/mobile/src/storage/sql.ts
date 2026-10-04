// The SQL surface the cache uses (12 §12.6). expo-sqlite backs it in the app
// and an in-memory SQLite backs it in tests, so the schema, the queries and
// eviction run the same SQL in both.

export type SqlValue = string | number | null;

/** A driver without ordering guarantees: one call per statement kind. */
export interface SqlDriver {
  exec(sql: string): Promise<void>;
  run(sql: string, params: SqlValue[]): Promise<{ changes: number }>;
  all<T>(sql: string, params: SqlValue[]): Promise<T[]>;
}

export interface Sql {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  first<T>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  /** Runs `task` alone, inside BEGIN/COMMIT; rolls back if it throws. */
  transaction<T>(task: (tx: Sql) => Promise<T>): Promise<T>;
}

function direct(driver: SqlDriver): Omit<Sql, "transaction"> {
  return {
    exec: (sql) => driver.exec(sql),
    run: (sql, params = []) => driver.run(sql, params),
    all: (sql, params = []) => driver.all(sql, params),
    first: async (sql, params = []) => (await driver.all<never>(sql, params))[0],
  };
}

/** Serialises every call, so an async write can never land inside another
 * caller's transaction. Calls made with `tx` inside a transaction bypass the
 * queue (they are already holding it). */
export function serialSql(driver: SqlDriver): Sql {
  let tail: Promise<unknown> = Promise.resolve();
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };
  const inner = direct(driver);
  const nested: Sql = {
    ...inner,
    transaction: (task) => task(nested),
  };
  return {
    exec: (sql) => queue(() => inner.exec(sql)),
    run: (sql, params) => queue(() => inner.run(sql, params)),
    all: (sql, params) => queue(() => inner.all(sql, params)),
    first: (sql, params) => queue(() => inner.first(sql, params)),
    transaction: (task) =>
      queue(async () => {
        await driver.exec("BEGIN IMMEDIATE");
        try {
          const result = await task(nested);
          await driver.exec("COMMIT");
          return result;
        } catch (error) {
          await driver.exec("ROLLBACK").catch(() => undefined);
          throw error;
        }
      }),
  };
}
