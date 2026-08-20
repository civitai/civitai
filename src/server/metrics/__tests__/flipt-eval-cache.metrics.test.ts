import client from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The REAL prom-client side of the Flipt eval-cache signal.
 *
 * The package-level tests prove `TtlCache` COUNTS correctly; they cannot prove the
 * counts reach a scrapeable series with the right name and label. A metric-name
 * typo, a missing `reset()` in `collect()`, or a label mismatch would pass those
 * tests and produce a metric that is silently wrong — on an instrument whose whole
 * job is to decide between two config knobs. So this file drives the real registry.
 *
 * `~/server/flipt/client` is mocked because importing it constructs a real wasm
 * client and reads env; the unit under test here is the prom-client wiring, and
 * the stats shape is the seam between them.
 */

const stats = {
  boolean: { hits: 7, misses: 5, expiredMisses: 3, rotations: 2, size: 11 },
  variant: { hits: 1, misses: 4, expiredMisses: 0, rotations: 9, size: 6 },
};

vi.mock('~/server/flipt/client', () => ({
  getFliptCacheStats: () => stats,
}));

/**
 * Read one `{cache}` series' current value from the default registry.
 *
 * 🔴 Returns NaN — never 0 — when the metric or the label is missing. A `?? 0`
 * here makes every assertion whose expected value is 0 pass whether or not the
 * series exists, and one of the fixtures below legitimately expects 0. That is
 * the absent-vs-zero ambiguity this whole metric exists to remove, so it must not
 * be reintroduced in the test that guards it. (Caught by mutation: gating the
 * `variant` inc on a non-zero value SURVIVED against a `?? 0` reader.)
 */
async function read(metricName: string, cache: string): Promise<number> {
  const metric = client.register.getSingleMetric(metricName) as
    | { get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }> }
    | undefined;
  if (!metric) return Number.NaN;
  const { values } = await metric.get();
  const found = values.find((v) => v.labels.cache === cache);
  return found ? found.value : Number.NaN;
}

beforeEach(() => {
  client.register.resetMetrics();
});

/**
 * 🔴 THE SEAM, and it is the one this file previously left open. Importing
 * `../flipt-eval-cache.metrics` directly proves the module registers — it CANNOT
 * prove anything reaches it in production. These counters have no emitter on the
 * request path; the only way they exist on a pod is the module-scope side-effect
 * import in `src/pages/api/metrics.ts`. Deleting that line left the whole
 * `src/server/metrics/` suite green (131/131), i.e. registered-but-unreached —
 * this repo's documented #1 metric-death mode, and exactly what the sibling seam
 * tests for substitutions and bitdex-feed-serve exist to catch.
 *
 * So this asserts against the module that SERVES the scrape, not the one that
 * declares the metric. Behavioural on purpose: parsing `metrics.ts` for the
 * import string would be a spelled guard, satisfiable by a comment.
 */
describe('flipt eval-cache metrics — the /api/metrics seam', () => {
  it('is registered by loading the module that serves the scrape', async () => {
    await import('~/pages/api/metrics');
    for (const name of [
      'civitai_app_flipt_eval_cache_hits_total',
      'civitai_app_flipt_eval_cache_misses_total',
      'civitai_app_flipt_eval_cache_expired_misses_total',
      'civitai_app_flipt_eval_cache_rotations_total',
      'civitai_app_flipt_eval_cache_entries',
    ]) {
      expect(client.register.getSingleMetric(name), name).toBeDefined();
    }
  });
});

describe('flipt eval-cache metrics', () => {
  it('registers every series on the default registry that /api/metrics scrapes', async () => {
    await import('../flipt-eval-cache.metrics');
    for (const name of [
      'civitai_app_flipt_eval_cache_hits_total',
      'civitai_app_flipt_eval_cache_misses_total',
      'civitai_app_flipt_eval_cache_expired_misses_total',
      'civitai_app_flipt_eval_cache_rotations_total',
      'civitai_app_flipt_eval_cache_entries',
    ]) {
      expect(client.register.getSingleMetric(name), name).toBeDefined();
    }
  });

  // Pins the values PER CACHE KIND. The two fixtures are deliberately distinct in
  // every field (and distinct BETWEEN kinds), so a wiring bug that reads the wrong
  // stat, or reports the boolean cache's numbers for both labels, cannot pass by
  // coincidence.
  it('reports each cache kind separately, with the right stat in the right series', async () => {
    await import('../flipt-eval-cache.metrics');
    await client.register.metrics(); // force collect()

    expect(await read('civitai_app_flipt_eval_cache_hits_total', 'boolean')).toBe(7);
    expect(await read('civitai_app_flipt_eval_cache_hits_total', 'variant')).toBe(1);
    expect(await read('civitai_app_flipt_eval_cache_misses_total', 'boolean')).toBe(5);
    expect(await read('civitai_app_flipt_eval_cache_misses_total', 'variant')).toBe(4);
    expect(await read('civitai_app_flipt_eval_cache_expired_misses_total', 'boolean')).toBe(3);
    expect(await read('civitai_app_flipt_eval_cache_expired_misses_total', 'variant')).toBe(0);
    expect(await read('civitai_app_flipt_eval_cache_rotations_total', 'boolean')).toBe(2);
    expect(await read('civitai_app_flipt_eval_cache_rotations_total', 'variant')).toBe(9);
    expect(await read('civitai_app_flipt_eval_cache_entries', 'boolean')).toBe(11);
    expect(await read('civitai_app_flipt_eval_cache_entries', 'variant')).toBe(6);
  });

  // 🔴 The regression this guards: `collect()` on a Counter must reset before
  // inc-ing, or every scrape ADDS the running total to itself and the exported
  // series grows quadratically while the real cache is idle. Scraping twice with
  // a CONSTANT source is the control — the value must not move.
  it('does not double-count across repeated scrapes', async () => {
    await import('../flipt-eval-cache.metrics');

    await client.register.metrics();
    const first = await read('civitai_app_flipt_eval_cache_hits_total', 'boolean');
    await client.register.metrics();
    await client.register.metrics();
    const third = await read('civitai_app_flipt_eval_cache_hits_total', 'boolean');

    expect(first).toBe(7);
    expect(third).toBe(7);
  });
});
