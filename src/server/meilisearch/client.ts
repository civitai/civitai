import { createHash } from 'crypto';
import type { EnqueuedTask, DocumentsQuery, ResourceResults } from 'meilisearch';
import { MeiliSearch } from 'meilisearch';
import pLimit from 'p-limit';
import { env } from '~/env/server';
import { createLogger } from '~/utils/logging';
import { sleep } from '~/server/utils/errorHandling';
import type { JobContext } from '~/server/jobs/job';
import { withSpan, safeUrl } from '~/server/utils/otel-helpers';
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

const shouldConnectToMetricsSearch =
  !env.IS_BUILD && !!env.METRICS_SEARCH_HOST && !!env.METRICS_SEARCH_API_KEY;
export const metricsSearchClient = shouldConnectToMetricsSearch
  ? new MeiliSearch({
      host: env.METRICS_SEARCH_HOST as string,
      apiKey: env.METRICS_SEARCH_API_KEY,
    })
  : null;

export const SEARCH_ACTOR_HEADER = 'X-Search-Actor';

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

// Returns a fresh MeiliSearch instance with the X-Search-Actor header pinned
// for the lifetime of the call. The SDK applies requestConfig.headers to every
// request, so we create one per logical caller rather than mutating a shared
// instance. Construction is cheap — config-only, no socket pool.
export function getMetricsSearchClient(actor: string) {
  if (!shouldConnectToMetricsSearch) return null;
  return new MeiliSearch({
    host: env.METRICS_SEARCH_HOST as string,
    apiKey: env.METRICS_SEARCH_API_KEY,
    requestConfig: { headers: { [SEARCH_ACTOR_HEADER]: actor } },
  });
}

/**
 * Default per-call timeout for fetchDocumentsAbortable when the caller does
 * not pass a deadline-bound AbortSignal. Tuned to be generous enough that any
 * healthy backend response lands well below it, but short enough that a
 * brownout cannot pin event-loop slots long enough to flip /api/health past
 * the kubelet TCP-probe ceiling (the 2026-05-29 / 2026-05-31 cascade chain).
 *
 * Sourced from MEILI_FETCH_TIMEOUT_MS (default 5_000) so ops can tune the
 * deadline at runtime via the civitai-cfg ConfigMap without a code redeploy.
 *
 * The structural fix for backend slowness lives elsewhere (feeds-proxy index
 * sharding, BitDex migration); this constant is the *defensive* cap that
 * keeps civitai-dp-prod-api pods from holding the event loop for 30 s when
 * upstream goes sideways.
 */
export const FETCH_DOCUMENTS_DEFAULT_TIMEOUT_MS = env.MEILI_FETCH_TIMEOUT_MS;

/**
 * Sentinel error message thrown when the local fetchDocumentsAbortable
 * timer fires (i.e. neither the caller's signal nor the upstream produced a
 * response within `timeoutMs`). Exported so the call-site catch in
 * image.service.ts can recognise the timeout without string-matching from
 * an inline literal.
 */
export const FETCH_DOCUMENTS_TIMEOUT_MESSAGE = 'meili-fetch-timeout';

/**
 * Reason label values for `meiliFetchFailfastTotal`. Each value describes a
 * distinct backend-side failure mode that callers downstream of
 * fetchDocumentsAbortable choose to fast-fail / break out of an iteration
 * loop on. Kept as a const-as union so call-sites get type-checked.
 *
 *  - `local-timeout`     — the local 5s deadline fired before the upstream
 *                          responded (PR #2370 — the original behaviour;
 *                          preserved for backward-compat dashboards)
 *  - `upstream-overload` — upstream returned HTTP 503 (civitai-feeds-proxy
 *                          shed because MEILI_MAX_CONCURRENT was hit)
 *  - `upstream-timeout`  — upstream returned HTTP 408 (Meilisearch backend
 *                          page-cache thrashing past its own timeout)
 *  - `upstream-error`    — any other 5xx (bad gateway, gateway timeout from
 *                          Traefik to feeds-proxy, etc.)
 *  - `upstream-circuit-open` — the per-backend wrapper said no before the
 *                          request hit the network: either the circuit
 *                          breaker is OPEN / HALF_OPEN-busy, or the wrapper's
 *                          per-call timeout (MEILI_CALL_TIMEOUT_MS) fired on
 *                          an SDK call that arrived at runWithLimiter (PR
 *                          follow-up to #2371). Both surface as
 *                          `MeiliCallTimeoutError`; we use a single bucket
 *                          because operationally they signal the same thing
 *                          — "upstream is unhealthy, stop iterating".
 */
