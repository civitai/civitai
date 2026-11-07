/**
 * App Blocks in-app telemetry: the closed vocabularies and bounds shared by the server metric
 * (`civitai_app_block_submit_failures_total`), the `App_Error` / `App_Session` ClickHouse actions
 * and the two hosts that emit them. Client-safe: no server imports.
 *
 * Every value that becomes a prom label or a ClickHouse column is drawn from a list here, never
 * from error text, so neither can grow with what an app or the orchestrator says.
 */

import { ECOSYSTEM_UNAVAILABLE } from '~/shared/generation/gates';

/**
 * The stable text the generation graph's ecosystem field refuses with when the chosen ecosystem is
 * hidden or disabled (a disabled rule's own copy is APPENDED to it, `gateRefusalText`). Taken from
 * the graph's own constant, so the classifier below matches the string the graph actually throws
 * rather than a copy of it.
 */
export const ECOSYSTEM_UNAVAILABLE_MESSAGE = ECOSYSTEM_UNAVAILABLE;

export const APP_SUBMIT_FAILURE_REASONS = [
  'validation',
  'ecosystem_unavailable',
  'insufficient_buzz',
  'rate_limited',
  'server_error',
  'other',
] as const;
export type AppSubmitFailureReason = (typeof APP_SUBMIT_FAILURE_REASONS)[number];

/** tRPC codes that mean the server could not answer, not that it refused. */
const SERVER_ERROR_CODES: ReadonlySet<string> = new Set([
  'INTERNAL_SERVER_ERROR',
  'BAD_GATEWAY',
  'SERVICE_UNAVAILABLE',
  'GATEWAY_TIMEOUT',
  'TIMEOUT',
]);

/** tRPC codes that mean the request itself was refused as malformed or invalid. */
const VALIDATION_CODES: ReadonlySet<string> = new Set([
  'BAD_REQUEST',
  'PARSE_ERROR',
  'UNPROCESSABLE_CONTENT',
]);

// The spellings the spend paths use: the per-call budget refusal (`insufficient buzz budget: …`),
// the confirmed-quote copy (`Not enough Buzz for …`), the orchestrator/ledger funds refusal
// (`throwInsufficientFundsError`: "… don't have enough funds …", or the orchestrator's own
// "Insufficient funds" detail), and the cap refusals the router RETURNS as failed snapshots
// (`daily | private-run | private run | review run-for-real | dev tunnel session Buzz cap
// reached`, `app Buzz limit reached`, `app daily spend cap reached`). The router's literal
// strings are pinned against this classifier by blocks.router.failed-snapshot-reasons.test.ts.
const INSUFFICIENT_BUZZ_RE =
  /insufficient (buzz|funds)|not enough (buzz|funds)|enough funds|buzz (cap|limit) reached|spend cap reached/i;
const RATE_LIMIT_RE = /rate limit/i;
// `generation temporarily unavailable …`: the spend cap could not be read, or the orchestrator
// returned no price quote. The server could not answer; the viewer did nothing wrong.
const SERVER_UNAVAILABLE_RE = /temporarily unavailable/i;
const VALIDATION_PREFIX_RE = /^validation failed\b/i;

/**
 * Map a submit failure to a bounded reason. `code` is a tRPC error code when there is one
 * (absent for a failure the server RETURNED as a failed snapshot rather than threw); `message` is
 * only ever matched, never stored.
 *
 * Order matters: the ecosystem refusal arrives as `Validation failed: ecosystem: Ecosystem is
 * currently unavailable` with code BAD_REQUEST, so it is checked before the generic validation
 * arm; a funds refusal is also a BAD_REQUEST, so it is checked before the code arms too.
 */
export function classifyAppSubmitFailure(input: {
  code?: unknown;
  message?: unknown;
}): AppSubmitFailureReason {
  const code = typeof input.code === 'string' ? input.code : undefined;
  const message = typeof input.message === 'string' ? input.message : '';

  if (code === 'TOO_MANY_REQUESTS') return 'rate_limited';
  if (message.includes(ECOSYSTEM_UNAVAILABLE_MESSAGE)) return 'ecosystem_unavailable';
  if (code === 'PAYMENT_REQUIRED' || INSUFFICIENT_BUZZ_RE.test(message)) return 'insufficient_buzz';
  if (code && SERVER_ERROR_CODES.has(code)) return 'server_error';
  if (SERVER_UNAVAILABLE_RE.test(message)) return 'server_error';
  if (RATE_LIMIT_RE.test(message)) return 'rate_limited';
  if (VALIDATION_PREFIX_RE.test(message)) return 'validation';
  if (code && VALIDATION_CODES.has(code)) return 'validation';
  return 'other';
}

/**
 * The reason for a thrown value, on either side of the wire: a server `TRPCError` carries `code`;
 * a client `TRPCClientError` carries it at `data.code`. Anything else is classified by message.
 */
export function appSubmitFailureFromError(err: unknown): AppSubmitFailureReason {
  if (err === null || typeof err !== 'object') return 'other';
  const e = err as { code?: unknown; message?: unknown; data?: { code?: unknown } | null };
  const code = typeof e.code === 'string' ? e.code : e.data?.code;
  return classifyAppSubmitFailure({ code, message: e.message });
}

/**
 * The reason for a submit that RESOLVED, or `null` when it did not fail. Several spend refusals
 * (the per-call budget, the workflow ceiling) are returned as `{ snapshot: { status: 'failed',
 * error } }` rather than thrown, so a failure counter that only watched throws would miss them.
 */
export function appSubmitFailureFromResult(result: unknown): AppSubmitFailureReason | null {
  if (result === null || typeof result !== 'object') return null;
  const snapshot = (result as { snapshot?: unknown }).snapshot;
  if (snapshot === null || typeof snapshot !== 'object') return null;
  const { status, error } = snapshot as { status?: unknown; error?: unknown };
  if (status !== 'failed') return null;
  return classifyAppSubmitFailure({ message: error });
}

/** Where in the host the error surfaced. */
export const APP_ERROR_STAGES = ['submit', 'training_submit', 'confirmed_step_submit'] as const;
export type AppErrorStage = (typeof APP_ERROR_STAGES)[number];

/** Which host emitted an `App_Session`. */
export const APP_SESSION_HOSTS = ['page', 'iframe'] as const;
export type AppSessionHost = (typeof APP_SESSION_HOSTS)[number];

/**
 * App ids as the platform mints them (`apb_<ULID>`), bounded so a forged batch cannot put free
 * text in the `details` column. A review mount's synthetic id never reaches the emitter.
 */
export const APP_TELEMETRY_APP_BLOCK_ID_RE = /^[A-Za-z0-9_]{1,64}$/;

/** Upper bound on one session's visible time: a tab left open for a day is not a 30-day session. */
export const APP_SESSION_MAX_DURATION_MS = 24 * 60 * 60 * 1000;
/** Upper bound on either count in one session. */
export const APP_SESSION_MAX_COUNT = 1_000_000;

/**
 * Clamp a client-side number into `[0, max]` as an integer. The schema rejects out-of-range
 * values, and a rejected event fails its whole `/api/track/batch` request, so the emitter clamps
 * first rather than lose the neighbours riding with it.
 */
export function clampTelemetryInt(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), max);
}
