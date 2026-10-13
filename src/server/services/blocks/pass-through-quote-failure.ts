import { TRPCError } from '@trpc/server';
import { isLikelySafeMessage } from '~/server/services/orchestrator/provider-errors';
import {
  getOrchestratorSubmitFailure,
  isOrchestratorMissingBlob,
} from '~/server/services/orchestrator/submit-failure';

/**
 * Why a pass-through step has no price quote.
 *
 * - `rejected`    — the orchestrator answered the request with a 4xx that refuses the
 *                   request itself; retrying the same body will not help. `reason` is
 *                   the orchestrator's message only when it is safe to show, or a fixed
 *                   host-written sentence (a training image that no longer exists).
 * - `unavailable` — no usable answer: a network failure, a timeout, a 5xx, a rate
 *                   limit, a token that was refused or (estimate only — a submit
 *                   that cannot mint throws before quoting) could not be minted, a
 *                   funds refusal, or a failure before the request was sent (other than a
 *                   blob the orchestrator says is gone). Nothing from the failure is
 *                   forwarded.
 * - `unpriced`    — the orchestrator answered without a finite total.
 */
export type PassThroughQuoteFailure =
  | { kind: 'rejected'; reason?: string }
  | { kind: 'unavailable' }
  | { kind: 'unpriced' };

export const TRAINING_QUOTE_ERROR_CODES = {
  rejected: 'training-quote-rejected',
  unavailable: 'training-quote-unavailable',
  unpriced: 'training-quote-unpriced',
} as const satisfies Record<PassThroughQuoteFailure['kind'], string>;

export type TrainingQuoteErrorCode =
  (typeof TRAINING_QUOTE_ERROR_CODES)[keyof typeof TRAINING_QUOTE_ERROR_CODES];

/** A `kind: 'workflow'` ESTIMATE with no price to show; the submit defines no such refusal. */
export const WORKFLOW_QUOTE_ERROR_CODES = {
  rejected: 'workflow_quote_rejected',
  unavailable: 'workflow_quote_unavailable',
  unpriced: 'workflow_quote_unpriced',
} as const satisfies Record<PassThroughQuoteFailure['kind'], string>;

export type WorkflowQuoteErrorCode =
  (typeof WORKFLOW_QUOTE_ERROR_CODES)[keyof typeof WORKFLOW_QUOTE_ERROR_CODES];

/** A registered-step (`kind: 'step'`, `step`) ESTIMATE with no price to show. */
export const STEP_QUOTE_ERROR_CODES = {
  rejected: 'step_quote_rejected',
  unavailable: 'step_quote_unavailable',
  unpriced: 'step_quote_unpriced',
} as const satisfies Record<PassThroughQuoteFailure['kind'], string>;

export type StepQuoteErrorCode =
  (typeof STEP_QUOTE_ERROR_CODES)[keyof typeof STEP_QUOTE_ERROR_CODES];

// `orchestratorErrorMessage` joins the orchestrator's validation messages this way.
const MESSAGE_SEPARATOR = ',\n';
const MAX_MESSAGES = 5;
const MAX_REASON_LENGTH = 300;

// On top of `isLikelySafeMessage`: network locations it does not look for.
const UNSAFE_LOCATION_PATTERNS: RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\//i, // any scheme, not only http(s)
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/, // IPv4
  /\b[\w-]+(?:\.[\w-]+)+:\d{2,5}\b/, // host:port
  /\.(?:svc|local|internal|cluster|lan|corp)\b/i, // private DNS suffixes
];

/** Host-written; nothing from the refresh failure is forwarded. */
export const MISSING_BLOB_REASON =
  'An image in the training data is no longer available. Upload it again.';

const OPAQUE_TOKEN = /[A-Za-z0-9_-]{24,}/g;

/**
 * The orchestrator's message when it is plain prose, else `undefined`.
 *
 * A long opaque string (an id, a key, a token) is allowed only when it also appears
 * in `callerText` — the caller's own submitted input — so the reason can name a
 * dataset entry the app sent but never an identifier it did not.
 */
export function safeQuoteReason(message: string, callerText: string): string | undefined {
  const parts = message
    .split(MESSAGE_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > MAX_MESSAGES) return undefined;
  if (!parts.every(isLikelySafeMessage)) return undefined;

  const reason = parts.join('; ');
  if (reason.length > MAX_REASON_LENGTH) return undefined;
  if (UNSAFE_LOCATION_PATTERNS.some((re) => re.test(reason))) return undefined;
  const opaque = reason.match(OPAQUE_TOKEN) ?? [];
  if (opaque.some((token) => /\d/.test(token) && !callerText.includes(token))) return undefined;
  return reason;
}

/**
 * Orchestrator statuses that are a 4xx but do not refuse the request itself:
 * - 401 — our own service token was refused (a server-side problem);
 * - 403 — insufficient funds (fixed by topping up, and its message may describe the
 *         viewer's balance, which an app must not be handed);
 * - 408 / 429 — a timeout / rate limit, retryable as is.
 */
