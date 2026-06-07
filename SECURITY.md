# Security Policy

## Model

Gin's security posture is **secure-by-default, local-first**:

- The Gateway binds `127.0.0.1` by default; remote access is an explicit opt-in with a
  documented exposure runbook.
- All inbound channel messages are treated as **untrusted input**. Unknown DM senders are
  held behind pairing codes; public DMs require explicit `dmPolicy: "open"` plus a `"*"`
  allowlist — and `gin doctor` flags that configuration loudly.
- Non-`main` sessions execute tools in a sandbox (Docker by default).
- Secrets live in the OS keychain or an encrypted secrets file — never plaintext config.
  Config files may only carry secret _references_ (`keychain:<name>`).
- No telemetry. Nothing leaves the machine unless the user configures it to.
- High-risk actions (file deletion, payments, external sends) pass approval gates and are
  written to a tamper-evident audit log.

## Implemented guards (current)

- **Connection auth**: every WS connection resolves a principal — API keys
  (`gin keys create`, sha256-at-rest, shown once, constant-time verify, instant revoke)
  carry roles + tenant; loopback without a key is the local operator; anything else is
  refused (close 1008). RBAC scopes are enforced per RPC method.
- **SSRF guard**: `http.fetch` refuses loopback, RFC1918, link-local (incl. cloud
  metadata 169.254.169.254 / metadata.google.internal), unique-local IPv6, and
  `.local`/`.internal` hosts. `GIN_ALLOW_PRIVATE_HTTP=1` opts out for homelab use.
  Hostname-literal checks do not stop DNS rebinding — treat that as in scope below.
- **Flood control**: per-connection token-bucket rate limiting on the WS RPC
  (`rate_limited` errors, connection survives), 512KB frame cap, 32K chat text cap.
- **Workspace jail**: `fs.*` paths resolve inside the agent workspace; escapes are
  `sandbox_violation`. `shell.exec` runs in Docker (`--network=none`, ephemeral) for
  agents with `sandboxMode: "docker"` (the default).
- **Outbound mail**: `email.send` is high-risk (approval-gate eligible) and honors an
  exact/domain allowlist enforced below the model.
- **Dependencies**: `pnpm audit` is clean as of the last hardening pass.

## Reporting a vulnerability

Email **cyberuhurultd@gmail.com** with details and a proof of concept. Please do not open
public issues for unpatched vulnerabilities. You will get an acknowledgement within 72
hours. Coordinated disclosure appreciated; credit given unless you prefer otherwise.

## Scope notes for researchers

Prompt-injection resilience, sandbox escapes, budget-bypass paths, approval-gate bypasses,
and audit-log tampering are all in scope and especially valuable.