export type MeiliFetchFailfastReason =
  | 'local-timeout'
  | 'upstream-overload'
  | 'upstream-timeout'
  | 'upstream-error'
  | 'upstream-circuit-open';

/**
 * Reason constant for `MeiliCallTimeoutError`-driven fail-fast events. Lives
 * here (alongside the existing reason helpers) so the post-filter catch site
 * doesn't have to inline a string literal, mirroring the pattern PR #2371
 * established for the HTTP-status branches (which use
 * `failfastReasonForStatus`).
 *
 * Single bucket by design — see `MeiliFetchFailfastReason` JSDoc above.
 */
export const MEILI_FETCH_FAILFAST_REASON_CIRCUIT_OPEN: MeiliFetchFailfastReason =
  'upstream-circuit-open';

/**
 * Map an HTTP status returned by the upstream Meili backend (or its proxy)
 * onto the fail-fast reason label. Callers should ONLY pass a status they
 * already decided is "fast-fail eligible" (408 or 5xx); 4xx-other (400 bad
 * filter, 401/403 auth) should re-throw at the call site and never reach
 * this helper.
 */
export function failfastReasonForStatus(status: number): MeiliFetchFailfastReason {
  if (status === 408) return 'upstream-timeout';
  if (status === 503) return 'upstream-overload';
  return 'upstream-error';
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
 * Classify an error caught from a Meilisearch SDK call (or the civitai-feeds
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
 *   - the raw-fetch local-deadline error (message === FETCH_DOCUMENTS_TIMEOUT_MESSAGE)
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

  // The raw-fetch path's local-deadline abort (see fetchDocumentsAbortable).
  if (e.message === FETCH_DOCUMENTS_TIMEOUT_MESSAGE) return true;

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
    return typeof e.httpStatus === 'number' && [502, 503, 504].includes(e.httpStatus);
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
    return typeof e.errno === 'string' || typeof e.code === 'string';
  }

  // statusText-message fallback — the PROD shape PR #2759 missed. When the
  // Meili SDK error crosses the `event-engine-common` submodule boundary it
  // arrives as a PLAIN `Error` with NO name / statusCode / httpStatus / code,
  // carrying only `message = <HTTP statusText>` (e.g. "Service Unavailable").
  // None of the structured branches above can see it, so an EXACT (case- and
  // whitespace-sensitive) match of `.message` against the transient reason
  // phrases is the only signal left. EXACT, never substring — see
  // `TRANSIENT_STATUSTEXT_TO_STATUS` JSDoc for the masking rationale.
  if (typeof e.message === 'string') {
    return Object.prototype.hasOwnProperty.call(TRANSIENT_STATUSTEXT_TO_STATUS, e.message);
  }

  return false;
}

/**
 * Map a transient Meili error (one that `isTransientMeiliError` returned true
 * for) onto a `MeiliFetchFailfastReason` label, so the `meiliFetchFailfastTotal`
 * counter stays attributable when a service catch reclassifies it to a 503.
 * Reuses `failfastReasonForStatus` for the status-bearing SDK errors (so the
 * label vocabulary matches the post-filter loop exactly) and adds the
 * timeout / network buckets the status helper doesn't cover:
 *   - civitai `MeiliCallTimeoutError` (wrapper timer / circuit-open) →
 *     `upstream-circuit-open`
 *   - `MeiliSearchTimeOutError` + the raw-fetch local-deadline message →
 *     `local-timeout`
 *   - network-level CommunicationError (errno/code, no HTTP status) →
 *     `upstream-error`
 * Caller contract: only pass errors `isTransientMeiliError(error)` accepts.
 */
