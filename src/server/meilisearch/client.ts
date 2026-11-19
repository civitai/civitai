import { createHash } from 'crypto';
import type { EnqueuedTask, Index, SearchParams, SearchResponse } from 'meilisearch';
import { MeiliSearch } from 'meilisearch';
import pLimit from 'p-limit';
import { env } from '~/env/server';
import { createLogger } from '~/utils/logging';
import { sleep } from '~/server/utils/errorHandling';
import type { JobContext } from '~/server/jobs/job';
import {
  registerCounterWithLabels,
  registerHistogram,
  registerGaugeWithLabels,
} from '~/server/prom/client';

const log = createLogger('search', 'green');

const shouldConnectToSearch = !env.IS_BUILD && !!env.SEARCH_HOST && !!env.SEARCH_API_KEY;
export const searchClient = shouldConnectToSearch
  ? new MeiliSearch({
      host: env.SEARCH_HOST as string,
      apiKey: env.SEARCH_API_KEY,
    })
  : null;

export function buildSearchActor({
  userId,
  ip,
  userAgent,
}: {
  userId?: number | null;
  ip?: string | null;
  userAgent?: string | null;
}) {
  if (userId) return `user:${userId}`;
  const fp = createHash('sha256')
    .update(`${ip ?? ''}|${userAgent ?? ''}`)
    .digest('hex')
    .slice(0, 16);
  return `anon:${fp}`;
}

/**
 * Does `status` qualify for graceful-break treatment by post-filter / future
 * iteration-loop callers? True for the genuinely-transient upstream statuses:
 *   - 408 Request Timeout      (upstream-side timeout)
 *   - 429 Too Many Requests    (feeds-proxy / backend rate-limit shed)
 *   - any 5xx                  (502 bad gateway, 503 unavailable, 504 gateway
 *                               timeout — upstream brownout)
 * False for 4xx-other (400 malformed filter, 401/403 auth — real client error,
 * must bubble up so we don't silently hide app bugs as retryable).
 *
 * 429 is included because a transient upstream rate-limit is retryable (the
 * caller can back off and re-issue), exactly like a 503 shed; mapping it to a
 * hard 500 instead would (a) inflate the 500 SLO with a transient and (b) deny
 * the client/CF the Retry-After it would honor. It is NOT the public endpoint's
 * own paging 429 (that is returned directly by the handler before search runs).
 */
