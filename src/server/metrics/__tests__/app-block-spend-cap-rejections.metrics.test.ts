import client from 'prom-client';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  APP_SPEND_CAP_REJECTION_REASONS,
  ensureRegisterAppBlockRuntimeMetrics,
  recordAppSpendCapRejection,
  type AppSpendCapRejectionReason,
} from '../app-block-runtime.metrics';

/**
 * The REAL prom-client side of the per-app spend-cap REJECTION signal.
 *
 * The service-level test (app-spend-cap-rejection-signal.test.ts) mocks this
 * module, which proves `reserveAppSpend` CALLS the emitter on every deny — it
 * cannot prove the emitter produces a scrapeable series with the right name and
 * the right label. A metric-name typo or a label-name mismatch sails straight
 * through that test and yields an alert rule that silently never fires, which is
 * the exact failure class this signal exists to prevent. So this file drives the
 * real default registry.
 *
 * 🔴 The cardinality bound is the load-bearing property here. This counter emits
 * once per DENIED submit with nothing caching or rate-limiting it, across ~130
 * scraped pods, and prom-client retains every distinct label set in the Node heap
 * for the process lifetime. One label over a 3-value code-owned union = 3 series,
 * total, forever. Widening it is a code change that has to get past these tests.
 */

const METRIC = 'civitai_app_block_spend_cap_rejections_total';

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
  // `clear()` (not `resetMetrics()`): one case deliberately registers a POISONED
  // metric under this name, and a values-only reset would leak it into every
  // later case. A fully empty default registry makes each case order-independent.
  client.register.clear();
});

describe('civitai_app_block_spend_cap_rejections_total', () => {
  it('is registered on the default registry that /api/metrics scrapes', () => {
    ensureRegisterAppBlockRuntimeMetrics();
    expect(client.register.getSingleMetric(METRIC)).toBeDefined();
  });

  it.each(APP_SPEND_CAP_REJECTION_REASONS.map((r) => [r] as [AppSpendCapRejectionReason]))(
    'increments the `%s` series',
    async (reason) => {
      recordAppSpendCapRejection(reason);
      expect(await readReason(reason)).toBe(1);
    }
  );

  it('🔴 the three reasons are SEPARATE series — infra denials never read as abuse denials', async () => {
    // `unavailable` is not an abuse signal at all: it is a Redis/limit-resolution
    // failure that denies EVERY app at once. Folding it in with `daily`/`velocity`
    // would make a Redis blip look like a wave of abusive apps, which is the
    // wrong incident and the wrong response.
    recordAppSpendCapRejection('daily');
    recordAppSpendCapRejection('velocity');
    recordAppSpendCapRejection('velocity');
    recordAppSpendCapRejection('unavailable');

    expect(await readReason('daily')).toBe(1);
    expect(await readReason('velocity')).toBe(2);
    expect(await readReason('unavailable')).toBe(1);
  });

  it('🔴 DECLARES exactly one label, `reason` — the cardinality bound is structural', async () => {
    // 🔴 Asserted against the DECLARED `labelNames`, NOT against the emitted
    // series. prom-client omits a declared-but-never-supplied label from its
    // output, so an inspection of `values[].labels` stays green while the metric
    // is declared wide open — and the next caller to pass an `app_block_id` then
    // blows the cardinality budget with nothing ever having failed.
    ensureRegisterAppBlockRuntimeMetrics();
    const metric = client.register.getSingleMetric(METRIC) as unknown as { labelNames: string[] };
    expect([...metric.labelNames].sort()).toEqual(['reason']);

    // …and the emitted series carries only that label too.
    recordAppSpendCapRejection('daily');
    const emitted = client.register.getSingleMetric(METRIC) as unknown as {
      get(): Promise<{ values: Array<{ labels: Record<string, string> }> }>;
    };
    const { values } = await emitted.get();
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(Object.keys(v.labels)).toEqual(['reason']);
    }
  });

  it('🔴 the reason union is EXACTLY these three values — 3 series is the whole budget', () => {
    // Literal, not derived: this is the number an operator's cardinality budget
    // is sized against, and the union is simultaneously the metric label AND
    // `ReserveAppSpendResult['reason']`, so a fourth value silently added on the
    // service side has to come through here.
    expect([...APP_SPEND_CAP_REJECTION_REASONS]).toEqual(['daily', 'velocity', 'unavailable']);
  });

  it('🔴 emits AT MOST 3 series no matter how many rejections land', async () => {
    // The end-state assertion the label-name check implies: drive 300 rejections
    // across every reason and the scrape still carries 3 lines for this metric.
    for (let i = 0; i < 100; i++) {
      for (const reason of APP_SPEND_CAP_REJECTION_REASONS) recordAppSpendCapRejection(reason);
    }
    const metric = client.register.getSingleMetric(METRIC) as unknown as {
      get(): Promise<{ values: Array<{ labels: Record<string, string> }> }>;
    };
    const { values } = await metric.get();
    expect(values).toHaveLength(3);
    expect(await readReason('daily')).toBe(100);
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

  it('appears in the scrape output under its exact name', async () => {
    recordAppSpendCapRejection('velocity');
    const scrape = await client.register.metrics();
    expect(scrape).toContain(METRIC);
    expect(scrape).toContain(`${METRIC}{reason="velocity"}`);
  });

  it('🔴 the emitter NEVER throws — a broken registry cannot turn a 402 into a 500', () => {
    // Poison the default registry: something is already registered under this
    // name with a DIFFERENT labelset (the shape a name collision takes). The
    // get-or-create guard hands that instance back, and prom-client then throws
    // on `.inc({ reason })` because `reason` was never declared on it.
    //
    // Without the emitter's own try/catch that throw lands on the deny path of a
    // generation submit — i.e. the instrumentation would convert a working abuse
    // guardrail into a 500.
    new client.Counter({
      name: METRIC,
      help: 'poisoned duplicate with an incompatible labelset',
      labelNames: ['unrelated'],
      registers: [client.register],
    });

    expect(() => recordAppSpendCapRejection('daily')).not.toThrow();
  });

  it('the poisoned-registry case really would throw unguarded (the guard is reachable)', () => {
    // Proves the case above is not vacuous: the underlying prom-client call DOES
    // throw, so `not.toThrow()` there is testing the guard rather than an inert
    // no-op. Without this, deleting the try/catch could leave the case green
    // because the mechanism never actually failed.
    const poisoned = new client.Counter({
      name: METRIC,
      help: 'poisoned duplicate with an incompatible labelset',
      labelNames: ['unrelated'],
      registers: [client.register],
    });
    expect(() => poisoned.inc({ reason: 'daily' })).toThrow();
  });
});
