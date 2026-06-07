import { useState } from "react";
import { useGateway, useRpc } from "../lib/useGateway.js";
import type { BudgetStatus } from "../lib/types.js";
import { Button, Empty, Gauge, Money, Section } from "../components.js";

export function Budgets() {
  const { client } = useGateway();
  const { data: budgets, refetch } = useRpc<BudgetStatus[]>("gin.budget.status", undefined, {
    intervalMs: 8000,
  });
  const [limit, setLimit] = useState("5");
  const [scope, setScope] = useState("agent");
  const [window_, setWindow] = useState("day");
  const [error, setError] = useState<string>();

  const save = async () => {
    setError(undefined);
    try {
      await client.call("gin.budget.set", {
        scope,
        limitUsd: Number(limit),
        window: window_,
        action: "block",
      });
      refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="boot space-y-4">
      <Section index="04" title="hard limits — enforced before each call">
        {!budgets?.length ? (
          <Empty>
            Unmetered. Set a limit below — a runaway loop should hit a wall, not your card.
          </Empty>
        ) : (
          <div className="space-y-4">
            {budgets.map((b) => {
              const fraction = b.limitUsd > 0 ? b.spentUsd / b.limitUsd : 0;
              return (
                <div key={b.id} className="font-mono text-xs">
                  <div className="mb-1 flex items-baseline justify-between">
                    <span className="text-fog">
                      {b.scope}
                      <span className="text-line-2">/</span>
                      {b.window}
                      <span className="ml-3 stencil">[{b.action}]</span>
                    </span>
                    <span>
                      <Money usd={b.spentUsd} /> <span className="text-line-2">of</span> $
                      {b.limitUsd.toFixed(2)}
                      <span className="ml-3 text-haze">{Math.round(fraction * 100)}%</span>
                    </span>
                  </div>
                  <Gauge fraction={fraction} />
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section index="05" title="set a budget">
        <form
          className="flex flex-wrap items-end gap-3 font-mono text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="block">
            <span className="stencil mb-1 block">scope</span>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="px-2 py-1.5"
            >
              <option value="agent">agent (default)</option>
              <option value="tenant">tenant</option>
            </select>
          </label>
          <label className="block">
            <span className="stencil mb-1 block">window</span>
            <select
              value={window_}
              onChange={(e) => setWindow(e.target.value)}
              className="px-2 py-1.5"
            >
              <option value="hour">hour</option>
              <option value="day">day</option>
              <option value="week">week</option>
              <option value="month">month</option>
            </select>
          </label>
          <label className="block">
            <span className="stencil mb-1 block">limit usd</span>
            <input
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              type="number"
              step="0.01"
              min="0"
              className="w-28 px-2 py-1.5"
            />
          </label>
          <Button tone="amber" type="submit">
            arm limit
          </Button>
          {error && <span className="text-err">{error}</span>}
        </form>
      </Section>
    </div>
  );
}
