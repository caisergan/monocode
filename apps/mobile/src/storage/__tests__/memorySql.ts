// Tests only: the cache's SQL on Node's in-memory SQLite, behind the same
// serialising wrapper the app uses over expo-sqlite.

import { DatabaseSync } from "node:sqlite";
import { serialSql, type Sql, type SqlDriver, type SqlValue } from "../sql";

export function memorySql(): { sql: Sql; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const driver: SqlDriver = {
    async exec(sql: string) {
      db.exec(sql);
    },
    async run(sql: string, params: SqlValue[]) {
      return { changes: Number(db.prepare(sql).run(...params).changes) };
    },
    async all<T>(sql: string, params: SqlValue[]) {
      return db.prepare(sql).all(...params) as unknown as T[];
    },
  };
  return { sql: serialSql(driver), db };
}