export function failfastReasonForTransientError(error: unknown): MeiliFetchFailfastReason {
  if (error instanceof MeiliCallTimeoutError) return MEILI_FETCH_FAILFAST_REASON_CIRCUIT_OPEN;
  if (error instanceof MeilisearchFetchError) return failfastReasonForStatus(error.status);

  if (typeof error === 'object' && error !== null) {
    const e = error as {
      name?: string;
      message?: string;
      statusCode?: number;
      httpStatus?: number;
    };
    if (e.message === FETCH_DOCUMENTS_TIMEOUT_MESSAGE) return 'local-timeout';
    if (e.name === 'MeiliSearchTimeOutError') return 'local-timeout';
    if (e.name === 'MeiliSearchApiError' && typeof e.httpStatus === 'number') {
      return failfastReasonForStatus(e.httpStatus);
    }
    if (e.name === 'MeiliSearchCommunicationError' && typeof e.statusCode === 'number') {
      return failfastReasonForStatus(e.statusCode);
    }
    // statusText-message fallback (the stripped prod-shape plain Error — see
    // `TRANSIENT_STATUSTEXT_TO_STATUS`): derive the SAME reason label the status
    // code would have produced, so `meiliFetchFailfastTotal` stays meaningful
    // and the message-matched events bucket identically to their typed twins.
    if (typeof e.message === 'string') {
      const statusFromText = TRANSIENT_STATUSTEXT_TO_STATUS[e.message];
      if (typeof statusFromText === 'number') return failfastReasonForStatus(statusFromText);
    }
  }
  // Network-level CommunicationError (no HTTP status) / anything else transient
  // that didn't match a more specific bucket → the generic upstream-error label.
  return 'upstream-error';
}

/**
 * Counter incremented every time fetchDocumentsAbortable() fast-fails — i.e.
 * the local timer fired OR the upstream returned a status code that callers
 * treat as "backend unavailable, break gracefully". The `route` label
 * identifies the caller (so we can separate the pre-filter cascade from the
 * post-filter iteration cascade); `iteration` is meaningful for the
 * post-filter loop and defaults to `"0"` everywhere else; `reason` carries
 * the failure-mode label (see `MeiliFetchFailfastReason`).
 *
 * Renamed from `meili_fetch_timeout_total` (PR #2370) → `meili_fetch_failfast_total`
 * because the counter is no longer timeout-specific: it now captures every
 * fail-fast disposition fetchDocumentsAbortable surfaces. Dashboards keyed
 * on the old name will go empty for a few minutes during the transition;
 * the panel update lands in a follow-up commit in the datapacket-talos
 * repo.
 *
 * Naming follows the prom-client wrapper's PROM_PREFIX convention — exposed
 * to Prometheus as `civitai_app_meili_fetch_failfast_total`.
 */
export const meiliFetchFailfastTotal = registerCounterWithLabels({
  name: 'meili_fetch_failfast_total',
  help:
    'fetchDocumentsAbortable() fast-fail events (local timer fired OR ' +
    'upstream returned 408/5xx) — the defensive cap that prevents ' +
    'event-loop stalls from cascading into kubelet SIGKILL on ' +
    'civitai-dp-prod-api. `reason` distinguishes the failure mode.',
  labelNames: ['route', 'iteration', 'reason'] as const,
});

/**
 * Typed error thrown by fetchDocumentsAbortable() when the upstream Meili
 * backend (or the civitai-feeds-proxy in front of it) returns a non-ok HTTP
 * status code. Carries the status + response body verbatim so callers can
 * pattern-match on `instanceof MeilisearchFetchError` + `.status` instead of
 * string-matching the message.
 *
 * The 408 (upstream timeout) + 5xx (overload / bad gateway / unavailable)
 * statuses are the ones that callers downstream of fetchDocumentsAbortable
 * fast-fail on; 4xx other than 408 (400 malformed filter, 401/403 auth)
 * indicate real client-side bugs and continue to propagate.
 *
 * Message format is intentionally preserved byte-for-byte from the prior
 * bare-Error throw (`Meilisearch fetch failed (NNN): <body>`) — Loki
 * queries / dashboards keyed on that prefix continue to match without
 * change.
 */
