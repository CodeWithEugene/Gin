import { beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "@gin/core";
import { openDatabase, type GinDatabase } from "@gin/storage";
import { ApprovalBroker } from "./approvals.js";
import { AuditLog } from "./audit.js";
import { OPERATOR, Rbac, type Principal } from "./rbac.js";

describe("Rbac", () => {
  const rbac = new Rbac();
  const viewer: Principal = { id: "v1", name: "viewer", roles: ["viewer"] };
  const approver: Principal = { id: "a1", name: "approver", roles: ["approver"] };

  it("operator can do everything", () => {
    expect(rbac.can(OPERATOR, "budget:write")).toBe(true);
    expect(rbac.can(OPERATOR, "anything:at-all")).toBe(true);
  });

  it("viewer reads but never writes", () => {
    expect(rbac.can(viewer, "traces:read")).toBe(true);
    expect(rbac.can(viewer, "budget:read")).toBe(true);
    expect(rbac.can(viewer, "budget:write")).toBe(false);
    expect(rbac.can(viewer, "approvals:decide")).toBe(false);
  });

  it("approver decides approvals but cannot touch budgets", () => {
    expect(rbac.can(approver, "approvals:decide")).toBe(true);
    expect(rbac.can(approver, "budget:write")).toBe(false);
  });

  it("supports resource wildcards and role unions", () => {
    const custom = new Rbac({ budgeteer: ["budget:*"], hybrid: [] });
    const budgeteer: Principal = { id: "b", name: "b", roles: ["budgeteer"] };
    expect(custom.can(budgeteer, "budget:write")).toBe(true);
    expect(custom.can(budgeteer, "budget:read")).toBe(true);
    expect(custom.can(budgeteer, "traces:read")).toBe(false);

    const multi: Principal = { id: "m", name: "m", roles: ["budgeteer", "unknown-role"] };
    expect(custom.can(multi, "budget:write")).toBe(true);
  });
});

describe("AuditLog", () => {
  it("appends and filters entries", () => {
    const audit = new AuditLog(openDatabase({ path: ":memory:" }));
    audit.append({
      actor: "operator",
      action: "budget.set",
      target: "agent/x",
      after: { limitUsd: 5 },
    });
    audit.append({ actor: "operator", action: "approval.decided", target: "appr/1" });
    audit.append({ actor: "bot", action: "budget.set", target: "agent/y" });

    expect(audit.list()).toHaveLength(3);
    expect(audit.list({ action: "budget.set" })).toHaveLength(2);
    expect(audit.list({ actor: "bot" })).toHaveLength(1);

    const entry = audit.list({ action: "budget.set", actor: "operator" })[0]!;
    expect(entry.after).toEqual({ limitUsd: 5 });
    expect(entry.createdAt).toBeGreaterThan(0);
  });
});

describe("ApprovalBroker", () => {
  let db: GinDatabase;
  let bus: EventBus;
  let events: string[];
  let broker: ApprovalBroker;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    bus = new EventBus();
    events = [];
    bus.on("*", (e) => events.push(e.type));
    broker = new ApprovalBroker(db, { bus });
  });

  it("blocks until approved, then resolves", async () => {
    const pending = broker.request({
      action: "shell.exec",
      riskLevel: "high",
      params: { command: "rm -rf ./tmp" },
    });
    const [request] = broker.listPending();
    expect(request).toMatchObject({ action: "shell.exec", status: "pending" });
    expect(events).toContain("approval.requested");

    broker.decide(request!.id, "approved", "operator");
    await expect(pending).resolves.toBe("approved");
    expect(broker.get(request!.id)).toMatchObject({ status: "approved", decidedBy: "operator" });
    expect(events).toContain("approval.decided");
  });

  it("resolves denied decisions with the reason recorded", async () => {
    const pending = broker.request({ action: "http.fetch", riskLevel: "medium" });
    const id = broker.listPending()[0]!.id;
    broker.decide(id, "denied", "operator", "not on my watch");
    await expect(pending).resolves.toBe("denied");
    expect(broker.get(id)).toMatchObject({ status: "denied", reason: "not on my watch" });
  });

  it("expires undecided requests after the timeout (treated as denial)", async () => {
    const result = await broker.request({ action: "shell.exec", riskLevel: "high" }, 30);
    expect(result).toBe("expired");
    expect(broker.list()[0]!.status).toBe("expired");
    expect(events).toContain("approval.expired");
  });

  it("first decision wins; repeats are idempotent", async () => {
    const pending = broker.request({ action: "x", riskLevel: "high" });
    const id = broker.listPending()[0]!.id;
    broker.decide(id, "approved", "alice");
    const second = broker.decide(id, "denied", "bob");
    expect(second.status).toBe("approved");
    await expect(pending).resolves.toBe("approved");
  });

  it("pending requests survive a 'restart' and can still be decided", async () => {
    // Original broker (process 1) asks and dies before anyone answers.
    void broker.request({ action: "shell.exec", riskLevel: "critical" }, 60_000);
    expect(broker.listPending()).toHaveLength(1);

    // Process 2: a new broker over the same database still sees and decides it.
    const broker2 = new ApprovalBroker(db, { bus });
    const [survivor] = broker2.listPending();
    expect(survivor).toBeDefined();
    const decided = broker2.decide(survivor!.id, "denied", "operator", "stale after restart");
    expect(decided.status).toBe("denied");
  });
});
