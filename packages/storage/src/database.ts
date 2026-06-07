import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The default datastore is a single SQLite file (`~/.gin/gin.db`). Each
 * subsystem (runtime, memory, channels, durable…) owns its own tables and
 * registers its own namespaced migrations — see `migrate()` — so packages
 * stay independent while sharing one durable store.
 */

export type GinDatabase = Database.Database;

export interface OpenDatabaseOptions {
  /** ":memory:" is supported for tests. */
  path: string;
}

export function openDatabase(opts: OpenDatabaseOptions): GinDatabase {
  if (opts.path !== ":memory:") mkdirSync(dirname(opts.path), { recursive: true });
  const db = new Database(opts.path);
  // WAL keeps readers (observability, Command Center) from blocking writers
  // (runtime, outbox). NORMAL sync is durable enough under WAL for app data.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}