export class MeilisearchFetchError extends Error {
  readonly name = 'MeilisearchFetchError';
  constructor(
    public readonly status: number,
    public readonly responseText: string
  ) {
    super(`Meilisearch fetch failed (${status}): ${responseText}`);
  }
}

/**
 * Fetch documents via a raw HTTP call that honors an AbortSignal. The
 * meilisearch-js client we're on (<=0.34) doesn't expose signal on
 * getDocuments, so we hit the /documents/fetch endpoint directly when a
 * cancellable request is needed (e.g. the image feed's slow-fetch path).
 *
 * Wrapped under runWithLimiter('metricsSearch', useTimeout=false) so a
 * backend brownout shares the same per-backend semaphore + circuit breaker
 * gate as the SDK path. The caller's AbortSignal remains the deadline (we
 * pass useTimeout=false to avoid a double race against the 2.5s timer).
 *
 * Hard local deadline:
 * In addition to the optional caller signal, we always race against a local
 * `timeoutMs` deadline (default FETCH_DOCUMENTS_DEFAULT_TIMEOUT_MS = 5_000).
 * The two signals are combined with `AbortSignal.any()`; on abort, the
 * underlying `fetch` rejects. When the local timer fires first, the abort
 * reason is `Error(FETCH_DOCUMENTS_TIMEOUT_MESSAGE)` so callers can
 * distinguish it from a true client disconnect and apply graceful fallback
 * (partial-page result, empty page, etc.).
 *
 * Before this cap, callers without a signal had NO server-side deadline —
 * fetch would wait the full Node default and stall the event loop, exactly
 * the failure mode that bled api-primary pods to kubelet SIGKILL on
 * 2026-05-29 / 2026-05-31.
 */
export async function fetchDocumentsAbortable<T>(
  indexName: string,
  params: DocumentsQuery<T>,
  options: {
    host: string;
    apiKey?: string;
    signal?: AbortSignal;
    actor?: string;
    timeoutMs?: number;
  }
): Promise<ResourceResults<T[]>> {
  const {
    host,
    apiKey,
    signal: callerSignal,
    actor,
    timeoutMs = FETCH_DOCUMENTS_DEFAULT_TIMEOUT_MS,
  } = options;
  const url = `${host}/indexes/${indexName}/documents/fetch`;
  const urlAttr = safeUrl(url);

  // Local deadline. `AbortSignal.any()` is the Node 20.3+ idiom for racing
  // multiple cancellation sources without leaking listeners; both the caller
  // disconnect and the local timer feed into the same composite signal that
  // fetch ultimately listens to.
  const localCtrl = new AbortController();
  const localTimer = setTimeout(
    () => localCtrl.abort(new Error(FETCH_DOCUMENTS_TIMEOUT_MESSAGE)),
    timeoutMs
  );
  // Don't keep the event loop alive solely for this timer.
  localTimer.unref?.();
  const signal: AbortSignal = callerSignal
    ? AbortSignal.any([callerSignal, localCtrl.signal])
    : localCtrl.signal;

  try {
    return await runWithLimiter(
      'metricsSearch',
      'metricsSearch',
      async () => {
        const res = await withSpan(
          'image:meili:http',
          {
            'http.method': 'POST',
            'http.url': urlAttr,
            'image.meili.index': indexName,
          },
          () =>
            fetch(url, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
                ...(actor ? { [SEARCH_ACTOR_HEADER]: actor } : {}),
              },
              body: JSON.stringify(params),
              signal,
            })
        );
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          // Typed error so callers can `instanceof MeilisearchFetchError` and
          // branch on `.status` (408/5xx → graceful break, 4xx-other → bubble)
          // without string-matching the message. Message format unchanged so
          // Loki/dashboard queries on `Meilisearch fetch failed (NNN):`
          // continue to match.
          throw new MeilisearchFetchError(res.status, text);
        }
        return withSpan(
          'image:meili:parse',
          {
            'http.url': urlAttr,
            'http.status_code': res.status,
            'image.meili.index': indexName,
          },
          async () => (await res.json()) as ResourceResults<T[]>
        );
      },
      // Caller's AbortSignal (composite, includes local deadline) is the
      // deadline; skip the wrapper's 2.5s timer to avoid a double-timeout
      // race. The circuit breaker still applies.
      { useTimeout: false }
    );
  } finally {
    clearTimeout(localTimer);
  }
}

