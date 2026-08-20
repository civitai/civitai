// Flipt eval-cache observability (prom-client).
//
// WHY THIS EXISTS: the per-eval TTL cache in `@civitai/flipt` had NO exported
// telemetry. It tracked `hit` internally and threw the result away, so from
// outside the process the cache was a black box — you could not tell a cache
// doing its job from one thrashing, and there was no way to decide between the
// two knobs it has (`FLIPT_EVAL_CACHE_TTL_MS`, and the `evalCacheMaxEntries`
// ceiling) other than by guessing.
//
// 🔴 THE POINT IS THE MISS BREAKDOWN, NOT THE HIT RATE. A hit rate alone is
// consistent with two situations that have OPPOSITE remedies:
//
//   * misses dominated by `expired_misses_total` — the key WAS cached and its
//     TTL lapsed. TTL-bound: a longer TTL converts those misses into hits.
//   * `rotations_total` climbing — inserts are overflowing `maxEntries`, so a
//     whole generation is discarded. Capacity-bound: a longer TTL recovers
//     NOTHING, because entries are evicted before they can ever expire. The
//     ceiling is the knob.
//
// Raising the TTL against a capacity-bound cache is an inert change that looks
// like a fix, which is precisely what this metric exists to prevent. Read the
// breakdown before touching either knob.
//
// CARDINALITY: one label, `cache`, with exactly two values (`boolean`,
// `variant`) — one per TtlCache instance the client owns. Fixed, not
// input-derived, so it cannot grow.
//
// COUNTER SEMANTICS: the source values are process-lifetime cumulative and
// monotonic, so these are real counters and `rate()`/`increase()` are valid. The
// `collect()` callbacks reset-then-inc to mirror the in-process value rather
// than double-counting on each scrape. `size` is instantaneous and is therefore
// a Gauge, not a counter.
//
// prom-client GOTCHA: Next.js can import a module twice (hot reload / route
// bundling) and prom-client throws on a duplicate metric name. Every getter
// below is a get-or-create guard against the DEFAULT global registry
// (`client.register`), matching ~/server/metrics/app-block-runtime.metrics.ts.
import client from 'prom-client';
import { getFliptCacheStats } from '~/server/flipt/client';

const CACHE_LABEL = 'cache' as const;

function counter(
  name: string,
  help: string,
  pick: (s: ReturnType<typeof getFliptCacheStats>) => {
    boolean: number;
    variant: number;
  }
) {
  const existing = client.register.getSingleMetric(name);
  if (existing) return existing as client.Counter<string>;
  return new client.Counter({
    name,
    help,
    labelNames: [CACHE_LABEL],
    registers: [client.register],
    collect() {
      const v = pick(getFliptCacheStats());
      // reset-then-inc: mirror the in-process cumulative value exactly. Without
      // the reset each scrape would ADD the running total to itself.
      this.reset();
      this.labels('boolean').inc(v.boolean);
      this.labels('variant').inc(v.variant);
    },
  });
}

export const fliptEvalCacheHits = counter(
  'civitai_app_flipt_eval_cache_hits_total',
  'Flipt eval-cache reads served from cache, by cache kind.',
  (s) => ({ boolean: s.boolean.hits, variant: s.variant.hits })
);

export const fliptEvalCacheMisses = counter(
  'civitai_app_flipt_eval_cache_misses_total',
  'Flipt eval-cache reads that fell through to a wasm evaluation, by cache kind. ' +
    'Includes expired misses — see civitai_app_flipt_eval_cache_expired_misses_total.',
  (s) => ({ boolean: s.boolean.misses, variant: s.variant.misses })
);

export const fliptEvalCacheExpiredMisses = counter(
  'civitai_app_flipt_eval_cache_expired_misses_total',
  'Subset of misses where the key WAS cached but its TTL had lapsed. A high share ' +
    'means the cache is TTL-bound and a longer FLIPT_EVAL_CACHE_TTL_MS would convert ' +
    'these into hits.',
  (s) => ({ boolean: s.boolean.expiredMisses, variant: s.variant.expiredMisses })
);

export const fliptEvalCacheRotations = counter(
  'civitai_app_flipt_eval_cache_rotations_total',
  'Generation rotations, i.e. how often the entry ceiling overflowed. Non-trivial ' +
    'rates mean the cache is CAPACITY-bound: entries are evicted before they can ' +
    'expire, so raising the TTL recovers nothing and the ceiling is the knob.',
  (s) => ({ boolean: s.boolean.rotations, variant: s.variant.rotations })
);

export const fliptEvalCacheSize = (() => {
  const name = 'civitai_app_flipt_eval_cache_entries';
  const existing = client.register.getSingleMetric(name);
  if (existing) return existing as client.Gauge<string>;
  return new client.Gauge({
    name,
    help:
      'Live Flipt eval-cache entries across both generations, by cache kind. ' +
      'Instantaneous. Compare against the entry ceiling to see how close to ' +
      'rotation the cache is running.',
    labelNames: [CACHE_LABEL],
    registers: [client.register],
    collect() {
      const s = getFliptCacheStats();
      this.labels('boolean').set(s.boolean.size);
      this.labels('variant').set(s.variant.size);
    },
  });
})();
