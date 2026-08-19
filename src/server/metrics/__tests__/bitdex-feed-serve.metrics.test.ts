import client from 'prom-client';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  BITDEX_QUERY_FAILURE_REASONS,
  BITDEX_SERVE_MODES,
  BITDEX_SERVE_OUTCOMES,
  ensureRegisterBitdexFeedServeMetrics,
  recordBitdexPrimaryResult,
  recordBitdexQueryFailure,
  type BitdexServeMode,
  type BitdexServeOutcome,
} from '../bitdex-feed-serve.metrics';

/**
 * 🔴 THE RUNTIME LABEL-NARROWING GUARDS, WHICH NOTHING ELSE REACHES.
 *
 * The module's header claims a hard cardinality bound of 14 series and says the
 * bound "rests on CODE, not on the erased types". That claim is only true if the
 * `is…` checks in the two `record…` functions actually run and actually drop an
 * unrecognised value. Nothing else in the suite can test them: every other caller
 * is type-checked, so it can only ever pass legal values, and BOTH guards
 * therefore survived deletion outright and survived `||` → `&&` on a fully green
 * run. A guard no test can reach is not a guard, it is a comment.
 *
 * These cases defeat the types deliberately — which is the only way in, and
 * exactly what a future refactor passing an un-narrowed string would do by
 * accident.
 *
 * The `||` → `&&` mutant needs BOTH single-bad-argument cases to die: under
 * `&&`, a call is dropped only when EVERY label is invalid, so a case with one
 * bad and one good label is the one that separates the two operators. Testing
 * only the both-invalid case would leave that mutant alive.
 */

type Readable = {
  get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }>;
};

async function seriesOf(name: string): Promise<Array<Record<string, string>>> {
  const metric = client.register.getSingleMetric(name) as unknown as Readable | undefined;
  if (!metric) return [];
  const { values } = await metric.get();
  return values.map((v) => v.labels);
}

/**
 * 🔴 SNAPSHOT EAGERLY. `Counter.get()` returns `Object.values(this.hashMap)` —
 * the LIVE child objects — and `inc` mutates `hashMap[hash].value` IN PLACE. So a
 * "before" handle that is only `.map()`ed AFTER the mutation reads post-increment
 * state, and every value comparison built on it is vacuously equal.
 *
 * That is not hypothetical: the first version of the relabel case below did
 * exactly that and the relabel mutant SURVIVED a fully green run — a test
 * certifying a guarantee it structurally could not observe, which is worse than
 * no test because it reads as coverage. The `Number(...)` copy here is the whole
 * fix, and the sibling suite (`bitdex-feed-source.test.ts`) already snapshots
 * this way.
 */
async function valuesByLabelKey(name: string): Promise<Record<string, number>> {
  const metric = client.register.getSingleMetric(name) as unknown as Readable | undefined;
  if (!metric) return {};
  const { values } = await metric.get();
  const snapshot: Record<string, number> = {};
  for (const v of values) {
    snapshot[`${v.labels.outcome ?? ''}|${v.labels.mode ?? ''}|${v.labels.reason ?? ''}`] = Number(
      v.value
    );
  }
  return snapshot;
}

const EXPECTED_RESULT_SERIES = BITDEX_SERVE_OUTCOMES.length * BITDEX_SERVE_MODES.length;

