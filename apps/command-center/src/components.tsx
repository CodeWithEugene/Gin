import type { ReactNode } from "react";

/** Shared cockpit primitives: stencil headers, LEDs, gauges, panels. */

export function Section({
  index,
  title,
  children,
  right,
}: {
  index: string;
  title: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <section className="border border-line bg-ink-2/60">
      <header className="flex items-center justify-between border-b border-line px-4 py-2">
        <div className="stencil">
          <span className="text-amber">{index}</span>
          <span className="mx-2 text-line-2">/</span>
          {title}
        </div>
        {right}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Led({ color, pulse = false }: { color: string; pulse?: boolean }) {
  return (
    <span
      className={`led ${pulse ? "led-pulse" : ""}`}
      style={{ color, background: "currentColor" }}
    />
  );
}

export function StatusLed({ status }: { status: string }) {
  const color =
    status === "succeeded" || status === "active" || status === "approved"
      ? "var(--color-ok)"
      : status === "failed" || status === "denied" || status === "dead_letter"
        ? "var(--color-err)"
        : status === "budget_terminated" || status === "pending" || status === "expired"
          ? "var(--color-amber)"
          : "var(--color-info)";
  return <Led color={color} pulse={status === "running" || status === "pending"} />;
}

/** Horizontal bar instrument with tick marks — the budget gauge. */
export function Gauge({ fraction, danger }: { fraction: number; danger?: boolean }) {
  const clamped = Math.min(1, Math.max(0, fraction));
  const cells = 24;
  const lit = Math.round(clamped * cells);
  return (
    <span className="font-mono text-[11px] tracking-tight">
      {Array.from({ length: cells }, (_, i) => (
        <span
          key={i}
          style={{
            color:
              i < lit
                ? danger || clamped > 0.85
                  ? "var(--color-err)"
                  : clamped > 0.6
                    ? "var(--color-amber)"
                    : "var(--color-ok)"
                : "var(--color-line-2)",
          }}
        >
          {i < lit ? "▰" : "▱"}
        </span>
      ))}
    </span>
  );
}

export function Money({ usd, digits = 4 }: { usd: number; digits?: number }) {
  return <span className="text-amber-2">${usd.toFixed(digits)}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-8 text-center text-haze">{children}</div>;
}

export function Button({
  children,
  onClick,
  tone = "default",
  disabled,
  type,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: "default" | "ok" | "danger" | "amber";
  disabled?: boolean;
  type?: "submit" | "button";
}) {
  const tones: Record<string, string> = {
    default: "border-line-2 text-fog hover:border-amber hover:text-amber",
    ok: "border-ok/40 text-ok hover:bg-ok/10",
    danger: "border-err/40 text-err hover:bg-err/10",
    amber: "border-amber/50 text-amber hover:bg-amber/10",
  };
  return (
    <button
      type={type ?? "button"}
      onClick={onClick}
      disabled={disabled}
      className={`border px-3 py-1 font-mono text-[11px] uppercase tracking-[0.15em] transition-colors disabled:opacity-40 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}