/**
 * Typed error thrown by withMeili() when a wrapped Meilisearch call exceeds
 * MEILI_CALL_TIMEOUT_MS.
 *
 * Hot-path callers (image feed, /api/health.searchMetrics, getImagesFromSearch
 * SDK call) catch this and return a fast 408/probe-failure instead of
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
 * Backends are limited independently because they fail independently:
 *   - 'search'        → SEARCH_HOST    (civitai-feeds / searchClient / feed inline client)
 *   - 'metricsSearch' → METRICS_SEARCH_HOST (search-meilisearch / metricsSearchClient)
 *
 * A single shared limiter would let one bad backend exhaust the budget for
 * both. The 2026-05-29 cascade originated in the metrics backend; the feeds
 * backend was healthy. Splitting them isolates the blast radius.
 *
 * Health-probe traffic uses its own tiny limiter so a user-traffic spike on
 * the main limiter can't starve the kubelet probe — exactly the failure mode
 * we just patched out.
 *
 * p-limit is already in use elsewhere (see src/utils/generator-import.ts).
 */
export type MeiliBackend = 'search' | 'metricsSearch';
type LimiterKey = MeiliBackend | 'healthProbe';

const HEALTH_PROBE_CONCURRENCY = 2;

const limiters: Record<LimiterKey, ReturnType<typeof pLimit>> = {
  search: pLimit(env.MEILI_CALL_CONCURRENCY),
  metricsSearch: pLimit(env.MEILI_CALL_CONCURRENCY),
  healthProbe: pLimit(HEALTH_PROBE_CONCURRENCY),
};

// Observability counters & gauge — see N1 in PR description. The active gauge
// is sampled lazily on Prometheus scrape via a `collect` hook so we don't
// touch a hot path on every call.
const meiliCallTimeoutsCounter = registerCounterWithLabels({
  name: 'meili_call_timeouts_total',
  help: 'Meilisearch wrapped-call timeouts by backend (search|metricsSearch|healthProbe)',
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
// failing, eliminating that accumulated wait. Each backend is tracked
// independently so a brownout on metricsSearch doesn't shed load from
// search.
//
// healthProbe is intentionally NOT under the breaker — health-probe is the
// canonical signal we need to keep responsive even when the circuit is open.
// (Failure mode: health-check returns false, not bypassed.)
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

const circuits: Record<MeiliBackend, Circuit> = {
  search: { state: 'CLOSED', failures: [], cooldownUntil: 0, trialInFlight: false },
  metricsSearch: { state: 'CLOSED', failures: [], cooldownUntil: 0, trialInFlight: false },
};

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
  if (
    c.state === 'CLOSED' &&
    failed &&
    c.failures.length >= env.MEILI_CIRCUIT_TRIP_THRESHOLD
  ) {
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
 * AbortSignal: meilisearch-js 0.x doesn't accept AbortSignal on .search() /
 * .getDocuments(), so the loser of the Promise.race below continues running
 * in the background. The orphan SDK promise will eventually settle when the
 * backend responds (or RSTs the connection) — at that point we've already
 * released the limiter slot, so the orphan does not block new callers.
 * fetchDocumentsAbortable() (above) is the cancellable path for the slow-
 * fetch flow; we don't try to force-cancel SDK calls from here — out of
 * scope.
 *
 * The queue is intentionally unbounded: a saturated queue means every call
 * will time out at MEILI_CALL_TIMEOUT_MS and reject naturally — the timeout
 * is the actual safety net. Adding a queue-depth cap on top adds a TOCTOU
 * race and a second failure mode without strengthening the guarantee.
 */
async function runWithLimiter<T>(
  key: LimiterKey,
  backendLabel: string,
  fn: () => Promise<T>,
  opts: { useTimeout?: boolean } = {}
): Promise<T> {
  const useTimeout = opts.useTimeout ?? true;

  // Circuit breaker gate — only for the two user-traffic backends. healthProbe
  // bypasses the circuit so the kubelet probe always issues a real request.
  let isTrial = false;
  if (key === 'search' || key === 'metricsSearch') {
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
    // Capture the SDK call so we can absorb a late rejection if the timeout
    // wins the race. meilisearch-js doesn't accept AbortSignal here, so the
    // SDK call keeps running and will eventually settle (success or RST).
    // Without this catch, a late rejection bubbles to `unhandledRejection` —
    // Node ≥15's default exit-on-unhandled would turn our brownout protection
    // into pod-crash amplification.
    const sdkCall = fn();
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
            reject(new MeiliCallTimeoutError('timeout'));
          }, env.MEILI_CALL_TIMEOUT_MS);
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
      if (key === 'search' || key === 'metricsSearch') {
        recordCallOutcome(key, isTrial, failedForCircuit);
      }
    }
  });
}

