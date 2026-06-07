import { useState } from "react";
import { GatewayProvider, useGateway, useRpc } from "./lib/useGateway.js";
import type { GatewayStatus } from "./lib/types.js";
import { Led } from "./components.js";
import { Overview } from "./views/Overview.js";
import { Chat } from "./views/Chat.js";
import { Traces } from "./views/Traces.js";
import { Budgets } from "./views/Budgets.js";
import { Approvals } from "./views/Approvals.js";
import { Schedule } from "./views/Schedule.js";

const VIEWS = [
  { key: "overview", label: "Overview", component: Overview },
  { key: "chat", label: "Chat", component: Chat },
  { key: "traces", label: "Traces", component: Traces },
  { key: "budgets", label: "Budgets", component: Budgets },
  { key: "approvals", label: "Approvals", component: Approvals },
  { key: "schedule", label: "Schedule", component: Schedule },
] as const;

type ViewKey = (typeof VIEWS)[number]["key"];

export default function App() {
  return (
    <GatewayProvider>
      <Shell />
    </GatewayProvider>
  );
}

function Shell() {
  const [view, setView] = useState<ViewKey>("overview");
  const Active = VIEWS.find((v) => v.key === view)!.component;

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-44 shrink-0 flex-col border-r border-line bg-ink-2/40">
          <div className="flex-1 py-3">
            {VIEWS.map((v, i) => (
              <button
                key={v.key}
                onClick={() => setView(v.key)}
                className={`block w-full px-4 py-2.5 text-left font-mono text-[11px] uppercase tracking-[0.18em] transition-colors ${
                  view === v.key
                    ? "border-r-2 border-amber bg-amber/5 text-amber"
                    : "text-haze hover:text-fog"
                }`}
              >
                <span className="mr-2 opacity-50">{String(i + 1).padStart(2, "0")}</span>
                {v.label}
              </button>
            ))}
          </div>
          <div className="border-t border-line px-4 py-3">
            <div className="stencil">glass-box</div>
            <div className="stencil mt-1">durable · audited</div>
          </div>
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto p-5">
          <Active />
        </main>
      </div>
    </div>
  );
}

function TopBar() {
  const { state } = useGateway();
  const { data: status } = useRpc<GatewayStatus>("gin.status", undefined, { intervalMs: 5000 });
  const connected = state === "open";

  return (
    <header className="flex items-center justify-between border-b border-line bg-ink-2/60 px-5 py-3">
      <div className="flex items-baseline gap-4">
        <h1
          className="text-lg font-bold tracking-tight text-fog"
          style={{ fontFamily: "var(--font-display)" }}
        >
          GIN<span className="text-amber">·</span>COMMAND CENTER
        </h1>
        <span className="stencil hidden sm:inline">
          the agent you can trust to run while you sleep
        </span>
      </div>
      <div className="flex items-center gap-5 font-mono text-[11px]">
        {status && (
          <>
            <span className="text-haze">
              v{status.version} · up {Math.floor(status.uptimeMs / 60000)}m
            </span>
            {status.defaultAgent && (
              <span className="text-haze">
                agent <span className="text-fog">{status.defaultAgent}</span>
              </span>
            )}
          </>
        )}
        <span className="flex items-center gap-2 uppercase tracking-[0.18em]">
          <Led color={connected ? "var(--color-ok)" : "var(--color-err)"} pulse={connected} />
          <span className={connected ? "text-ok" : "text-err"}>
            {connected ? "link" : "no link"}
          </span>
        </span>
      </div>
    </header>
  );
}
