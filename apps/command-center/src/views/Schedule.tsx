import { useState } from "react";
import { useGateway, useRpc } from "../lib/useGateway.js";
import type { ScheduleJob } from "../lib/types.js";
import { Button, Empty, Section, timeAgo } from "../components.js";

export function Schedule() {
  const { client } = useGateway();
  const { data: jobs, refetch } = useRpc<ScheduleJob[]>("gin.schedule.list", undefined, {
    intervalMs: 10_000,
  });
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 7 * * *");
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();

  const add = async () => {
    setError(undefined);
    try {
      await client.call("gin.schedule.set", {
        name,
        cron,
        action: { kind: "message", text },
      });
      setName("");
      setText("");
      refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (jobName: string) => {
    await client.call("gin.schedule.delete", { name: jobName });
    refetch();
  };

  return (
    <div className="boot space-y-4">
      <Section index="06" title="standing orders">
        {!jobs?.length ? (
          <Empty>No scheduled jobs. Give the agent a routine below.</Empty>
        ) : (
          <table className="w-full font-mono text-xs">
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id} className="border-b border-line/50 last:border-0">
                  <td className="py-2 pr-4 text-fog">{job.name}</td>
                  <td className="py-2 pr-4 text-amber">{job.cron}</td>
                  <td className="max-w-64 truncate py-2 pr-4 text-haze">
                    {job.action.kind === "message"
                      ? job.action.text
                      : `workflow:${job.action.workflow}`}
                  </td>
                  <td className="py-2 pr-4 text-haze">
                    {job.nextRunAt
                      ? `next ${new Date(job.nextRunAt).toLocaleString("en-GB")}`
                      : "—"}
                  </td>
                  <td className="py-2 pr-4 text-haze">
                    {job.lastRunAt
                      ? `ran ${timeAgo(job.lastRunAt)} ago · ${job.lastStatus ?? ""}`
                      : "never ran"}
                  </td>
                  <td className="py-2 text-right">
                    <Button tone="danger" onClick={() => void remove(job.name)}>
                      drop
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section index="07" title="new standing order">
        <form
          className="flex flex-wrap items-end gap-3 font-mono text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label className="block">
            <span className="stencil mb-1 block">name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="morning-brief"
              className="w-40 px-2 py-1.5"
            />
          </label>
          <label className="block">
            <span className="stencil mb-1 block">cron</span>
            <input
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              className="w-32 px-2 py-1.5"
            />
          </label>
          <label className="block flex-1">
            <span className="stencil mb-1 block">message to the agent</span>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Summarize my inbox and flag anything urgent"
              className="w-full min-w-64 px-2 py-1.5"
            />
          </label>
          <Button tone="amber" type="submit" disabled={!name || !cron || !text}>
            schedule
          </Button>
          {error && <span className="text-err">{error}</span>}
        </form>
      </Section>
    </div>
  );
}