export function withMeili<T>(backend: MeiliBackend, fn: () => Promise<T>): Promise<T> {
  return runWithLimiter(backend, backend, fn);
}

/**
 * Health-probe variant of withMeili(). Uses a separate tiny limiter so a
 * user-traffic saturation on the main `metricsSearch` slot can't starve the
 * kubelet probe — that's exactly how /api/health flipped to slow-fail on
 * 2026-05-29.
 */
export function withMeiliHealthProbe<T>(fn: () => Promise<T>): Promise<T> {
  return runWithLimiter('healthProbe', 'healthProbe', fn);
}

// Methods on a Meilisearch index that issue a network call to the backend and
// therefore should run under withMeili(). Limited to read-side methods —
// write operations (updateDocuments, etc.) are intentionally NOT wrapped
// because they're driven by background indexing jobs which have their own
// retry loops and aren't part of the user-facing hot path.
const WRAPPED_INDEX_METHODS = new Set([
  'search',
  'searchGet',
  'getDocument',
  'getDocuments',
]);

/**
 * Wrap a MeiliSearch client so that read-side calls on returned indexes
 * (`search`, `getDocuments`, etc.) run under withMeili('search', ...).
 *
 * Why this exists: event-engine-common's feeds package takes an IMeilisearch
 * instance and calls `.search()` on it deep inside queryDocuments — alongside
 * Postgres / Redis / ClickHouse work in populateDocuments. We can't wrap
 * inside event-engine-common (that package is intentionally framework-free).
 * Wrapping at the client boundary scopes the limiter+timeout to JUST the
 * Meili SDK call, leaving DB/Redis/CH work outside the limiter.
 *
 * Implementation: Proxy `getIndex()` to return a Proxy over the index whose
 * read methods are wrapped with runWithLimiter.
 */
export function wrapMeilisearchClientWithLimiter(client: MeiliSearch): MeiliSearch {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'getIndex') {
        return async function wrappedGetIndex(indexName: string) {
          const index = await (target as any).getIndex(indexName);
          return wrapIndexWithLimiter(index);
        };
      }
      if (prop === 'index') {
        return function wrappedIndex(indexName: string) {
          const index = (target as any).index(indexName);
          return wrapIndexWithLimiter(index);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function wrapIndexWithLimiter<T extends object>(index: T): T {
  return new Proxy(index, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function' && typeof prop === 'string' && WRAPPED_INDEX_METHODS.has(prop)) {
        return function wrappedMethod(this: unknown, ...args: unknown[]) {
          return runWithLimiter('search', 'search', () => value.apply(target, args));
        };
      }
      return value;
    },
  });
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
