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

## Reporting a vulnerability

Email **cyberuhurultd@gmail.com** with details and a proof of concept. Please do not open
public issues for unpatched vulnerabilities. You will get an acknowledgement within 72
hours. Coordinated disclosure appreciated; credit given unless you prefer otherwise.

## Scope notes for researchers

Prompt-injection resilience, sandbox escapes, budget-bypass paths, approval-gate bypasses,
and audit-log tampering are all in scope and especially valuable.