export function isFailfastStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Exact HTTP reason-phrase (statusText) → status code, for the transient
 * statuses `isFailfastStatus` already treats as fast-fail-eligible.
 *
 * WHY THIS EXISTS — the prod 500s that PR #2759 did NOT fix:
 * The heavy /api/v1/images feed runs Meili through the `event-engine-common`
 * submodule's `populatedQuery`, which bundles its OWN meilisearch-js. When that
 * inner SDK throws on a shed / slow backend, the error is re-thrown across the
 * submodule module boundary and arrives at the civitai-side catch as a PLAIN
 * `Error` whose ONLY signal is `message = <HTTP statusText>` (e.g.
 * "Service Unavailable" / "Request Timeout"). The structured shape is GONE:
 * no Meili `name` (not `MeiliSearchCommunicationError`/`ApiError`), no
 * `statusCode`/`httpStatus`/`code`/`errno`. So every name/status branch below
 * returned false and the handler mapped it to a hard 500 — confirmed live on
 * dp-prod AFTER #2759 deployed: `{"error":"Service Unavailable"}` /
 * `{"error":"Request Timeout"}` with NO `code` field. #2759's unit tests passed
 * because they built the RAW SDK error (with name + statusCode); prod throws the
 * stripped version.
 *
 * The match is DELIBERATELY EXACT (a `Set`/record lookup on the bare reason
 * phrase), NOT a substring/`includes`: a real app error is extremely unlikely to
 * have `.message` be EXACTLY one of these bare HTTP reason phrases, whereas a
 * substring match would mask "Bad Gateway error: <app detail>" or arbitrary
 * text and hide genuine bugs as retryable 503s (the audit's masking concern).
 *
 * Only the transient statuses are listed (mirrors `isFailfastStatus`'s
 * 408/429/5xx, restricted to the standard gateway/timeout/overload phrases that
 * a proxy or backend actually emits): 408/429/502/503/504. Notably ABSENT is
 * "Internal Server Error" (500) — a bare statusText-only 500 is ambiguous
 * (could be a deterministic app/Meili-internal bug), so it is NOT masked and
 * bubbles as a hard 500, matching the JSON-body-500 stance below.
 */
export const TRANSIENT_STATUSTEXT_TO_STATUS: Readonly<Record<string, number>> = {
  'Request Timeout': 408,
  'Too Many Requests': 429,
  'Bad Gateway': 502,
  'Service Unavailable': 503,
  'Gateway Timeout': 504,
};

/**
 * Classify an error caught from a Meilisearch SDK call (or the feeds
 * proxy in front of it) as a genuinely-transient upstream failure that should
 * surface to the client as a retryable 503, NOT a hard 500.
 *
 * Motivation — the dominant remaining HTTP-500 source on /api/v1/images (the
 * heavy per-user `sort=Most Reactions&period=Year&withMeta=true` feed): the
 * REST feed path runs through event-engine-common's `populatedQuery`, whose
 * inner meilisearch-js (0.33) calls throw the SDK's OWN error types on a slow /
 * shed backend — NOT civitai's `MeilisearchFetchError` / `MeiliCallTimeoutError`
 * (those wrap only the direct raw-fetch path). When the proxy/backend returns
 * 408 ("Request Timeout") or 503 ("Service Unavailable") with an empty body,
 * the SDK throws `MeiliSearchCommunicationError` with `message = statusText`
 * and `statusCode = <http status>`; a parseable error body yields a
 * `MeiliSearchApiError` carrying `httpStatus`. Neither is a TRPCError, so they
 * fell through every existing 503 branch and the handler mapped them to a
 * hard 500 ({"error":"Request Timeout"} / {"error":"Service Unavailable"}).
 *
 * Matches (all genuinely transient):
 *   - civitai wrappers: `MeiliCallTimeoutError` (local timer / circuit-open),
 *     `MeilisearchFetchError` with a failfast status (raw-fetch path)
 *   - SDK `MeiliSearchCommunicationError` (TRANSPORT layer — empty / non-JSON
 *     body) with a transient `.statusCode` (408/429/5xx, INCLUDING an
 *     empty-body 500) OR a network-level failure (`.code`/`.errno` set, no
 *     HTTP status — ECONNREFUSED / ECONNRESET / fetch-abort against the
 *     backend, i.e. the backend was unreachable, not a logic bug)
 *   - SDK `MeiliSearchApiError` (STRUCTURED JSON error body) ONLY for the
 *     unambiguously-transient gateway statuses `502/503/504`. A JSON-body 500
 *     is a DETERMINISTIC Meili-internal error, NOT a brownout, so it is NOT
 *     masked as transient — it bubbles as a hard 500. (The transport-layer
 *     500 above IS transient; the distinction is Api(JSON) vs Communication.)
 *   - SDK `MeiliSearchTimeOutError` (name-matched; class isn't re-exported on
 *     the path we instanceof against) — the SDK's own wait/timeout
 *
 * Deliberately NARROW: a 4xx-other (400 malformed filter, 401/403 auth) or any
 * other Error returns false and continues to surface as its real status (500
 * for a genuine app bug). We do NOT swallow non-transient failures as 503.
 */
export function isTransientMeiliError(error: unknown): boolean {
  if (error instanceof MeiliCallTimeoutError) return true;
  if (error instanceof MeilisearchFetchError) return isFailfastStatus(error.status);

  if (typeof error !== 'object' || error === null) return false;
  const e = error as {
    name?: string;
    message?: string;
    statusCode?: number; // MeiliSearchCommunicationError (HTTP responses)
    httpStatus?: number; // MeiliSearchApiError
    code?: string; // MeiliSearchCommunicationError (network errors) / MeiliSearchApiError
    errno?: string; // MeiliSearchCommunicationError (network errors)
  };

  if (e.name === 'MeiliSearchTimeOutError') return true;

  if (e.name === 'MeiliSearchApiError') {
    // A `MeiliSearchApiError` is thrown ONLY when Meili returned a STRUCTURED
    // JSON error body (a server-side response the SDK could parse). For a 5xx
    // that strongly implies a DETERMINISTIC Meili-internal error (e.g. an index
    // in a bad state, a malformed-internal-query 500) rather than a transient
    // brownout — so a JSON-body 500 MUST surface as a hard 500, not be masked
    // as a retryable 503 (the masking-guard the audit flagged). Only the
    // unambiguously-transient gateway statuses count here:
    //   502 Bad Gateway / 503 Service Unavailable / 504 Gateway Timeout.
    // (408/429 don't arrive as a parseable Meili JSON ApiError in practice; if
    // they ever do, they fall through to false → bubble as their real status,
    // which is the safe direction — we never widen masking.)
    if (typeof e.httpStatus === 'number') {
      return [502, 503, 504].includes(e.httpStatus);
    }
    // httpStatus undefined — fall through to the message lookup below. An
    // ApiError's `.message` is the Meili JSON error message (e.g.
    // "Index `x` not found"), NOT a bare HTTP statustext, so the EXACT-match
    // lookup won't false-match it as transient — but if some path ever DID
    // strip httpStatus while leaving a bare statustext message, we want it
    // caught rather than mis-classified as a hard 500.
    return messageMatchesTransientStatusText(e.message);
  }

  if (e.name === 'MeiliSearchCommunicationError') {
    // Transport-layer failure: empty / non-JSON body (the SDK couldn't parse a
    // structured error), which is the genuinely-transient case. Here a 500
    // (empty-body "Internal Server Error" / proxy 500) IS treated as transient
    // — `isFailfastStatus` covers 408/429/5xx including 500.
    // HTTP response → has a numeric statusCode (408/429/5xx are transient).
    if (typeof e.statusCode === 'number') return isFailfastStatus(e.statusCode);
    // Network-level failure (no HTTP status, but a node errno/code) → the
    // backend was unreachable / the socket dropped, which is transient.
    if (typeof e.errno === 'string' || typeof e.code === 'string') return true;
    // THE REAL PROD SHAPE (audit-confirmed against meilisearch-js 0.33/0.34):
    // the SDK's `request()` catch re-wraps the first `MeiliSearchCommunicationError`
    // via `httpErrorHandler` → `new MeiliSearchCommunicationError(firstErr.message,
    // firstErr, url, stack)`. The 2nd arg is now an Error (not a Response), so the
    // constructor's `if (body instanceof Response)` block that sets `statusCode`
    // does NOT run → `statusCode` is dropped — but `this.name` is STILL set to
    // 'MeiliSearchCommunicationError' and `this.message` STILL carries the
    // original statustext ("Service Unavailable" / "Request Timeout"). So here —
    // name preserved, statusCode undefined, no errno/code — the message statustext
    // is the only surviving signal. Fall back to the EXACT-match lookup instead of
    // returning false (which is what made PR #2759/#2765's fallback DEAD CODE: the
    // function exited in this branch before ever reaching the terminal lookup).
    return messageMatchesTransientStatusText(e.message);
  }

  // statusText-message fallback — belt-and-suspenders for a NAMELESS plain Error
  // (in case any path DOES strip the Meili `name` too). The audit proved the real
  // prod error keeps `.name` (handled in the CommunicationError branch above), but
  // a stripped variant would arrive here with NO name / statusCode / httpStatus /
  // code, carrying only `message = <HTTP statusText>`. An EXACT (case- and
  // whitespace-sensitive) match of `.message` is the only signal left. EXACT,
  // never substring — see `TRANSIENT_STATUSTEXT_TO_STATUS` JSDoc for the masking
  // rationale.
  return messageMatchesTransientStatusText(e.message);
}

/**
 * EXACT (case- and whitespace-sensitive) lookup of an error message against the
 * transient HTTP reason-phrase set. Returns true only when `message` is EXACTLY
 * one of the bare transient statustexts (never a substring — see the masking
 * rationale in `TRANSIENT_STATUSTEXT_TO_STATUS`). Shared by `isTransientMeiliError`
 * so the statustext fallback is reachable on BOTH the name-preserved
 * CommunicationError/ApiError-with-undefined-status path AND the (hypothetical)
 * fully-stripped nameless-Error path.
 */
function messageMatchesTransientStatusText(message: unknown): boolean {
  return (
    typeof message === 'string' &&
    Object.prototype.hasOwnProperty.call(TRANSIENT_STATUSTEXT_TO_STATUS, message)
  );
}

/**
 * Typed error thrown when the upstream Meili backend returns a non-ok HTTP
 * status code (`searchWithSignal` throws it for a missing response body).
 * Carries the status + response body verbatim so callers can
 * pattern-match on `instanceof MeilisearchFetchError` + `.status` instead of
 * string-matching the message.
 *
 * The 408 (upstream timeout) + 5xx (overload / bad gateway / unavailable)
 * statuses are the ones that callers fast-fail on; 4xx other than 408 (400 malformed filter, 401/403 auth)
 * indicate real client-side bugs and continue to propagate.
 *
 * Message format is intentionally preserved byte-for-byte from the prior
 * bare-Error throw (`Meilisearch fetch failed (NNN): <body>`) — Loki
 * queries / dashboards keyed on that prefix continue to match without
 * change.
 */
export class MeilisearchFetchError extends Error {
  readonly name = 'MeilisearchFetchError';
  constructor(public readonly status: number, public readonly responseText: string) {
    super(`Meilisearch fetch failed (${status}): ${responseText}`);
  }
}

/**
 * Typed error thrown by withMeili() when a wrapped Meilisearch call exceeds
 * MEILI_CALL_TIMEOUT_MS.
 *
 * Hot-path callers (image feed, getImagesFromSearch SDK call) catch this and
 * return a fast 408 instead of
 * bleeding event-loop time waiting for Traefik's 30s router timeout — which
 * is what bled api-primary pods to kubelet SIGKILL on 2026-05-29.
 */
export class MeiliCallTimeoutError extends Error {
  readonly code = 'MEILI_CALL_TIMEOUT';
  readonly reason: 'timeout' | 'concurrency';

  constructor(reason: 'timeout' | 'concurrency', message?: string) {
    super(
      message ??
        (reason === 'timeout'
          ? `Meilisearch call exceeded ${env.MEILI_CALL_TIMEOUT_MS}ms timeout`
          : `Meilisearch call concurrency limit exceeded`)
    );
    this.name = 'MeiliCallTimeoutError';
    this.reason = reason;
  }
}

/**
 * The one shared user-traffic backend: 'search' → SEARCH_HOST (searchClient).
 * The resource picker runs on its own limiter ('resourceSelect', below) so a
 * brownout here cannot blank it.
 *
 * p-limit is already in use elsewhere (see src/utils/generator-import.ts).
 */
export type MeiliBackend = 'search';
type LimiterKey = MeiliBackend | 'resourceSelect';

// 🔴 SHARED_STATE: the limiters and circuits live on globalThis, not in module scope.
//
// The production server build emits this module TWICE, once per Turbopack runtime
// (`chunks/` serves API routes and instrumentation, `chunks/ssr/` serves page SSR). Each
// runtime has its own module cache, so a module-scope `const` here would be two independent
// sets of limiters and circuits in one process. prom-client is externalized, so both copies
// register into ONE default registry. The second copy to evaluate gets the first copy's gauge
// back from `registerGaugeWithLabels` and reassigns its `collect` below. With private state,
// the scraped gauges then read whichever copy evaluated last. That was the SSR copy, warmed
// last via `/`, and it is idle on the API pods that carry the Meili traffic. So
// meili_call_active, meili_call_queue_depth and meili_circuit_state read 0 on every pod through
// a six-day brownout that tripped the circuit ~108k times. The counters were unaffected
// because both copies increment the one shared counter object.
//
// One shared object means every copy's withMeili() admits against the same circuit and the same
// per-backend concurrency cap, and every copy's collect() reads that state, whichever one won.
// `??=`, not `=`: with `=`, a later copy would REPLACE the state, orphan the first copy's
// in-flight slots and reopen the bug. Vitest loads each module once and cannot see
// any of this unless it is made to (src/server/meilisearch/__tests__/client-gauges.dual-graph.test.ts).
declare global {
  // eslint-disable-next-line no-var
  var __civitaiMeiliWrapperState:
    | {
        limiters: Record<LimiterKey, ReturnType<typeof pLimit>>;
        circuits: Record<MeiliBackend, Circuit>;
      }
    | undefined;
}

const meiliWrapperState = (globalThis.__civitaiMeiliWrapperState ??= {
  limiters: {
    search: pLimit(env.MEILI_CALL_CONCURRENCY),
    resourceSelect: pLimit(env.MEILI_RESOURCE_SELECT_CONCURRENCY),
  },
  circuits: {
    search: { state: 'CLOSED', failures: [], cooldownUntil: 0, trialInFlight: false },
  },
});

const limiters = meiliWrapperState.limiters;

// Observability counters & gauge — see N1 in PR description. The active gauge
// is sampled lazily on Prometheus scrape via a `collect` hook so we don't
// touch a hot path on every call.
const meiliCallTimeoutsCounter = registerCounterWithLabels({
  name: 'meili_call_timeouts_total',
  help: 'Meilisearch wrapped-call timeouts by backend (search|resourceSelect)',
  labelNames: ['backend'] as const,
});
const meiliCallActiveGauge = registerGaugeWithLabels({
  name: 'meili_call_active',
  help: 'In-flight wrapped Meilisearch calls by backend',
  labelNames: ['backend'] as const,
});
const meiliCallQueueGauge = registerGaugeWithLabels({
  name: 'meili_call_queue_depth',
  help: 'Queued (not-yet-running) wrapped Meilisearch calls by backend',
  labelNames: ['backend'] as const,
});
// Cheap: a small gauge sampler runs only on /metrics scrape.
(meiliCallActiveGauge as any).collect = function collect() {
  for (const key of Object.keys(limiters) as LimiterKey[]) {
    this.set({ backend: key }, limiters[key].activeCount);
  }
};
(meiliCallQueueGauge as any).collect = function collect() {
  for (const key of Object.keys(limiters) as LimiterKey[]) {
    this.set({ backend: key }, limiters[key].pendingCount);
  }
};

const meiliCallDurationHistogram = registerHistogram({
  name: 'meili_call_duration_seconds',
  help: 'Wall-clock duration of wrapped Meilisearch calls by backend',
  labelNames: ['backend'] as const,
  // Spans 1ms → 30s. Denser between 100ms and 5s where the brownout zone lives.
  buckets: [0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 2.5, 3.5, 5, 7.5, 10, 30],
});

// ────────────────────────────────────────────────────────────────────────────
// Per-backend circuit breaker
// ────────────────────────────────────────────────────────────────────────────
//
// Why this exists: 2026-05-30 chronic brownout cascade — 14h of Meili
// upstream degradation produced 70+ storm intervals, 483 pod restarts, with
// the 50-slot limiter + 2.5s timeout firing throughout. Under that load,
// 50 concurrent callers each waiting the full 2.5s before failing
// accumulates ~125 worker-seconds of event-loop pressure per pod per cycle
// — enough to block past the kubelet 5s TCP probe threshold and trip
// SIGKILL.
//
// The circuit breaker short-circuits at 0ms once a backend is demonstrably
// failing, eliminating that accumulated wait. The circuit is tracked per
// backend; only 'search' has one ('resourceSelect' is exempt, see below).
//
// State machine (per backend):
//   CLOSED → (failures >= TRIP_THRESHOLD in WINDOW_SECONDS) → OPEN
//   OPEN → (now >= cooldownUntil) → HALF_OPEN
//   HALF_OPEN → (trial success) → CLOSED
//   HALF_OPEN → (trial failure) → OPEN (new cooldown)
//
// Failures counted: MeiliCallTimeoutError. Other errors (network, HTTP 5xx
// not surfaced via timeout) are NOT counted — they're either symptoms of the
// timeout path or app-level errors not indicative of upstream brownout.

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

type Circuit = {
  state: CircuitState;
  // Unix ms timestamps of recent counted failures. Pruned on each access.
  failures: number[];
  // ms-since-epoch; only meaningful when state === 'OPEN'.
  cooldownUntil: number;
  // While HALF_OPEN, whether the single trial slot is currently in flight.
  // Prevents a thundering-herd retry against a still-broken backend.
  trialInFlight: boolean;
};

// Process-wide, shared by every emitted copy of this module (see the SHARED_STATE note above).
const circuits = meiliWrapperState.circuits;

const meiliCircuitStateGauge = registerGaugeWithLabels({
  name: 'meili_circuit_state',
  help: 'Per-backend circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)',
  labelNames: ['backend'] as const,
});
const meiliCircuitTripsCounter = registerCounterWithLabels({
  name: 'meili_circuit_trips_total',
  help: 'Count of CLOSED→OPEN (or HALF_OPEN→OPEN re-trips) transitions per backend',
  labelNames: ['backend'] as const,
});
// Per-call rejections while the circuit is OPEN or HALF_OPEN-with-trial-busy.
// Kept SEPARATE from meili_call_timeouts_total — that counter's documented
// meaning is "backend timed out at MEILI_CALL_TIMEOUT_MS". Conflating
// circuit-open rejections (which never touch the backend) would inflate it
// at request-arrival rate during OPEN and falsely trigger any alert keyed on
// rate(meili_call_timeouts_total). Operators wanting "all fast-fail events"
// should sum these two.
const meiliCircuitRejectionsCounter = registerCounterWithLabels({
  name: 'meili_circuit_rejections_total',
  help: 'Calls rejected at 0ms because circuit was OPEN or HALF_OPEN-busy, by backend',
  labelNames: ['backend'] as const,
});
(meiliCircuitStateGauge as any).collect = function collect() {
  for (const backend of Object.keys(circuits) as MeiliBackend[]) {
    const s = circuits[backend].state;
    this.set({ backend }, s === 'CLOSED' ? 0 : s === 'HALF_OPEN' ? 1 : 2);
  }
};

function circuitWindowMs() {
  return env.MEILI_CIRCUIT_WINDOW_SECONDS * 1000;
}
function circuitCooldownMs() {
  return env.MEILI_CIRCUIT_COOLDOWN_SECONDS * 1000;
}

function pruneFailures(c: Circuit, now: number) {
  const cutoff = now - circuitWindowMs();
  // Failures are pushed in chronological order; find first kept index.
  let i = 0;
  while (i < c.failures.length && c.failures[i] < cutoff) i++;
  if (i > 0) c.failures.splice(0, i);
}

function transition(backend: MeiliBackend, c: Circuit, next: CircuitState, now: number) {
  if (c.state === next) return;
  const wasOpen = c.state === 'OPEN' || c.state === 'HALF_OPEN';
  c.state = next;
  if (next === 'OPEN') {
    c.cooldownUntil = now + circuitCooldownMs();
    c.trialInFlight = false;
    meiliCircuitTripsCounter.inc({ backend });
  } else if (next === 'HALF_OPEN') {
    c.trialInFlight = false;
  } else if (next === 'CLOSED') {
    c.failures = [];
    c.cooldownUntil = 0;
    c.trialInFlight = false;
  }
  // Log state transitions so we can correlate to incidents without scraping.
  if (wasOpen || next !== 'CLOSED') {
    log(`meili circuit ${backend}: → ${next}`);
  }
}

/**
 * Pre-flight circuit check. Called synchronously inside runWithLimiter
 * before the pLimit acquire. Returns true if the call should proceed
 * (and reserves the trial slot if we're going HALF_OPEN → trial), false
 * if the circuit short-circuited the call.
 */
function admitCall(backend: MeiliBackend): { admitted: boolean; isTrial: boolean } {
  const c = circuits[backend];
  const now = Date.now();
  pruneFailures(c, now);

  if (c.state === 'OPEN') {
    if (now >= c.cooldownUntil) {
      transition(backend, c, 'HALF_OPEN', now);
      // Fall through into HALF_OPEN handling below.
    } else {
      return { admitted: false, isTrial: false };
    }
  }

  if (c.state === 'HALF_OPEN') {
    if (c.trialInFlight) {
      // Another trial is already probing the backend; reject this one fast.
      return { admitted: false, isTrial: false };
    }
    c.trialInFlight = true;
    return { admitted: true, isTrial: true };
  }

  return { admitted: true, isTrial: false };
}

/**
 * Post-call circuit update. Called once per admitted call regardless of
 * outcome. `failed` is true iff the call rejected with a counted-failure
 * (MeiliCallTimeoutError today). HALF_OPEN trial dispositions decide
 * whether to close or re-open the breaker.
 */
function recordCallOutcome(backend: MeiliBackend, isTrial: boolean, failed: boolean) {
  const c = circuits[backend];
  const now = Date.now();
  pruneFailures(c, now);

  if (failed) {
    c.failures.push(now);
  }

  if (isTrial) {
    c.trialInFlight = false;
    if (failed) {
      transition(backend, c, 'OPEN', now);
    } else {
      transition(backend, c, 'CLOSED', now);
    }
    return;
  }

  // Non-trial path: check the rolling window for trip.
  if (c.state === 'CLOSED' && failed && c.failures.length >= env.MEILI_CIRCUIT_TRIP_THRESHOLD) {
    transition(backend, c, 'OPEN', now);
  }
}

/**
 * Run a single Meilisearch SDK call under per-backend concurrency cap + hard
 * per-call timeout. Throws MeiliCallTimeoutError on the timeout path so
 * callers can fail-fast (408 to user) instead of hanging until Traefik's 30s
 * router timeout fires and pressures the event loop into kubelet liveness
 * failure.
 *
 * IMPORTANT SCOPE RULES:
 *   - Wrap ONLY the Meilisearch SDK call (`client.index(...).search(...)`,
 *     `.getDocuments(...)`, `.isHealthy()`, etc.). Do NOT wrap surrounding
 *     DB / Redis / CH / cache-populate work — those are independent
 *     dependencies and a slow Postgres query should not consume a Meili
 *     semaphore slot nor be falsely attributed to a Meili timeout.
 *   - Background / job / indexing callers (updateDocs and friends) are NOT
 *     wrapped — they have their own retry loops and slowness there is fine.
 *
 * Cancellation: `fn` receives a signal that aborts on `opts.signal` or on the
 * timeout. Only a call that hands it to its request (`search(q, params,
 * { signal })`) is cancelled; any other call loses the race and settles in the
 * background. Either way the limiter slot is released at the race, and a
 * search Meili has already started runs to completion regardless.
 *
 * The queue is intentionally unbounded: a saturated queue means every call
 * will time out at MEILI_CALL_TIMEOUT_MS and reject naturally — the timeout
 * is the actual safety net. Adding a queue-depth cap on top adds a TOCTOU
 * race and a second failure mode without strengthening the guarantee.
 */
async function runWithLimiter<T>(
  key: LimiterKey,
  backendLabel: string,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: { useTimeout?: boolean; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<T> {
  const useTimeout = opts.useTimeout ?? true;
  const timeoutMs = opts.timeoutMs ?? env.MEILI_CALL_TIMEOUT_MS;

  // Circuit breaker gate — only for the shared user-traffic backend.
  let isTrial = false;
  if (key === 'search') {
    const decision = admitCall(key);
    if (!decision.admitted) {
      meiliCircuitRejectionsCounter.inc({ backend: backendLabel });
      // Throw the same typed error so existing instanceof catches translate
      // to the same 408 / TRPCError(TIMEOUT) responses. reason='concurrency'
      // distinguishes circuit-open rejections from the timeout path for
      // anyone reading the .reason field.
      throw new MeiliCallTimeoutError(
        'concurrency',
        'Meilisearch backend circuit open — failing fast'
      );
    }
    isTrial = decision.isTrial;
  }

  const endTimer = meiliCallDurationHistogram.startTimer({ backend: backendLabel });
  return limiters[key](async () => {
    let timer: NodeJS.Timeout | undefined;
    let failedForCircuit = false;
    const timeoutCtrl = new AbortController();
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, timeoutCtrl.signal])
      : timeoutCtrl.signal;
    // Absorb a late rejection after the timeout wins the race. Without this
    // catch it bubbles to `unhandledRejection`, and Node's exit-on-unhandled
    // turns brownout protection into pod-crash amplification.
    const sdkCall = fn(signal);
    sdkCall.catch(() => undefined);
    try {
      if (!useTimeout) {
        // Caller supplied their own deadline (e.g. AbortSignal); skip the
        // 2.5s timer race entirely so we don't double-time-out. The circuit
        // still applies and the outcome still feeds the breaker.
        try {
          return await sdkCall;
        } catch (err) {
          // Caller's signal-aborted/network errors don't tell us anything
          // useful about backend brownout — only count an explicit
          // MeiliCallTimeoutError (none produced on this path today, but
          // future-proof for symmetry with the timeout branch).
          if (err instanceof MeiliCallTimeoutError) failedForCircuit = true;
          throw err;
        }
      }
      return await Promise.race([
        sdkCall,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            meiliCallTimeoutsCounter.inc({ backend: backendLabel });
            failedForCircuit = true;
            reject(
              new MeiliCallTimeoutError(
                'timeout',
                `Meilisearch call exceeded ${timeoutMs}ms timeout`
              )
            );
            timeoutCtrl.abort();
          }, timeoutMs);
          // Don't keep the event loop alive for this timer; the surrounding
          // Promise.race resolves either way.
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      // EMERGENCY 2026-05-30: see signals wrapper — a metric-observation
      // error must never propagate into the app request path.
      try {
        endTimer();
      } catch {
        // intentionally swallowed
      }
      if (key === 'search') {
        recordCallOutcome(key, isTrial, failedForCircuit);
      }
    }
  });
}

export function withMeili<T>(backend: MeiliBackend, fn: () => Promise<T>): Promise<T> {
  return runWithLimiter(backend, backend, fn);
}

/**
 * Resource-select (generation picker) variant of withMeili().
 *
 * Runs on a dedicated limiter and — because the circuit gate in runWithLimiter
 * only admits the shared user-traffic backend — bypasses the `search`
 * circuit breaker entirely.
 *
 * WHY the picker is exempt: shedding it is far more costly than shedding its
 * co-tenants. The image feed and the polled orchestrator routes recover on
 * their next tick, but the picker is a foreground, user-initiated, un-retried
 * modal — a shed call renders "No models found", i.e. a false statement that no
 * models exist. It was also insulated from all of this before the search moved
 * server-side (the browser queried Meili directly), so this restores the prior
 * blast radius rather than widening it.
 *
 * Its own timeouts still count toward nothing but its own failure — it neither
 * trips the shared circuit nor is tripped BY it, so a brownout in site search /
 * getModelsRaw / the feed can no longer blank the picker. The timeout is kept
 * (generous, not removed) so a hung backend still can't hold event-loop slots
 * to Traefik's 30s router timeout — the 2026-05-29 SIGKILL path.
 */
export function withMeiliResourceSelect<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  { signal }: { signal?: AbortSignal } = {}
): Promise<T> {
  return runWithLimiter('resourceSelect', 'resourceSelect', fn, {
    timeoutMs: env.MEILI_RESOURCE_SELECT_TIMEOUT_MS,
    signal,
  });
}

