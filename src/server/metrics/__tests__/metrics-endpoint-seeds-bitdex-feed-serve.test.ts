import client from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
// Registers the db mock; `/api/metrics` pulls in `~/server/db/client` at module
// load. Imported for the side effect, exactly as the sibling seam test does.
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * 🔴 THE SEAM: does loading the module that SERVES the scrape actually register
 * and seed `bitdex_primary_result_total` and `bitdex_query_failures_total`?
 * (#3930)
 *
 * Seeding every label combination to 0 is inert on its own.
 * `ensureRegisterBitdexFeedServeMetrics` has no caller outside its own module,
 * and the only production paths in are `recordBitdexPrimaryResult` /
 * `recordBitdexQueryFailure` — which by definition run only AFTER the event has
 * happened. So without a module-scope call from `src/pages/api/metrics.ts`,
 * `…{outcome="fallback_error"}` reads `no data` on a process until its first
 * failure: indistinguishable from an unwired instrument, on the exact series
 * this issue exists to create and whose healthy value is zero. Two components,
 * each fine alone, broken together — which is why this test loads the endpoint
 * module rather than the metrics module.
 *
 * That failure is not hypothetical for this metric family. The older
 * `bitdex_shadow_*` counters in `~/server/bitdex/compare.ts` use the bare
 * registration pattern with no seeding and no endpoint call, and a current read
 * of them returns `no data` despite history in the index.
 *
 * Modelled on `metrics-endpoint-seeds-substitutions.test.ts`, including the
 * reason it asserts BEHAVIOURALLY (does the series exist after the module
 * loads?) rather than by parsing `metrics.ts` for a call: a source check
 * false-fails correct refactors (`void f()`, an aliased import, a relative
 * specifier) while passing an `import type` plus a call.
 */

// `endpoint-helpers` spreads `env.TRPC_ORIGINS` at module load; stub the wrapper
// itself so none of that graph is needed.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

const RESULT_METRIC = 'bitdex_primary_result_total';
const FAILURES_METRIC = 'bitdex_query_failures_total';

type Readable = {
  get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }>;
};

describe('/api/metrics registers + seeds the BitDex serve-outcome counters at module load', () => {
  it('NEGATIVE CONTROL: both counters are absent before the page module is loaded', () => {
    expect(client.register.getSingleMetric(RESULT_METRIC)).toBeUndefined();
    expect(client.register.getSingleMetric(FAILURES_METRIC)).toBeUndefined();
  });

  it('🔴 after loading the page module, all 14 outcome × mode series exist at 0', async () => {
    await import('~/pages/api/metrics');

    const metric = client.register.getSingleMetric(RESULT_METRIC) as unknown as
      | Readable
      | undefined;
    expect(metric).toBeDefined();

    const { values } = await metric!.get();
    // Derived from the unions, not hardcoded: an 8th outcome or a 3rd mode must
    // be seeded too, and this must fail until it is.
    const { BITDEX_SERVE_MODES, BITDEX_SERVE_OUTCOMES } = await import(
      '~/server/metrics/bitdex-feed-serve.metrics'
    );
    expect(values).toHaveLength(BITDEX_SERVE_OUTCOMES.length * BITDEX_SERVE_MODES.length);
    expect(values.every((v) => v.value === 0)).toBe(true);

    // Named explicitly. `fallback_error` is the series #3930 adds and the one an
    // alert queries first; its presence-at-zero is the entire point, because its
    // healthy value and its unwired value are the same number.
    for (const mode of BITDEX_SERVE_MODES) {
      expect(
        values.some((v) => v.labels.outcome === 'fallback_error' && v.labels.mode === mode)
      ).toBe(true);
    }
    // Every declared combination present, so a partially-seeded loop fails here
    // rather than at whichever combination happened to be checked by hand.
    for (const outcome of BITDEX_SERVE_OUTCOMES) {
      for (const mode of BITDEX_SERVE_MODES) {
        expect(values.some((v) => v.labels.outcome === outcome && v.labels.mode === mode)).toBe(
          true
        );
      }
    }
  });

  it('🔴 and all 6 failure-reason series exist at 0', async () => {
    await import('~/pages/api/metrics');

    const metric = client.register.getSingleMetric(FAILURES_METRIC) as unknown as
      | Readable
      | undefined;
    expect(metric).toBeDefined();

    const { values } = await metric!.get();
    const { BITDEX_QUERY_FAILURE_REASONS } = await import(
      '~/server/metrics/bitdex-feed-serve.metrics'
    );
    expect(values).toHaveLength(BITDEX_QUERY_FAILURE_REASONS.length);
    expect(values.every((v) => v.value === 0)).toBe(true);
    for (const reason of BITDEX_QUERY_FAILURE_REASONS) {
      expect(values.some((v) => v.labels.reason === reason)).toBe(true);
    }
  });
});
