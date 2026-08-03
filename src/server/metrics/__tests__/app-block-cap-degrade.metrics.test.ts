import client from 'prom-client';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ensureRegisterAppBlockRuntimeMetrics,
  recordAppCapLimitsDegrade,
  type AppCapLimitsDegradeReason,
} from '../app-block-runtime.metrics';

/**
 * The REAL prom-client side of the cap-limit degrade signal.
 *
 * The service-level test mocks this module, which proves the resolver CALLS the
 * emitter — it cannot prove the emitter produces a scrapeable series with the
 * right name and label. A metric name typo or a label-name mismatch would sail
 * through that test and produce an alert rule that silently never fires, which
 * is the exact failure class the signal exists to prevent. So this file drives
 * the real registry.
 */

const METRIC = 'civitai_app_block_cap_limits_degraded_total';

/** Read one `{reason}` series' current value from the default registry. */
async function readReason(reason: string): Promise<number> {
  const metric = client.register.getSingleMetric(METRIC) as
    | { get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }> }
    | undefined;
  if (!metric) return Number.NaN;
  const { values } = await metric.get();
  return values.find((v) => v.labels.reason === reason)?.value ?? 0;
}

beforeEach(() => {
  client.register.resetMetrics();
});

describe('civitai_app_block_cap_limits_degraded_total', () => {
  it('is registered on the default registry that /api/metrics scrapes', () => {
    ensureRegisterAppBlockRuntimeMetrics();
    expect(client.register.getSingleMetric(METRIC)).toBeDefined();
  });

  it.each([['db_error'], ['missing_row']] as Array<[AppCapLimitsDegradeReason]>)(
    'increments the `%s` series',
    async (reason) => {
      const before = await readReason(reason);
      recordAppCapLimitsDegrade(reason);
      expect(await readReason(reason)).toBe(before + 1);
    }
  );

  it('🔴 the two reasons are SEPARATE series — an operator can alert on infra alone', async () => {
    recordAppCapLimitsDegrade('db_error');
    recordAppCapLimitsDegrade('db_error');
    recordAppCapLimitsDegrade('missing_row');

    expect(await readReason('db_error')).toBe(2);
    expect(await readReason('missing_row')).toBe(1);
  });

  it('🔴 DECLARES exactly one label, `reason` — the cardinality bound is structural', async () => {
    // `missing_row` fires for ids that are by construction absent from the app
    // catalog, so an app_block_id label would be seeded from an unbounded
    // population — and prom-client retains every distinct label set in the Node
    // heap forever (the --max-old-space-size exit-139 OOM class). Attribution
    // lives in the log line instead.
    //
    // 🔴 Asserted against the DECLARED `labelNames`, not against the emitted
    // series. prom-client omits a declared-but-never-supplied label from the
    // output, so an inspection of `values[].labels` passes happily while the
    // metric is declared wide open — the next caller to pass an id then blows
    // the cardinality budget with nothing having failed. (Verified: mutating
    // labelNames to ['reason','app_block_id'] leaves a values-based check green.)
    ensureRegisterAppBlockRuntimeMetrics();
    const metric = client.register.getSingleMetric(METRIC) as unknown as {
      labelNames: string[];
    };
    expect([...metric.labelNames].sort()).toEqual(['reason']);

    // …and the emitted series carries only that label too.
    recordAppCapLimitsDegrade('db_error');
    const emitted = client.register.getSingleMetric(METRIC) as unknown as {
      get(): Promise<{ values: Array<{ labels: Record<string, string> }> }>;
    };
    const { values } = await emitted.get();
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(Object.keys(v.labels)).toEqual(['reason']);
    }
  });

  it('is idempotent to register — a double module import does not throw', () => {
    // prom-client throws on a duplicate metric name; Next.js can import a module
    // twice (hot reload / route bundling), so the get-or-create guard is what
    // keeps that from taking the process down.
    expect(() => {
      ensureRegisterAppBlockRuntimeMetrics();
      ensureRegisterAppBlockRuntimeMetrics();
    }).not.toThrow();
  });

  it('appears in the scrape output with its help text', async () => {
    recordAppCapLimitsDegrade('missing_row');
    const scrape = await client.register.metrics();
    expect(scrape).toContain(METRIC);
    expect(scrape).toContain(`${METRIC}{reason="missing_row"}`);
  });
});
