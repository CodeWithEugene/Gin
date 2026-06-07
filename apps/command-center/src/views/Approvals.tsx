import { useCallback } from "react";
import { useBusEvents, useGateway, useRpc } from "../lib/useGateway.js";
import type { ApprovalRecord } from "../lib/types.js";
import { Button, Empty, Section, StatusLed, timeAgo } from "../components.js";

export function Approvals() {
  const { client } = useGateway();
  const { data: pending, refetch: refetchPending } = useRpc<ApprovalRecord[]>(
    "gin.approval.list",
    {},
    { intervalMs: 6000 },
  );
  const { data: history, refetch: refetchHistory } = useRpc<ApprovalRecord[]>(
    "gin.approval.list",
    { all: true },
    { intervalMs: 15_000 },
  );

  // The moment an agent asks, the queue updates — no polling lag.
  useBusEvents(
    "approval.",
    useCallback(() => {
      refetchPending();
      refetchHistory();
    }, [refetchPending, refetchHistory]),
  );

  const decide = async (approvalId: string, decision: "approved" | "denied") => {
    await client.call("gin.approval.decide", { approvalId, decision });
    refetchPending();
    refetchHistory();
  };

  const decided = (history ?? []).filter((a) => a.status !== "pending").slice(0, 20);

  return (
    <div className="boot space-y-4">
      <Section
        index="05"
        title="awaiting your decision"
        right={
          pending?.length ? (
            <span className="stencil text-amber">{pending.length} blocked</span>
          ) : undefined
        }
      >
        {!pending?.length ? (
          <Empty>Nothing waiting. High-risk tool calls pause here before they run.</Empty>
        ) : (
          <div className="space-y-3">
            {pending.map((a) => (
              <div key={a.id} className="border border-amber/30 bg-amber/5 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="font-mono text-xs">
                    <div className="mb-1">
                      <span className="text-amber">{a.action}</span>
                      <span className="ml-3 stencil">risk:{a.riskLevel}</span>
                      <span className="ml-3 stencil">{timeAgo(a.requestedAt)} ago</span>
                    </div>
                    <pre className="max-w-2xl overflow-x-auto whitespace-pre-wrap text-haze">
                      {JSON.stringify(a.params, null, 1)}
                    </pre>
                  </div>
                  <div className="flex gap-2">
                    <Button tone="ok" onClick={() => void decide(a.id, "approved")}>
                      approve
                    </Button>
                    <Button tone="danger" onClick={() => void decide(a.id, "denied")}>
                      deny
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section index="06" title="decision log">
        {!decided.length ? (
          <Empty>No decisions yet.</Empty>
        ) : (
          <table className="w-full font-mono text-xs">
            <tbody>
              {decided.map((a) => (
                <tr key={a.id} className="border-b border-line/50 last:border-0">
                  <td className="py-2 pr-3">
                    <StatusLed status={a.status} />
                  </td>
                  <td className="py-2 pr-4 text-fog">{a.action}</td>
                  <td className="py-2 pr-4 text-haze">{a.status}</td>
                  <td className="py-2 pr-4 text-haze">{a.decidedBy ?? "—"}</td>
                  <td className="py-2 text-right text-haze">{timeAgo(a.requestedAt)} ago</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
