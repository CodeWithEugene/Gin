/**
 * The anti-silent-failure verifier (spec Phase 3). After a turn produces its
 * final text, the verifier cross-checks that text against the recorded step
 * evidence. The contract: an action that visibly failed or had no effect
 * must never be reported to the user as success — "0 rows affected" is never
 * "done". Rules are deliberately simple, explainable, and pluggable; the
 * model-graded confidence scorer layers on top in a later phase.
 */

export interface StepEvidence {
  id: string;
  type: "tool_call" | "model_call" | string;
  status: "succeeded" | "failed" | string;
  input?: unknown;
  output?: unknown;
}

export interface TurnEvidence {
  finalText: string;
  steps: StepEvidence[];
}

export type FindingSeverity = "warning" | "error";

export interface Finding {
  rule: string;
  severity: FindingSeverity;
  message: string;
  stepId?: string;
}

export interface VerifyResult {
  ok: boolean;
  findings: Finding[];
}

export interface VerifierRule {
  name: string;
  check(evidence: TurnEvidence): Finding[];
}

/** Words that signal the reply acknowledges a problem. */
const ACKNOWLEDGES_FAILURE =
  /\b(fail(ed|ure)?|error|unable|couldn'?t|could not|didn'?t|did not|wasn'?t able|problem|denied|reject(ed)?|missing|not found|no effect|nothing (was )?(changed|updated|deleted)|zero rows)\b/i;

/** Words that signal the reply claims successful completion. */
const CLAIMS_SUCCESS =
  /\b(done|success(ful(ly)?)?|complet(e|ed)|updated|deleted|created|saved|fixed|installed|deployed|sent|wrote|written|all set|finished)\b/i;

function acknowledges(text: string): boolean {
  return ACKNOWLEDGES_FAILURE.test(text);
}

function claimsSuccess(text: string): boolean {
  return CLAIMS_SUCCESS.test(text);
}

function toolName(step: StepEvidence): string {
  const input = step.input as { tool?: string } | undefined;
  return input?.tool ?? "unknown-tool";
}

/** A tool call failed outright, and the reply doesn't own up to it. */
export const failedStepUnacknowledged: VerifierRule = {
  name: "failed-step-unacknowledged",
  check(evidence) {
    if (acknowledges(evidence.finalText)) return [];
    return evidence.steps
      .filter((s) => s.type === "tool_call" && s.status === "failed")
      .map((s) => ({
        rule: this.name,
        severity: "error" as const,
        stepId: s.id,
        message: `Tool ${toolName(s)} failed, but the reply does not mention any failure.`,
      }));
  },
};

/** shell.exec returned a non-zero exit code; reply silently moves on. */
export const nonzeroExitUnacknowledged: VerifierRule = {
  name: "nonzero-exit-unacknowledged",
  check(evidence) {
    if (acknowledges(evidence.finalText)) return [];
    return evidence.steps
      .filter((s) => {
        if (s.type !== "tool_call" || s.status !== "succeeded") return false;
        const output = s.output as { exitCode?: number } | undefined;
        return typeof output?.exitCode === "number" && output.exitCode !== 0;
      })
      .map((s) => ({
        rule: this.name,
        severity: "error" as const,
        stepId: s.id,
        message: `${toolName(s)} exited with code ${(s.output as { exitCode: number }).exitCode}, but the reply does not acknowledge it.`,
      }));
  },
};

/** http.fetch came back 4xx/5xx; reply pretends it worked. */
export const httpErrorUnacknowledged: VerifierRule = {
  name: "http-error-unacknowledged",
  check(evidence) {
    if (acknowledges(evidence.finalText)) return [];
    return evidence.steps
      .filter((s) => {
        if (s.type !== "tool_call" || s.status !== "succeeded") return false;
        const output = s.output as { status?: number } | undefined;
        return typeof output?.status === "number" && output.status >= 400;
      })
      .map((s) => ({
        rule: this.name,
        severity: "error" as const,
        stepId: s.id,
        message: `${toolName(s)} got HTTP ${(s.output as { status: number }).status}, but the reply does not acknowledge it.`,
      }));
  },
};

/** The canonical case: output says nothing changed, reply says "done". */
export const zeroEffectClaimedDone: VerifierRule = {
  name: "zero-effect-claimed-done",
  check(evidence) {
    if (!claimsSuccess(evidence.finalText) || acknowledges(evidence.finalText)) return [];
    const ZERO_EFFECT =
      /\b(0 rows?( affected)?|no rows? affected|0 files? changed|nothing to (do|commit|update)|no changes? (made|applied))\b/i;
    return evidence.steps
      .filter((s) => {
        if (s.type !== "tool_call") return false;
        const text = typeof s.output === "string" ? s.output : JSON.stringify(s.output ?? "");
        return ZERO_EFFECT.test(text);
      })
      .map((s) => ({
        rule: this.name,
        severity: "error" as const,
        stepId: s.id,
        message: `${toolName(s)} reported zero effect ("0 rows affected"-class output), but the reply claims success.`,
      }));
  },
};

/** The reply claims success but no tool ever ran — pure hallucinated action. */
export const claimedActionWithoutTools: VerifierRule = {
  name: "claimed-action-without-tools",
  check(evidence) {
    const ACTION_CLAIM =
      /\bi(?:'ve| have)? (?:just )?(updated|deleted|created|saved|wrote|installed|deployed|sent|ran|executed|fixed)\b/i;
    if (!ACTION_CLAIM.test(evidence.finalText)) return [];
    const toolSteps = evidence.steps.filter((s) => s.type === "tool_call");
    if (toolSteps.length > 0) return [];
    return [
      {
        rule: this.name,
        severity: "warning" as const,
        message: "The reply claims an action was performed, but no tool call happened this turn.",
      },
    ];
  },
};

export const DEFAULT_RULES: VerifierRule[] = [
  failedStepUnacknowledged,
  nonzeroExitUnacknowledged,
  httpErrorUnacknowledged,
  zeroEffectClaimedDone,
  claimedActionWithoutTools,
];

export class Verifier {
  constructor(private readonly rules: VerifierRule[] = DEFAULT_RULES) {}

  verifyTurn(evidence: TurnEvidence): VerifyResult {
    const findings = this.rules.flatMap((rule) => rule.check(evidence));
    return { ok: !findings.some((f) => f.severity === "error"), findings };
  }
}
