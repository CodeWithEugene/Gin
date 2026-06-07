import { describe, expect, it } from "vitest";
import { Verifier, type StepEvidence } from "./verifier.js";

const verifier = new Verifier();

function toolStep(overrides: Partial<StepEvidence>): StepEvidence {
  return { id: "s1", type: "tool_call", status: "succeeded", ...overrides };
}

describe("zero-effect-claimed-done (the headline case)", () => {
  it("flags '0 rows affected' reported as done", () => {
    const result = verifier.verifyTurn({
      finalText: "Done! I deleted the old records.",
      steps: [
        toolStep({
          input: { tool: "shell.exec" },
          output: { exitCode: 0, stdout: "0 rows affected" },
        }),
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.rule)).toContain("zero-effect-claimed-done");
  });

  it("passes when the reply owns the zero effect", () => {
    const result = verifier.verifyTurn({
      finalText:
        "The delete matched no rows — nothing was changed. The records may already be gone.",
      steps: [
        toolStep({
          input: { tool: "shell.exec" },
          output: { exitCode: 0, stdout: "0 rows affected" },
        }),
      ],
    });
    expect(result.ok).toBe(true);
  });
});

describe("failed steps and exit codes", () => {
  it("flags a failed tool call that the reply never mentions", () => {
    const result = verifier.verifyTurn({
      finalText: "All set — the file is updated.",
      steps: [toolStep({ status: "failed", input: { tool: "fs.write" } })],
    });
    expect(result.ok).toBe(false);
    expect(result.findings[0]!.rule).toBe("failed-step-unacknowledged");
  });

  it("flags a silent non-zero exit code", () => {
    const result = verifier.verifyTurn({
      finalText: "Build complete.",
      steps: [
        toolStep({
          input: { tool: "shell.exec" },
          output: { exitCode: 2, stdout: "", stderr: "boom" },
        }),
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.findings[0]!.rule).toBe("nonzero-exit-unacknowledged");
  });

  it("passes when the failure is acknowledged", () => {
    const result = verifier.verifyTurn({
      finalText: "The build failed with exit code 2 — here's the error and how to fix it.",
      steps: [toolStep({ input: { tool: "shell.exec" }, output: { exitCode: 2 } })],
    });
    expect(result.ok).toBe(true);
  });
});

describe("http errors", () => {
  it("flags a 404 presented as success", () => {
    const result = verifier.verifyTurn({
      finalText: "I fetched the page and saved the summary.",
      steps: [
        toolStep({ input: { tool: "http.fetch" }, output: { status: 404, body: "Not Found" } }),
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.findings[0]!.rule).toBe("http-error-unacknowledged");
  });
});

describe("hallucinated action", () => {
  it("warns when the reply claims action but no tool ran", () => {
    const result = verifier.verifyTurn({
      finalText: "I've updated the config file for you.",
      steps: [{ id: "m1", type: "model_call", status: "succeeded" }],
    });
    expect(result.ok).toBe(true); // warning, not error
    expect(result.findings[0]!).toMatchObject({
      rule: "claimed-action-without-tools",
      severity: "warning",
    });
  });

  it("stays quiet when tools actually ran", () => {
    const result = verifier.verifyTurn({
      finalText: "I've updated the config file for you.",
      steps: [toolStep({ input: { tool: "fs.write" }, output: { path: "config", bytes: 10 } })],
    });
    expect(result.findings).toHaveLength(0);
  });
});

describe("clean turns", () => {
  it("passes an honest, successful turn with no findings", () => {
    const result = verifier.verifyTurn({
      finalText: "Here are the three files in your workspace.",
      steps: [toolStep({ input: { tool: "fs.list" }, output: { entries: [] } })],
    });
    expect(result).toEqual({ ok: true, findings: [] });
  });

  it("passes pure-text turns", () => {
    const result = verifier.verifyTurn({ finalText: "Paris is the capital of France.", steps: [] });
    expect(result.ok).toBe(true);
  });
});
