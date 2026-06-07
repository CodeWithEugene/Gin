import { describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { migrate, type Migration } from "./migrate.js";

const usersV1: Migration = {
  version: 1,
  name: "create-users",
  up: (db) => db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)"),
};
const usersV2: Migration = {
  version: 2,
  name: "add-email",
  up: (db) => db.exec("ALTER TABLE users ADD COLUMN email TEXT"),
};

describe("openDatabase", () => {
  it("opens an in-memory database with WAL-compatible pragmas applied", () => {
    const db = openDatabase({ path: ":memory:" });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });
});

describe("migrate", () => {
  it("applies migrations once and is idempotent", () => {
    const db = openDatabase({ path: ":memory:" });
    expect(migrate(db, "test", [usersV1, usersV2])).toBe(2);
    expect(migrate(db, "test", [usersV1, usersV2])).toBe(0);
    db.prepare("INSERT INTO users (id, name, email) VALUES (?, ?, ?)").run("u1", "Ada", "a@b.c");
    expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
    db.close();
  });

  it("applies only newer migrations on upgrade", () => {
    const db = openDatabase({ path: ":memory:" });
    expect(migrate(db, "test", [usersV1])).toBe(1);
    expect(migrate(db, "test", [usersV1, usersV2])).toBe(1);
    db.close();
  });

  it("keeps namespaces independent", () => {
    const db = openDatabase({ path: ":memory:" });
    migrate(db, "alpha", [usersV1]);
    const other: Migration = {
      version: 1,
      name: "create-things",
      up: (d) => d.exec("CREATE TABLE things (id TEXT PRIMARY KEY)"),
    };
    expect(migrate(db, "beta", [other])).toBe(1);
    db.close();
  });

  it("rejects non-contiguous versions", () => {
    const db = openDatabase({ path: ":memory:" });
    expect(() => migrate(db, "bad", [{ ...usersV1, version: 2 }])).toThrow(/contiguous/);
    db.close();
  });
});
