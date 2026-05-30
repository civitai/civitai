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
 * Fetch documents via a raw HTTP call that honors an AbortSignal. The
 * meilisearch-js client we're on (<=0.34) doesn't expose signal on
 * getDocuments, so we hit the /documents/fetch endpoint directly when a
 * cancellable request is needed (e.g. the image feed's slow-fetch path).
 *
 * Wrapped under runWithLimiter('metricsSearch', useTimeout=false) so a
 * backend brownout shares the same per-backend semaphore + circuit breaker
 * gate as the SDK path. The caller's AbortSignal remains the deadline (we
 * pass useTimeout=false to avoid a double race against the 2.5s timer).
 */
export async function fetchDocumentsAbortable<T>(
  indexName: string,
  params: DocumentsQuery<T>,
  options: { host: string; apiKey?: string; signal?: AbortSignal; actor?: string }
): Promise<ResourceResults<T[]>> {
  const { host, apiKey, signal, actor } = options;
  const url = `${host}/indexes/${indexName}/documents/fetch`;
  const urlAttr = safeUrl(url);
  return runWithLimiter(
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
        throw new Error(`Meilisearch fetch failed (${res.status}): ${text}`);
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
    // Caller's AbortSignal is the deadline; skip the wrapper's 2.5s timer to
    // avoid a double-timeout race. The circuit breaker still applies.
    { useTimeout: false }
  );
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
      meiliCallTimeoutsCounter.inc({ backend: backendLabel });
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
      endTimer();
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
