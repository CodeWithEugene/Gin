import { useCallback, useState } from "react";
import { useBusEvents, useRpc } from "../lib/useGateway.js";
import type { AgentInfo, BudgetStatus, BusEvent, SessionInfo, TraceSummary } from "../lib/types.js";
import { Empty, Money, Section, StatusLed, timeAgo } from "../components.js";

const FEED_LIMIT = 60;

/** Event types worth a row in the operator's peripheral vision. */
const FEED_COLORS: [string, string][] = [
  ["turn.", "var(--color-info)"],
  ["step.", "var(--color-haze)"],
  ["model.", "var(--color-fog)"],
  ["budget.", "var(--color-amber)"],
  ["approval.", "var(--color-amber)"],
  ["message.", "var(--color-ok)"],
  ["channel.", "var(--color-info)"],
  ["workflow.", "var(--color-info)"],
  ["scheduler.job", "var(--color-info)"],
  ["session.", "var(--color-haze)"],
  ["verifier.", "var(--color-err)"],
];

export function Overview() {
  const { data: agents } = useRpc<AgentInfo[]>("gin.agent.list");
  const { data: sessions } = useRpc<SessionInfo[]>("gin.session.list", undefined, {
    intervalMs: 10_000,
  });
  const { data: traces } = useRpc<TraceSummary[]>(
    "gin.trace.list",
    { limit: 200 },
    {
      intervalMs: 10_000,
    },
  );
  const { data: budgets } = useRpc<BudgetStatus[]>("gin.budget.status", undefined, {
    intervalMs: 10_000,
  });

  const [feed, setFeed] = useState<BusEvent[]>([]);
  useBusEvents(
    "*",
    useCallback((event: BusEvent) => {
      if (!FEED_COLORS.some(([prefix]) => event.type.startsWith(prefix))) return;
      setFeed((rows) => [event, ...rows].slice(0, FEED_LIMIT));
    }, []),
  );

  const totalCost = (traces ?? []).reduce((acc, t) => acc + t.costUsd, 0);
  const failed = (traces ?? []).filter((t) => t.status === "failed").length;
  const terminated = (traces ?? []).filter((t) => t.status === "budget_terminated").length;

  return (
    <div className="boot grid grid-cols-1 gap-4 xl:grid-cols-3">
      <div className="space-y-4 xl:col-span-2">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Vital label="turns traced" value={String(traces?.length ?? "—")} />
          <Vital label="recorded spend" value={`$${totalCost.toFixed(4)}`} amber />
          <Vital label="failed" value={String(failed)} bad={failed > 0} />
          <Vital label="budget stops" value={String(terminated)} amber={terminated > 0} />
        </div>

        <Section index="01" title="agents">
          {!agents?.length ? (
            <Empty>No agents yet.</Empty>
          ) : (
            <table className="w-full font-mono text-xs">
              <tbody>
                {agents.map((a) => (
                  <tr key={a.id} className="border-b border-line/60 last:border-0">
                    <td className="py-2 pr-4 text-fog">{a.name}</td>
                    <td className="py-2 pr-4 text-haze">{a.modelConfig.primary}</td>
                    <td className="py-2 pr-4 text-haze">sandbox:{a.sandboxMode}</td>
                    <td className="py-2 text-right text-line-2">{a.id.slice(-8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section index="02" title="sessions">
          {!sessions?.length ? (
            <Empty>No sessions yet — say something in Chat.</Empty>
          ) : (
            <table className="w-full font-mono text-xs">
              <tbody>
                {sessions.slice(0, 8).map((s) => (
                  <tr key={s.id} className="border-b border-line/60 last:border-0">
                    <td className="py-2 pr-3">
                      <StatusLed status={s.status} />
                    </td>
                    <td className="py-2 pr-4 text-fog">
                      {s.channelId ?? "—"}/{s.peerRef || "local"}
                    </td>
                    <td className="py-2 pr-4 text-haze">{s.status}</td>
                    <td className="py-2 text-right text-haze">{timeAgo(s.lastActiveAt)} ago</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section index="03" title="budget headroom">
          {!budgets?.length ? (
            <Empty>No budgets configured — the agent is unmetered.</Empty>
          ) : (
            <div className="space-y-2">
              {budgets.slice(0, 4).map((b) => (
                <div
                  key={b.id}
                  className="flex items-center justify-between gap-4 font-mono text-xs"
                >
                  <span className="text-haze">
                    {b.scope}/{b.window}
                  </span>
                  <span className="text-fog">
                    <Money usd={b.spentUsd} /> / ${b.limitUsd.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      <Section
        index="04"
        title="live bus"
        right={<span className="stencil cursor-blink">streaming</span>}
      >
        <div className="max-h-[70vh] space-y-0 overflow-y-auto font-mono text-[11px]">
          {feed.length === 0 ? (
            <Empty>Waiting for events…</Empty>
          ) : (
            feed.map((event) => (
              <div key={event.id} className="feed-row flex gap-3 border-b border-line/40 py-1.5">
                <span className="shrink-0 text-line-2">
                  {new Date(event.ts).toLocaleTimeString("en-GB")}
                </span>
                <span
                  className="truncate"
                  style={{
                    color:
                      FEED_COLORS.find(([p]) => event.type.startsWith(p))?.[1] ??
                      "var(--color-haze)",
                  }}
                >
                  {event.type}
                </span>
              </div>
            ))
          )}
        </div>
      </Section>
    </div>
  );
}

function Vital({
  label,
  value,
  amber,
  bad,
}: {
  label: string;
  value: string;
  amber?: boolean;
  bad?: boolean;
}) {
  return (
    <div className="border border-line bg-ink-2/60 px-4 py-3">
      <div className="stencil">{label}</div>
      <div
        className={`mt-1 text-xl font-semibold ${bad ? "text-err" : amber ? "text-amber" : "text-fog"}`}
        style={{ fontFamily: "var(--font-display)" }}
      >
        {value}
      </div>
    </div>
  );
}
