# Gin

**The self-hosted AI agent you can trust to run while you sleep.**

Gin is an open-source, local-first autonomous agent platform. It answers on the messaging
channels you already use, runs 24/7, remembers across sessions, and uses tools — and,
uniquely, it **recovers from failure, proves what it did, and stops before it spends money
it shouldn't**:

- **Durable execution** — every workflow is checkpointed; a crash resumes, never restarts.
- **Glass-box observability** — step-level tracing of every thought → action → result.
- **Hard cost control** — dollar budgets enforced _before_ each call, not after the bill.
- **Governance** — scopes, approval gates, audit logs, transaction controls.
- **Anti-silent-failure verifier** — "0 rows affected" is never reported as "done".
- **Guaranteed delivery** — outbound messages survive restarts; exactly-once to your chat.

## Status

🚧 Early development. Phases 0–3 are in place: a working agent loop with Anthropic +
Ollama models, 10 built-in tools, MCP client, FTS5+vector memory, persistent sessions,
WebChat + Telegram channels behind a guaranteed-delivery outbox; the wedge — an
event-sourced **durable execution engine** (kill it at step 6, it resumes at step 7),
**step-level tracing** of every model and tool call (`gin trace`), and **hard dollar
budgets** enforced _before_ each model call (`gin budget`), with automatic session
compaction; and the governance plane — **RBAC scopes**, **durable approval gates** for
high-risk tools (`gin approvals`), an **append-only audit log** (`gin audit`), tool
output contracts, and the **anti-silent-failure verifier** ("0 rows affected" is never
reported as "done"). Phase 4's first slice is in too: **Docker sandboxing** for tool
execution (per-agent `sandboxMode`), **self-improving skills** (SKILL.md with
progressive disclosure — `gin skills`), a **declarative workflow DSL** compiled onto the
durable engine (`gin workflow`, specs in `~/.gin/workflows/*.json`), a **cron scheduler**
driving turns and workflows (`gin schedule`), **Slack** (Socket Mode) and **Discord**
(gateway WS) channels alongside WebChat and Telegram, **web search + a bundled
deep-research skill** (cited multi-source answers), **email tools** (IMAP/SMTP —
`email.send` is approval-gate eligible) — and the **Command Center**: a glass-cockpit
web UI (chat, live trace timelines, budget gauges, approval queue, schedule) served by
the gateway at `http://127.0.0.1:18789/`. Phase 5 has begun: **API-key auth**
(`gin keys create` — hashed at rest, shown once, role- and tenant-bound; connect with
`?token=`) and **multi-tenancy basics** (tenant-scoped principals see only their own
agents and sessions).

## Quick start (dev)

```bash
pnpm install
pnpm build
pnpm test

# initialize ~/.gin
node apps/cli/dist/index.js onboard --model anthropic/claude-opus-4-8
node apps/cli/dist/index.js doctor

# run the daemon (reads ANTHROPIC_API_KEY; Ollama at 127.0.0.1:11434 also works)
node apps/gateway/dist/index.js              # ws://127.0.0.1:18789/ws

# talk to your agent from another terminal
node apps/cli/dist/index.js message send "hello, what tools do you have?"
node apps/cli/dist/index.js agent list
```

To enable Telegram, set the bot token in your environment and `~/.gin/gin.json`:

```json
{ "channels": { "telegram": { "enabled": true, "tokenRef": "env:TELEGRAM_BOT_TOKEN" } } }
```

## Monorepo layout

| Path                     | What                                                             |
| ------------------------ | ---------------------------------------------------------------- |
| `apps/gateway`           | The daemon: control plane, RPC/WS server, runtime stack          |
| `apps/cli`               | The `gin` CLI (`onboard`, `doctor`, `gateway`, `message`, …)     |
| `apps/command-center`    | The cockpit UI: chat, traces, budgets, approvals, schedule       |
| `packages/core`          | Domain types, Zod schemas, event bus, IDs, errors                |
| `packages/config`        | Config schema + loader (`~/.gin/gin.json`)                       |
| `packages/storage`       | SQLite (WAL) handle + namespaced migrations                      |
| `packages/models`        | Provider adapters (Anthropic, Ollama), routing, cost meter       |
| `packages/tools`         | Tool registry (Zod-validated) + 10 built-in tools                |
| `packages/mcp`           | MCP client (stdio + HTTP) with per-server tool filtering         |
| `packages/memory`        | Persistent memory: FTS5 + vector hybrid search                   |
| `packages/runtime`       | Agent loop + session/turn/step persistence                       |
| `packages/channels`      | Outbox (at-least-once, ordered) + WebChat/Telegram/Slack/Discord |
| `packages/email`         | IMAP/SMTP tools behind ports; outbound allowlist                 |
| `packages/durable`       | Event-sourced durable workflows: checkpoint/resume/compensate    |
| `packages/cost`          | Budget engine: limits enforced before each call + ledger         |
| `packages/observability` | Trace store: step-level glass-box timelines from the bus         |
| `packages/governance`    | RBAC scopes, append-only audit log, durable approval gates       |
| `packages/verifier`      | Anti-silent-failure turn verification, pluggable rules           |
| `packages/sandbox`       | Execution backends: host + Docker (ephemeral, no network)        |
| `packages/skills`        | SKILL.md store: progressive disclosure + skills.save             |
| `packages/workflows`     | Declarative DSL (tool/model/approval steps) on durable           |
| `packages/scheduler`     | Cron jobs → agent turns or workflows, with heartbeats            |

## Principles

Glass-box, not black-box · Safe by default · Durable by default · Local-first,
model-agnostic · One control plane.

## License

MIT