describe('the record functions drop label values outside their union', () => {
  beforeEach(() => {
    // Registration is idempotent, so this only ensures the seeded baseline
    // exists before each case rather than resetting anything.
    ensureRegisterBitdexFeedServeMetrics();
  });

  /**
   * 🔴 A POSITIVE CONTROL THAT CANNOT FAIL IS NOT ONE. The first version of this
   * asserted the `served|primary` SERIES EXISTS after a legal call — but
   * `seedAllSeries` pre-creates all 8 at registration, so it was true before the
   * call and stayed true with the `inc` deleted. Inert.
   *
   * Assert the VALUE MOVED instead. That is the property every "…is dropped"
   * case below depends on: they all conclude from a value NOT moving, which
   * means nothing until a value has been watched to move through this exact
   * read path.
   */
  it('POSITIVE CONTROL: a legal call MOVES its series value by exactly 1', async () => {
    const before = await valuesByLabelKey('bitdex_primary_result_total');

    recordBitdexPrimaryResult('served', 'primary');

    const after = await valuesByLabelKey('bitdex_primary_result_total');
    expect(after['served|primary|'] - before['served|primary|']).toBe(1);
    // And nothing else moved, so the read path resolves the right child.
    const moved = Object.keys(after).filter((k) => after[k] !== before[k]);
    expect(moved).toEqual(['served|primary|']);
  });

  it('POSITIVE CONTROL: a legal failure-reason call moves its series too', async () => {
    const before = await valuesByLabelKey('bitdex_query_failures_total');

    recordBitdexQueryFailure('http_4xx');

    const after = await valuesByLabelKey('bitdex_query_failures_total');
    expect(after['||http_4xx'] - before['||http_4xx']).toBe(1);
  });

  it('an unknown OUTCOME with a valid mode is dropped — no new series', async () => {
    recordBitdexPrimaryResult('totally_made_up' as BitdexServeOutcome, 'primary');

    const labels = await seriesOf('bitdex_primary_result_total');
    expect(labels).toHaveLength(EXPECTED_RESULT_SERIES);
    expect(labels.some((l) => l.outcome === 'totally_made_up')).toBe(false);
  });

  it('an unknown MODE with a valid outcome is dropped — no new series', async () => {
    recordBitdexPrimaryResult('served', 'canary' as BitdexServeMode);

    const labels = await seriesOf('bitdex_primary_result_total');
    expect(labels).toHaveLength(EXPECTED_RESULT_SERIES);
    expect(labels.some((l) => l.mode === 'canary')).toBe(false);
  });

  it('both labels unknown is dropped too', async () => {
    recordBitdexPrimaryResult('nope' as BitdexServeOutcome, 'nope' as BitdexServeMode);

    const labels = await seriesOf('bitdex_primary_result_total');
    expect(labels).toHaveLength(EXPECTED_RESULT_SERIES);
    expect(labels.some((l) => l.outcome === 'nope' || l.mode === 'nope')).toBe(false);
  });

  it('an unknown failure REASON is dropped — the cardinality bound rests here', async () => {
    recordBitdexQueryFailure('http_418' as (typeof BITDEX_QUERY_FAILURE_REASONS)[number]);

    const labels = await seriesOf('bitdex_query_failures_total');
    expect(labels).toHaveLength(BITDEX_QUERY_FAILURE_REASONS.length);
    expect(labels.some((l) => l.reason === 'http_418')).toBe(false);
  });

  /**
   * 🔴 THE CASE THE SERIES-COUNT CHECKS CANNOT MAKE. Relabelling a rejected value
   * to a plausible default — `if (!isBitdexServeOutcome(outcome)) outcome =
   * 'served'` — keeps the series count at exactly 8, so every `toHaveLength`
   * assertion above passes. It shows up ONLY as a moved VALUE on an existing
   * child, which is why this case reads values and why they must be snapshotted
   * eagerly (see `valuesByLabelKey`).
   */
  it('a dropped label value is NOT silently relabelled to a plausible default', async () => {
    const before = await valuesByLabelKey('bitdex_primary_result_total');

    recordBitdexPrimaryResult('bogus' as BitdexServeOutcome, 'primary');

    const after = await valuesByLabelKey('bitdex_primary_result_total');
    // No new series...
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(Object.keys(after)).toHaveLength(EXPECTED_RESULT_SERIES);
    // ...AND no existing series moved. A relabel to `served` would satisfy the
    // first check and fail this one, which is the whole point of the case.
    const moved = Object.keys(after).filter((k) => after[k] !== before[k]);
    expect(moved).toEqual([]);
  });

  it('an unknown REASON is not relabelled either', async () => {
    const before = await valuesByLabelKey('bitdex_query_failures_total');

    recordBitdexQueryFailure('http_418' as (typeof BITDEX_QUERY_FAILURE_REASONS)[number]);

    const after = await valuesByLabelKey('bitdex_query_failures_total');
    expect(Object.keys(after)).toHaveLength(BITDEX_QUERY_FAILURE_REASONS.length);
    expect(Object.keys(after).filter((k) => after[k] !== before[k])).toEqual([]);
  });
});