// meilisearch-js swallows a failed body read and resolves `undefined`, so an abort
// (or a dropped connection) mid-body would otherwise look like a successful search.
export async function searchWithSignal<D extends Record<string, any>>(
  index: Index,
  query: string,
  params: SearchParams,
  signal: AbortSignal
): Promise<SearchResponse<D>> {
  const res = await index.search<D>(query, params, { signal });
  signal.throwIfAborted();
  if (!res) throw new MeilisearchFetchError(502, 'response body did not arrive');
  return res;
}

const RETRY_LIMIT = 5;
export async function updateDocs({
  indexName,
  documents,
  batchSize = 1000,
  jobContext,
  client = searchClient,
}: {
  indexName: string;
  documents: any[];
  batchSize?: number;
  jobContext?: JobContext;
  client?: MeiliSearch | null;
}): Promise<EnqueuedTask[]> {
  if (!client) return [];

  let retryCount = 0;
  while (true) {
    try {
      const updates = [];
      for (let i = 0; i < documents.length; i += batchSize) {
        jobContext?.checkIfCanceled();
        const batch = documents.slice(i, i + batchSize);
        try {
          updates.push(await client.index(indexName).updateDocuments(batch));
        } catch (e) {
          console.error(
            'updateDocs :: Failed on batch',
            i,
            'of',
            documents.length,
            'for index',
            indexName
          );

          throw e;
        }
      }
      return updates;
    } catch (err) {
      retryCount++;
      if (retryCount >= RETRY_LIMIT) throw err;
      console.error(
        `updateDocs :: error updating docs for index ${indexName}. Retry ${retryCount}`,
        err
      );

      await sleep(5000 * (1 + retryCount));
    }
  }
}
