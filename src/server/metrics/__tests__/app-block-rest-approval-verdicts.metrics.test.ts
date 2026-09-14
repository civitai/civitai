import client from 'prom-client';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  APP_BLOCK_REST_APPROVAL_VERDICT_REASONS,
  ensureRegisterAppBlockRuntimeMetrics,
  recordBlockRestApprovalVerdict,
  type AppBlockRestApprovalVerdictReason,
} from '../app-block-runtime.metrics';

/**
 * The REAL prom-client side of the `withBlockScope` approved-status GATE verdict signal.
 *
 * WHY THIS FILE EXISTS, in the words its two siblings already use for the same class:
 * the middleware-level test (`block-scope.approved-gate.test.ts`) `vi.mock`s this module,
 * which proves the gate CALLS the emitter with the right reason on each verdict — it
 * cannot prove the emitter produces a SCRAPEABLE SERIES with the right name and the right
 * label. A metric-name typo or a label-name mismatch sails straight through that test and
 * yields an alert rule that silently never fires.
 *
 * 🔴 AND THIS EMITTER IS THE WORST CASE FOR THAT, for two compounding reasons:
 *   - It is `try { … } catch {}` by design (a metrics error must never convert a verdict
 *     the gate already settled into a 500), so a registration or label defect produces
 *     ZERO and never throws. Nothing anywhere would go red.
 *   - A flat zero is ALSO the healthy steady state — an approved app never reaches the
 *     emitter at all. So "the counter is inert" and "the fleet is fine" are the same
 *     observation, and no amount of watching the series can separate them.
 *
 * That combination is why the check has to be a real-registry SCRAPE and not an
 * inspection of the caller. It is also the load-bearing half of this gate's own
 * justification for SERVING a `not_found` rather than refusing it: the argument is "it is
 * OBSERVED instead", and an emitter that does not emit voids it.
 *
 * 🔴 The cardinality bound is the other load-bearing property, same as the siblings. This
 * counter fires once per non-ok REST request with nothing caching or rate-limiting it,
 * across every scraped pod, and prom-client retains every distinct label set in the Node
 * heap for the process lifetime. One label over a 3-value code-owned union = 3 series,
 * total, forever. Widening it is a code change that has to get past these tests.
 */

const METRIC = 'civitai_app_block_rest_approval_verdicts_total';

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
  // `clear()` (not `resetMetrics()`): one case deliberately registers a POISONED metric
  // under this name, and a values-only reset would leak it into every later case. A fully
  // empty default registry makes each case order-independent.
  client.register.clear();
});

