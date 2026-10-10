import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { isLikelySafeMessage } from '~/server/services/orchestrator/provider-errors';

/**
 * Why a pass-through step has no price quote.
 *
 * - `rejected`    — the orchestrator refused the request (a 4xx); retrying the same
 *                   body will not help. `reason` is set only when its message is safe
 *                   to show.
 * - `unavailable` — no usable answer: a network failure, a timeout, a 5xx, a rate
 *                   limit, or a token that could not be minted. Retryable.
 * - `unpriced`    — the orchestrator answered without a finite total.
 */
export type PassThroughQuoteFailure =
  | { kind: 'rejected'; reason?: string }
  | { kind: 'unavailable' }
  | { kind: 'unpriced' };

export const UNQUOTED_TRAINING_ERROR =
  'Training needs a price quote and none could be obtained; try again.';

export const TRAINING_QUOTE_ERROR_CODES = {
  rejected: 'training-quote-rejected',
  unavailable: 'training-quote-unavailable',
  unpriced: 'training-quote-unpriced',
} as const satisfies Record<PassThroughQuoteFailure['kind'], string>;

export type TrainingQuoteErrorCode =
  (typeof TRAINING_QUOTE_ERROR_CODES)[keyof typeof TRAINING_QUOTE_ERROR_CODES];

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
 * Classifies what a `whatif` submit threw. `submitWorkflow` has already mapped the
 * orchestrator response onto a `TRPCError` (`throwOrchestratorFailure`), so the
 * status class of that error is the classification.
 */
export function classifyQuoteFailure(err: unknown, callerText: string): PassThroughQuoteFailure {
  if (!(err instanceof TRPCError)) return { kind: 'unavailable' };
  const status = getHTTPStatusCodeFromError(err);
  if (status < 400 || status >= 500 || status === 408 || status === 429) {
    return { kind: 'unavailable' };
  }
  const reason = safeQuoteReason(err.message, callerText);
  return reason === undefined ? { kind: 'rejected' } : { kind: 'rejected', reason };
}

/** The `error` / `errorCode` pair a block receives for an unquoted training step. */
export function unquotedTrainingRefusal(failure: PassThroughQuoteFailure): {
  error: string;
  errorCode: TrainingQuoteErrorCode;
} {
  const reason = failure.kind === 'rejected' ? failure.reason : undefined;
  return {
    error:
      reason === undefined ? UNQUOTED_TRAINING_ERROR : `Training could not be priced: ${reason}`,
    errorCode: TRAINING_QUOTE_ERROR_CODES[failure.kind],
  };
}
