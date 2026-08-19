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

const EXPECTED_RESULT_SERIES = BITDEX_SERVE_OUTCOMES.length * BITDEX_SERVE_MODES.length;

describe('the record functions drop label values outside their union', () => {
  beforeEach(() => {
    // Registration is idempotent, so this only ensures the seeded baseline
    // exists before each case rather than resetting anything.
    ensureRegisterBitdexFeedServeMetrics();
  });

  it('POSITIVE CONTROL: a legal call DOES create/keep its series', async () => {
    recordBitdexPrimaryResult('served', 'primary');
    const labels = await seriesOf('bitdex_primary_result_total');
    expect(labels).toHaveLength(EXPECTED_RESULT_SERIES);
    expect(labels.some((l) => l.outcome === 'served' && l.mode === 'primary')).toBe(true);
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

  it('a dropped label value is NOT silently relabelled to a plausible default', async () => {
    const before = await seriesOf('bitdex_primary_result_total');
    const beforeCounts = await (
      client.register.getSingleMetric('bitdex_primary_result_total') as unknown as Readable
    ).get();

    recordBitdexPrimaryResult('bogus' as BitdexServeOutcome, 'primary');

    const afterCounts = await (
      client.register.getSingleMetric('bitdex_primary_result_total') as unknown as Readable
    ).get();
    // Neither a new series NOR an increment on an existing one. Relabelling to
    // e.g. `served` would keep the series count identical and only show up as a
    // moved VALUE, so the count check alone would miss it.
    expect(await seriesOf('bitdex_primary_result_total')).toHaveLength(before.length);
    expect(afterCounts.values.map((v) => v.value)).toEqual(beforeCounts.values.map((v) => v.value));
  });
});