const NOT_A_REQUEST_REFUSAL = new Set([401, 403, 408, 429]);

/**
 * Classifies what a `whatif` submit threw.
 *
 * Keyed on the orchestrator response status `submitWorkflow` records on the error
 * (`getOrchestratorSubmitFailure`), not on the `TRPCError` code: the code cannot tell
 * a 400 from a 403 (both BAD_REQUEST), nor a validation reply from a throw raised
 * before any request was sent (a failed blob-URL refresh is also BAD_REQUEST). An
 * error without a recorded response never reached the orchestrator's validation,
 * so it is `unavailable`.
 */
export function classifyQuoteFailure(err: unknown, callerText: string): PassThroughQuoteFailure {
  // A blob-URL refresh that failed before the quote was sent is `unavailable`, EXCEPT
  // when the orchestrator answered that the blob is gone: the same body can never
  // succeed, so "try again" would be wrong. A refresh that failed in transit stays
  // `unavailable` — it says nothing about the blob.
  if (err instanceof TRPCError && isOrchestratorMissingBlob(err)) {
    return { kind: 'rejected', reason: MISSING_BLOB_REASON };
  }
  const response = getOrchestratorSubmitFailure(err);
  if (!(err instanceof TRPCError) || !response) return { kind: 'unavailable' };
  const { status } = response;
  if (status < 400 || status >= 500 || NOT_A_REQUEST_REFUSAL.has(status)) {
    return { kind: 'unavailable' };
  }
  const reason = safeQuoteReason(err.message, callerText);
  return reason === undefined ? { kind: 'rejected' } : { kind: 'rejected', reason };
}

/**
 * Recorded orchestrator statuses that are the viewer's own doing, not a fault of ours:
 * 403 insufficient funds, 429 rate limit.
 */
const VIEWER_CAUSED_STATUSES = new Set([403, 429]);

/**
 * The log level for a swallowed quote failure, from THIS classification rather than
 * the generic tRPC client-fault table: that table counts UNAUTHORIZED and every
 * BAD_REQUEST as a client fault, but here a 401 is our own service token refused, a
 * 408 is an upstream timeout, and an unannotated BAD_REQUEST is a blob refresh that
 * failed in transit — all ours. Only an outcome caused by the request or the viewer
 * is a warning.
 */
export function quoteFailureLogLevel(
  failure: PassThroughQuoteFailure,
  err: unknown
): 'warning' | 'error' {
  if (failure.kind === 'rejected') return 'warning';
  const status = getOrchestratorSubmitFailure(err)?.status;
  return status !== undefined && VIEWER_CAUSED_STATUSES.has(status) ? 'warning' : 'error';
}

const REJECTED_WITHOUT_REASON =
  'the orchestrator rejected the request; check the step inputs and references ' +
  '(retrying the same body will not help)';

/**
 * Why there is no quote, as the clause that completes "…needs a price quote and ".
 * Only `unavailable` says "try again": it is the one cause a retry of the same
 * body can clear.
 */
export function quoteFailureCause(failure: PassThroughQuoteFailure): string {
  switch (failure.kind) {
    case 'unavailable':
      return 'none could be obtained; try again';
    case 'unpriced':
      return 'the orchestrator answered without one';
    case 'rejected':
      return failure.reason === undefined
        ? REJECTED_WITHOUT_REASON
        : `the orchestrator rejected the request: ${failure.reason}`;
  }
}

/** The `error` / `errorCode` pair a block receives for an unquoted training step. */
export function unquotedTrainingRefusal(failure: PassThroughQuoteFailure): {
  error: string;
  errorCode: TrainingQuoteErrorCode;
} {
  const reason = failure.kind === 'rejected' ? failure.reason : undefined;
  return {
    error:
      reason === undefined
        ? `Training needs a price quote and ${quoteFailureCause(failure)}.`
        : `Training could not be priced: ${reason}`,
    errorCode: TRAINING_QUOTE_ERROR_CODES[failure.kind],
  };
}

/** The `error` / `errorCode` pair a block receives for a registered-step estimate with no quote. */
export function unquotedStepEstimateRefusal(failure: PassThroughQuoteFailure): {
  error: string;
  errorCode: StepQuoteErrorCode;
} {
  return {
    error: `No price quote for this step: ${quoteFailureCause(failure)}`,
    errorCode: STEP_QUOTE_ERROR_CODES[failure.kind],
  };
}

/** The `error` / `errorCode` pair a block receives for a `kind: 'workflow'` estimate with no quote. */
export function unquotedWorkflowEstimateRefusal(failure: PassThroughQuoteFailure): {
  error: string;
  errorCode: WorkflowQuoteErrorCode;
} {
  return {
    error: `No price quote for this workflow: ${quoteFailureCause(failure)}`,
    errorCode: WORKFLOW_QUOTE_ERROR_CODES[failure.kind],
  };
}
