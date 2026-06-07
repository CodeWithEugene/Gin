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

🚧 Early development. Phase 0 (scaffold) and Phase 1 (parity core) are in place: a working
agent loop with Anthropic + Ollama models, 10 built-in tools, MCP client, FTS5+vector
memory, persistent sessions, and WebChat + Telegram channels behind a guaranteed-delivery
outbox. Phase 2 (durable execution + observability cockpit + hard budgets) is next.

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

| Path                  | What                                                         |
| --------------------- | ------------------------------------------------------------ |
| `apps/gateway`        | The daemon: control plane, RPC/WS server, runtime stack      |
| `apps/cli`            | The `gin` CLI (`onboard`, `doctor`, `gateway`, `message`, …) |
| `apps/command-center` | React workspace UI + observability cockpit _(soon)_          |
| `packages/core`       | Domain types, Zod schemas, event bus, IDs, errors            |
| `packages/config`     | Config schema + loader (`~/.gin/gin.json`)                   |
| `packages/storage`    | SQLite (WAL) handle + namespaced migrations                  |
| `packages/models`     | Provider adapters (Anthropic, Ollama), routing, cost meter   |
| `packages/tools`      | Tool registry (Zod-validated) + 10 built-in tools            |
| `packages/mcp`        | MCP client (stdio + HTTP) with per-server tool filtering     |
| `packages/memory`     | Persistent memory: FTS5 + vector hybrid search               |
| `packages/runtime`    | Agent loop + session/turn/step persistence                   |
| `packages/channels`   | Outbox (at-least-once, ordered) + WebChat/Telegram           |
| `packages/durable`    | Durable execution engine _(Phase 2 — the spine)_             |

## Principles

Glass-box, not black-box · Safe by default · Durable by default · Local-first,
model-agnostic · One control plane.

## License

MIT