describe('civitai_app_block_rest_approval_verdicts_total', () => {
  it('is registered on the default registry that /api/metrics scrapes', () => {
    ensureRegisterAppBlockRuntimeMetrics();
    expect(client.register.getSingleMetric(METRIC)).toBeDefined();
  });

  it.each(
    APP_BLOCK_REST_APPROVAL_VERDICT_REASONS.map((r) => [r] as [AppBlockRestApprovalVerdictReason])
  )('increments the `%s` series', async (reason) => {
    recordBlockRestApprovalVerdict(reason);
    expect(await readReason(reason)).toBe(1);
  });

  /**
   * 🔴 THE SPLIT IS THE WHOLE VALUE OF THIS SIGNAL, and it is a sharper claim here than on
   * the sibling counters, because the three reasons do not even agree on whether the
   * request was served:
   *
   *   not_approved  — REFUSED 403. The gate working; the only branch carrying its value.
   *   not_found     — SERVED. A healthy app; the false-positive channel.
   *   lookup_failed — REFUSED 503. Infra, not policy.
   *
   * `sum(rate(...))` across the label adds requests that were turned away to requests that
   * were served, so an operator who cannot split by `reason` has a number with no meaning.
   * Three separate series is what makes the split possible at all.
   */
  it('🔴 the three reasons are SEPARATE series — a served not_found never reads as a refusal', async () => {
    recordBlockRestApprovalVerdict('not_approved');
    recordBlockRestApprovalVerdict('not_found');
    recordBlockRestApprovalVerdict('not_found');
    recordBlockRestApprovalVerdict('lookup_failed');

    expect(await readReason('not_approved')).toBe(1);
    expect(await readReason('not_found')).toBe(2);
    expect(await readReason('lookup_failed')).toBe(1);
  });

  it('🔴 DECLARES exactly one label, `reason` — the cardinality bound is structural', async () => {
    // 🔴 Asserted against the DECLARED `labelNames`, NOT against the emitted series.
    // prom-client omits a declared-but-never-supplied label from its output, so an
    // inspection of `values[].labels` stays green while the metric is declared wide open —
    // and the next caller to pass an `app_block_id` then blows the cardinality budget with
    // nothing ever having failed. That label is deliberately absent here: the ids live in
    // the caller's log line instead, which is why the `not_found` branch logs them.
    ensureRegisterAppBlockRuntimeMetrics();
    const metric = client.register.getSingleMetric(METRIC) as unknown as { labelNames: string[] };
    expect([...metric.labelNames].sort()).toEqual(['reason']);

    // …and the emitted series carries only that label too.
    recordBlockRestApprovalVerdict('not_approved');
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
    // Literal, not derived: this is the number an operator's cardinality budget is sized
    // against, and the union is simultaneously the metric label AND the non-`ok` half of
    // `AppBlockApprovalVerdict | 'lookup_failed'`, so a fourth verdict added on the service
    // side has to come through here.
    expect([...APP_BLOCK_REST_APPROVAL_VERDICT_REASONS]).toEqual([
      'not_approved',
      'not_found',
      'lookup_failed',
    ]);
  });

  it('🔴 emits AT MOST 3 series no matter how many verdicts land', async () => {
    // The end-state assertion the label-name check implies: drive 300 verdicts across
    // every reason and the scrape still carries 3 lines for this metric.
    for (let i = 0; i < 100; i++) {
      for (const reason of APP_BLOCK_REST_APPROVAL_VERDICT_REASONS) {
        recordBlockRestApprovalVerdict(reason);
      }
    }
    const metric = client.register.getSingleMetric(METRIC) as unknown as {
      get(): Promise<{ values: Array<{ labels: Record<string, string> }> }>;
    };
    const { values } = await metric.get();
    expect(values).toHaveLength(3);
    expect(await readReason('not_found')).toBe(100);
  });

  it('is idempotent to register — a double module import does not throw', () => {
    // prom-client throws on a duplicate metric name; Next.js can import a module twice
    // (hot reload / route bundling), so the get-or-create guard is what keeps that from
    // taking the process down.
    expect(() => {
      ensureRegisterAppBlockRuntimeMetrics();
      ensureRegisterAppBlockRuntimeMetrics();
    }).not.toThrow();
  });

  /**
   * 🔴 THE ASSERTION AN ALERT RULE ACTUALLY DEPENDS ON — the exact scrape text, name and
   * label key and label VALUE, for all three reasons. Every other case in this file would
   * still pass if the metric were renamed, because they all reach it through
   * `getSingleMetric(METRIC)` with the same constant; this one reads the rendered
   * exposition the scraper sees.
   */
  it.each(APP_BLOCK_REST_APPROVAL_VERDICT_REASONS)(
    'appears in the scrape output as %s{reason="…"} under its exact name',
    async (reason) => {
      recordBlockRestApprovalVerdict(reason);
      const scrape = await client.register.metrics();
      expect(scrape).toContain(METRIC);
      expect(scrape).toContain(`${METRIC}{reason="${reason}"} 1`);
    }
  );

  it('🔴 the emitter NEVER throws — a broken registry cannot turn a 403 into a 500', () => {
    // Poison the default registry: something is already registered under this name with a
    // DIFFERENT labelset (the shape a name collision takes). The get-or-create guard hands
    // that instance back, and prom-client then throws on `.inc({ reason })` because
    // `reason` was never declared on it.
    //
    // Without the emitter's own try/catch that throw lands in the middle of the gate —
    // i.e. the instrumentation would convert a verdict the gate had already settled (403,
    // 503, or a deliberate SERVE) into an uncaught 500.
    new client.Counter({
      name: METRIC,
      help: 'poisoned duplicate with an incompatible labelset',
      labelNames: ['unrelated'],
      registers: [client.register],
    });

    expect(() => recordBlockRestApprovalVerdict('not_approved')).not.toThrow();
  });

  it('the poisoned-registry case really would throw unguarded (the guard is reachable)', () => {
    // Proves the case above is not vacuous: the underlying prom-client call DOES throw, so
    // `not.toThrow()` there is testing the guard rather than an inert no-op. Without this,
    // deleting the try/catch could leave the case green because the mechanism never
    // actually failed.
    const poisoned = new client.Counter({
      name: METRIC,
      help: 'poisoned duplicate with an incompatible labelset',
      labelNames: ['unrelated'],
      registers: [client.register],
    });
    expect(() => poisoned.inc({ reason: 'not_approved' })).toThrow();
  });
});
