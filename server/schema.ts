import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function migrate(db: DatabaseSync) {
  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  `);
  for (const [version, name] of [[1, "001-initial.sql"], [2, "002-shared-projects.sql"], [3, "003-task-transfers.sql"]] as const) {
    if (db.prepare("SELECT 1 FROM migrations WHERE version=?").get(version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!db.prepare("SELECT 1 FROM migrations WHERE version=?").get(version)) {
        db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
        db.prepare("INSERT INTO migrations VALUES(?,?)").run(version, new Date().toISOString());
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
