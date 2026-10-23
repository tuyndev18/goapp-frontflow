import { NON_RETRYABLE_ERRORS } from "@frontflow/domain";

/** Throw from a node handler to fail the attempt with a specific error code. */
export class NodeError extends Error {
  readonly code: string;
  readonly retryable: boolean | undefined;

  constructor(code: string, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "NodeError";
    this.code = code;
    this.retryable = options.retryable;
  }
}

/** Raised for invalid workflow definitions (YAML shape, unknown deps, cycles, duplicates). */
export class WorkflowDefinitionError extends Error {
  readonly issues: string[];

  constructor(source: string, issues: string[]) {
    super(`Invalid workflow definition (${source}):\n  - ${issues.join("\n  - ")}`);
    this.name = "WorkflowDefinitionError";
    this.issues = issues;
  }
}

/** Raised for illegal engine operations (unknown run, wrong node state, ...). */
export class WorkflowEngineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkflowEngineError";
    this.code = code;
  }
}

export const ERROR_CODES = {
  NODE_TIMEOUT: "NODE_TIMEOUT",
  RUN_TIMEOUT: "RUN_TIMEOUT",
  RETRY_BUDGET_EXHAUSTED: "RETRY_BUDGET_EXHAUSTED",
  HANDLER_NOT_FOUND: "HANDLER_NOT_FOUND",
  HANDLER_ERROR: "HANDLER_ERROR",
  INVALID_RESULT: "INVALID_RESULT",
} as const;

const NON_RETRYABLE: ReadonlySet<string> = new Set(NON_RETRYABLE_ERRORS);

export function isNeverRetryable(code: string): boolean {
  return NON_RETRYABLE.has(code);
}

export function toNodeFailure(error: unknown): { code: string; message: string; retryable?: boolean } {
  if (error instanceof NodeError) {
    return error.retryable === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof Error) return { code: ERROR_CODES.HANDLER_ERROR, message: error.message };
  return { code: ERROR_CODES.HANDLER_ERROR, message: String(error) };
}
