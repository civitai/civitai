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
 */
export async function fetchDocumentsAbortable<T>(
  indexName: string,
  params: DocumentsQuery<T>,
  options: { host: string; apiKey?: string; signal?: AbortSignal; actor?: string }
): Promise<ResourceResults<T[]>> {
  const { host, apiKey, signal, actor } = options;
  const url = `${host}/indexes/${indexName}/documents/fetch`;
  const urlAttr = safeUrl(url);
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
  fn: () => Promise<T>
): Promise<T> {
  const endTimer = meiliCallDurationHistogram.startTimer({ backend: backendLabel });
  return limiters[key](async () => {
    let timer: NodeJS.Timeout | undefined;
    // Capture the SDK call so we can absorb a late rejection if the timeout
    // wins the race. meilisearch-js doesn't accept AbortSignal here, so the
    // SDK call keeps running and will eventually settle (success or RST).
    // Without this catch, a late rejection bubbles to `unhandledRejection` —
    // Node ≥15's default exit-on-unhandled would turn our brownout protection
    // into pod-crash amplification.
    const sdkCall = fn();
    sdkCall.catch(() => undefined);
    try {
      return await Promise.race([
        sdkCall,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            meiliCallTimeoutsCounter.inc({ backend: backendLabel });
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
