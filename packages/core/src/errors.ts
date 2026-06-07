/**
 * Gin error taxonomy. Every error carries a stable machine-readable code so the
 * durable engine, verifier, and observability layers can classify failures
 * without string-matching messages.
 */

export type GinErrorCode =
  | "config_invalid"
  | "validation_failed"
  | "not_found"
  | "permission_denied"
  | "approval_required"
  | "budget_exceeded"
  | "provider_error"
  | "provider_rate_limited"
  | "rate_limited"
  | "tool_error"
  | "channel_error"
  | "delivery_failed"
  | "workflow_failed"
  | "checkpoint_corrupt"
  | "verification_failed"
  | "sandbox_violation"
  | "timeout"
  | "internal";

export interface GinErrorOptions {
  /** Whether the durable engine may retry the failed activity. */
  retryable?: boolean;
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class GinError extends Error {
  readonly code: GinErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(code: GinErrorCode, message: string, opts: GinErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "GinError";
    this.code = code;
    this.retryable = opts.retryable ?? defaultRetryable(code);
    this.details = opts.details ?? {};
  }

  toJSON(): {
    code: GinErrorCode;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
  } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

function defaultRetryable(code: GinErrorCode): boolean {
  switch (code) {
    case "provider_error":
    case "provider_rate_limited":
    case "rate_limited":
    case "channel_error":
    case "delivery_failed":
    case "timeout":
      return true;
    default:
      return false;
  }
}

export function isGinError(err: unknown): err is GinError {
  return err instanceof GinError;
}

/** Wrap any thrown value into a GinError without losing the original cause. */
export function toGinError(err: unknown, fallbackCode: GinErrorCode = "internal"): GinError {
  if (isGinError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new GinError(fallbackCode, message, { cause: err });
}
