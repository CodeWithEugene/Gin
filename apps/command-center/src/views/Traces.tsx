import { useState } from "react";
import { useGateway, useRpc } from "../lib/useGateway.js";
import type { TraceEvent, TraceSummary } from "../lib/types.js";
import { Empty, Money, Section, StatusLed, shortId, timeAgo } from "../components.js";

export function Traces() {
  const { client } = useGateway();
  const { data: traces } = useRpc<TraceSummary[]>(
    "gin.trace.list",
    { limit: 100 },
    {
      intervalMs: 8000,
    },
  );
  const [openId, setOpenId] = useState<string>();
  const [timeline, setTimeline] = useState<TraceEvent[]>();

  const toggle = async (traceId: string) => {
    if (openId === traceId) {
      setOpenId(undefined);
      return;
    }
    setOpenId(traceId);
    setTimeline(undefined);
    setTimeline(await client.call<TraceEvent[]>("gin.trace.get", { traceId }));
  };

  return (
    <div className="boot space-y-4">
      <Section
        index="03"
        title="traces — every thought, action, and dollar"
        right={<span className="stencil">{traces?.length ?? 0} recorded</span>}
      >
        {!traces?.length ? (
          <Empty>No traces yet. Every chat turn and workflow lands here.</Empty>
        ) : (
          <div className="font-mono text-xs">
            <div className="stencil grid grid-cols-[20px_110px_1fr_90px_90px_70px] gap-2 border-b border-line pb-2">
              <span />
              <span>trace</span>
              <span>status</span>
              <span className="text-right">calls</span>
              <span className="text-right">cost</span>
              <span className="text-right">when</span>
            </div>
            {traces.map((t) => (
              <div key={t.traceId} className="border-b border-line/50 last:border-0">
                <button
                  onClick={() => void toggle(t.traceId)}
                  className="grid w-full grid-cols-[20px_110px_1fr_90px_90px_70px] items-center gap-2 py-2 text-left hover:bg-ink-3/50"
                >
                  <StatusLed status={t.status} />
                  <span className="text-haze">{shortId(t.traceId)}</span>
                  <span
                    className={
                      t.status === "failed"
                        ? "text-err"
                        : t.status === "budget_terminated"
                          ? "text-amber"
                          : "text-fog"
                    }
                  >
                    {t.status}
                  </span>
                  <span className="text-right text-haze">
                    {t.modelCalls}m/{t.toolCalls}t
                  </span>
                  <span className="text-right">
                    <Money usd={t.costUsd} />
                  </span>
                  <span className="text-right text-haze">{timeAgo(t.endTs)}</span>
                </button>
                {openId === t.traceId && (
                  <div className="mb-2 border border-line bg-ink p-3">
                    {!timeline ? (
                      <span className="stencil cursor-blink">loading timeline</span>
                    ) : (
                      <Timeline events={timeline} />
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function Timeline({ events }: { events: TraceEvent[] }) {
  const start = events[0]?.ts ?? 0;
  return (
    <div className="space-y-1 font-mono text-[11px]">
      {events.map((event) => {
        const offset = ((event.ts - start) / 1000).toFixed(3);
        const color = event.type.startsWith("turn.")
          ? "var(--color-info)"
          : event.type.startsWith("model.")
            ? "var(--color-amber)"
            : event.type.startsWith("step.")
              ? "var(--color-ok)"
              : event.type.startsWith("budget.") || event.type.startsWith("verifier.")
                ? "var(--color-err)"
                : "var(--color-haze)";
        return (
          <div key={event.id} className="grid grid-cols-[70px_180px_1fr] gap-3">
            <span className="text-right text-line-2">+{offset}s</span>
            <span style={{ color }}>{event.type}</span>
            <span className="truncate text-haze">{summarize(event)}</span>
          </div>
        );
      })}
    </div>
  );
}

function summarize(event: TraceEvent): string {
  const p = event.payload;
  if (event.type === "model.called")
    return `${String(p.modelRef ?? "")} → ${String(p.stopReason ?? "")} ($${Number(p.costUsd ?? 0).toFixed(5)})`;
  if (event.type.startsWith("step.")) return String(p.tool ?? "");
  if (event.type === "turn.completed")
    return `${String(p.stepCount ?? "?")} steps, $${Number(p.costUsd ?? 0).toFixed(5)}`;
  if (event.type === "turn.failed") {
    const error = p.error as { code?: string } | undefined;
    return error?.code ?? "";
  }
  const text = JSON.stringify(p);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}
