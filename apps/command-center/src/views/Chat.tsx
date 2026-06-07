import { useCallback, useEffect, useRef, useState } from "react";
import { useBusEvents, useGateway } from "../lib/useGateway.js";
import type { BusEvent } from "../lib/types.js";
import { Button } from "../components.js";

interface ChatLine {
  id: string;
  role: "you" | "gin" | "system";
  text: string;
  ts: number;
}

const PEER = "cockpit";

export function Chat() {
  const { client, state } = useGateway();
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  useBusEvents(
    "webchat.",
    useCallback((event: BusEvent) => {
      const payload = event.payload as {
        peerRef?: string;
        text?: string;
        message?: string;
        code?: string;
      };
      if (payload.peerRef !== PEER) return;
      if (event.type === "webchat.message" && payload.text) {
        setBusy(false);
        setLines((l) => [...l, { id: event.id, role: "gin", text: payload.text!, ts: event.ts }]);
      } else if (event.type === "webchat.error") {
        setBusy(false);
        setLines((l) => [
          ...l,
          {
            id: event.id,
            role: "system",
            text: `turn failed (${payload.code ?? "?"}): ${payload.message ?? ""}`,
            ts: event.ts,
          },
        ]);
      }
    }, []),
  );

  const send = async () => {
    const text = draft.trim();
    if (!text || state !== "open") return;
    setDraft("");
    setBusy(true);
    setLines((l) => [...l, { id: `local-${Date.now()}`, role: "you", text, ts: Date.now() }]);
    try {
      await client.call("gin.chat.send", { text, peerRef: PEER });
    } catch (err) {
      setBusy(false);
      setLines((l) => [
        ...l,
        {
          id: `err-${Date.now()}`,
          role: "system",
          text: err instanceof Error ? err.message : String(err),
          ts: Date.now(),
        },
      ]);
    }
  };

  return (
    <div className="boot mx-auto flex h-full max-w-3xl flex-col">
      <div className="stencil mb-3">
        <span className="text-amber">02</span>
        <span className="mx-2 text-line-2">/</span>direct line · peer “{PEER}”
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto border border-line bg-ink-2/40 p-5"
      >
        {lines.length === 0 && (
          <div className="py-16 text-center text-haze">
            <div className="text-3xl" style={{ fontFamily: "var(--font-display)" }}>
              Talk to your agent.
            </div>
            <div className="mt-2 font-mono text-xs">
              every turn lands in Traces · every dollar in Budgets
            </div>
          </div>
        )}
        {lines.map((line) => (
          <div key={line.id} className="font-mono text-xs">
            <div className="stencil mb-1">
              <span
                style={{
                  color:
                    line.role === "you"
                      ? "var(--color-info)"
                      : line.role === "gin"
                        ? "var(--color-amber)"
                        : "var(--color-err)",
                }}
              >
                {line.role}
              </span>
              <span className="ml-3 text-line-2">
                {new Date(line.ts).toLocaleTimeString("en-GB")}
              </span>
            </div>
            <div className="whitespace-pre-wrap leading-relaxed text-fog">{line.text}</div>
          </div>
        ))}
        {busy && <div className="stencil cursor-blink text-amber">gin is working</div>}
      </div>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={state === "open" ? "transmit…" : "no link"}
          disabled={state !== "open"}
          className="flex-1 px-3 py-2 text-xs"
        />
        <Button tone="amber" type="submit" disabled={state !== "open" || !draft.trim()}>
          send
        </Button>
      </form>
    </div>
  );
}
