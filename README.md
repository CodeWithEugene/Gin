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

🚧 Early development. Phase 0 (scaffold: gateway, CLI, core schemas, config) is in place.
See `docs/` and the build phases in the project spec.

## Quick start (dev)

```bash
pnpm install
pnpm build
pnpm test

# initialize ~/.gin
node apps/cli/dist/index.js onboard --model anthropic/claude-opus-4-8
node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js gateway          # ws://127.0.0.1:18789/ws
```

## Monorepo layout

| Path                  | What                                                |
| --------------------- | --------------------------------------------------- |
| `apps/gateway`        | The daemon: control plane, RPC/WS server, event bus |
| `apps/cli`            | The `gin` CLI (`onboard`, `doctor`, `gateway`, …)   |
| `apps/command-center` | React workspace UI + observability cockpit _(soon)_ |
| `packages/core`       | Domain types, Zod schemas, event bus, IDs, errors   |
| `packages/config`     | Config schema + loader (`~/.gin/gin.json`)          |
| `packages/durable`    | Durable execution engine _(Phase 2 — the spine)_    |

## Principles

Glass-box, not black-box · Safe by default · Durable by default · Local-first,
model-agnostic · One control plane.

## License

MIT
