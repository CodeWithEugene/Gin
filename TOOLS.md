# TOOLS.md — workspace tool notes injected into the agent prompt

Notes the agent should know about tools in this workspace. Keep entries short and
imperative; this file is prepended to the tool catalog at prompt-build time.

## Conventions

- Validate before acting: tool arguments are schema-checked, but _semantic_ sanity is on
  you (e.g. don't `file.write` to a path outside the workspace without reason).
- Prefer `memory.search` before asking the user something they may have told you before.
- `bash` in non-main sessions runs sandboxed (Docker by default) with no network unless
  policy-approved. Design commands accordingly.
- Outbound messages go through the delivery outbox; send once and trust it — never resend
  because a confirmation seems slow.

## Per-tool notes

(Empty at scaffold time. `gin onboard` and skill installs append entries here.)
