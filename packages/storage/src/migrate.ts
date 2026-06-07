import { GinError } from "@gin/core";
import type { GinDatabase } from "./database.js";

/**
 * Namespaced migrations: each package owns a namespace (e.g. "runtime",
 * "memory", "channels") and an ordered list of migrations. Applied versions
 * are tracked per namespace in `gin_migrations`, so independently developed
 * packages never contend over a single version counter.
 */

export interface Migration {
  /** Monotonically increasing within the namespace, starting at 1. */
  version: number;
  name: string;
  up: (db: GinDatabase) => void;
}

export function migrate(db: GinDatabase, namespace: string, migrations: Migration[]): number {
  db.exec(
    `CREATE TABLE IF NOT EXISTS gin_migrations (
      namespace TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      PRIMARY KEY (namespace, version)
    )`,
  );

  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  sorted.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new GinError(
        "config_invalid",
        `Migrations for "${namespace}" must be contiguous from 1; found version ${m.version} at position ${i}.`,
      );
    }
  });

  const current =
    (
      db
        .prepare("SELECT MAX(version) AS v FROM gin_migrations WHERE namespace = ?")
        .get(namespace) as { v: number | null }
    ).v ?? 0;

  const insert = db.prepare(
    "INSERT INTO gin_migrations (namespace, version, name, applied_at) VALUES (?, ?, ?, ?)",
  );

  let applied = 0;
  for (const m of sorted) {
    if (m.version <= current) continue;
    db.transaction(() => {
      m.up(db);
      insert.run(namespace, m.version, m.name, Date.now());
    })();
    applied++;
  }
  return applied;
}
