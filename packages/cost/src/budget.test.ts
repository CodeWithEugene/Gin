import { beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "@gin/core";
import { openDatabase } from "@gin/storage";
import { BudgetEngine } from "./budget.js";

const SESSION = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const AGENT = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

let engine: BudgetEngine;
let bus: EventBus;
let events: string[];

beforeEach(() => {
  bus = new EventBus();
  events = [];
  bus.on("*", (e) => events.push(e.type));
  engine = new BudgetEngine(openDatabase({ path: ":memory:" }), { bus });
});

describe("checkAndReserve", () => {
  it("allows spend under the limit and blocks at the limit", () => {
    engine.setBudget({ scope: "session", scopeRef: SESSION, limitUsd: 0.01 });

    engine.checkAndReserve({ sessionId: SESSION }); // $0 spent — fine
    engine.record({ sessionId: SESSION }, 0.004);
    engine.checkAndReserve({ sessionId: SESSION }); // $0.004 — still fine
    engine.record({ sessionId: SESSION }, 0.006);

    expect(() => engine.checkAndReserve({ sessionId: SESSION })).toThrow(/Budget exhausted/);
    expect(events).toContain("budget.exceeded");
  });

  it("blocks when the estimate would cross the limit", () => {
    engine.setBudget({ scope: "session", scopeRef: SESSION, limitUsd: 0.01 });
    engine.record({ sessionId: SESSION }, 0.008);
    expect(() => engine.checkAndReserve({ sessionId: SESSION }, 0.005)).toThrow(/exhausted/);
    // A smaller estimate still fits.
    engine.checkAndReserve({ sessionId: SESSION }, 0.001);
  });

  it("alert budgets warn without blocking", () => {
    engine.setBudget({
      scope: "agent",
      scopeRef: AGENT,
      limitUsd: 0.01,
      window: "day",
      action: "alert",
    });
    engine.record({ agentId: AGENT }, 0.02);
    engine.checkAndReserve({ agentId: AGENT }); // must not throw
    expect(events).toContain("budget.warning");
  });

  it("checks every applicable scope (session blocks even if agent is fine)", () => {
    engine.setBudget({ scope: "agent", scopeRef: AGENT, limitUsd: 100, window: "day" });
    engine.setBudget({ scope: "session", scopeRef: SESSION, limitUsd: 0.001 });
    engine.record({ agentId: AGENT, sessionId: SESSION }, 0.002);
    expect(() => engine.checkAndReserve({ agentId: AGENT, sessionId: SESSION })).toThrow(/session/);
  });

  it("scopes with no configured budget are unlimited", () => {
    engine.record({ sessionId: SESSION }, 999);
    engine.checkAndReserve({ sessionId: SESSION });
  });
});

describe("windows", () => {
  it("rolling day window ignores older spend", () => {
    engine.setBudget({ scope: "agent", scopeRef: AGENT, limitUsd: 0.01, window: "day" });
    const now = Date.now();
    // Manually backdate a ledger entry beyond the window:
    engine.record({ agentId: AGENT }, 0.02);
    const db = (
      engine as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }
    ).db;
    db.prepare("UPDATE spend_ledger SET created_at = ?").run(now - 2 * 86_400_000);

    engine.checkAndReserve({ agentId: AGENT }, 0, now); // old spend outside window
    expect(engine.spent("agent", AGENT, "day", now)).toBe(0);
    expect(engine.spent("agent", AGENT, "month", now)).toBeCloseTo(0.02);
  });
});

describe("bookkeeping", () => {
  it("upserts budgets and reports status with remaining", () => {
    engine.setBudget({ scope: "session", scopeRef: SESSION, limitUsd: 1 });
    engine.setBudget({ scope: "session", scopeRef: SESSION, limitUsd: 2 }); // upsert
    engine.record({ sessionId: SESSION }, 0.5);

    const status = engine.status({ sessionId: SESSION });
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ limitUsd: 2, spentUsd: 0.5, remainingUsd: 1.5 });
  });

  it("ensureBudget never overwrites an operator-set limit", () => {
    engine.setBudget({ scope: "session", scopeRef: SESSION, limitUsd: 5 });
    engine.ensureBudget({ scope: "session", scopeRef: SESSION, limitUsd: 1 });
    expect(engine.listBudgets("session", SESSION)[0]!.limitUsd).toBe(5);
  });

  it("ignores non-positive amounts", () => {
    engine.record({ sessionId: SESSION }, 0);
    expect(engine.spent("session", SESSION, "session")).toBe(0);
  });
});
