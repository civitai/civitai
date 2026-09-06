import { describe, expect, it } from 'vitest';
import { PACKED_CODEC_DURATION_BUCKETS } from '../client';

/**
 * Resolution guard for `packed_codec_duration_seconds`.
 *
 * WHY A TEST FOR A LIST OF NUMBERS. Bad histogram edges do not fail — they report. A first edge
 * above the values actually being measured puts (almost) every sample in bucket one, and
 * `histogram_quantile` then answers with that edge forever: a plausible, stable, wrong number that
 * moves only for enormous changes, and which nothing else in the suite can notice. And the cost of
 * discovering it late is asymmetric: re-cutting the edges resets every series' history, so this has
 * to be right before the metric ships rather than after someone distrusts the graph.
 *
 * The measurements the edges are cut against, both from the compress-aware caches that exist today:
 *   - the SMALL end: imageMetaCache values are ~0.5-4 KB and decompress in ~0.026 ms. This is the
 *     overwhelming majority of samples by count, so it is what the quantiles will be made of.
 *   - the LARGE end: the tensor-metadata blob is ~335 KB, ~36 ms to compress in the worst case
 *     measured. Rare, but it is the tail the metric exists to show.
 *
 * These are inputs to the design, so they are spelled here as constants and the predicates below
 * are derived from them — not the other way round.
 */

/** Measured decompress time for a typical imageMetaCache value (~0.026 ms), in seconds. */
const TYPICAL_SMALL_SECONDS = 0.000026;
/** Measured worst-case compress time for the large tensor-metadata blob (~36 ms), in seconds. */
const LARGE_BLOB_TAIL_SECONDS = 0.036;

/**
 * The two properties that make a quantile readable, as a function of an arbitrary edge list — so
 * they can be run against a KNOWN-BAD list as a negative control, not only against the shipped one.
 */
function resolvesTypicalCase(buckets: readonly number[]) {
  // The common case must be above the first edge (otherwise it is inside the unresolvable
  // "0 → first edge" bucket) and must have real resolution around it rather than one giant bucket:
  // at least three edges at or below 10x it.
  const edgesAroundTypical = buckets.filter((b) => b <= TYPICAL_SMALL_SECONDS * 10).length;
  return buckets[0] < TYPICAL_SMALL_SECONDS && edgesAroundTypical >= 3;
}

function coversLargeTail(buckets: readonly number[]) {
  return buckets[buckets.length - 1] >= LARGE_BLOB_TAIL_SECONDS;
}

describe('packed_codec_duration_seconds buckets', () => {
  it('is strictly ascending (prom requires it; an out-of-order edge is silently accepted here)', () => {
    const sorted = [...PACKED_CODEC_DURATION_BUCKETS].sort((a, b) => a - b);
    expect(PACKED_CODEC_DURATION_BUCKETS).toEqual(sorted);
    expect(new Set(PACKED_CODEC_DURATION_BUCKETS).size).toBe(PACKED_CODEC_DURATION_BUCKETS.length);
  });

  it('resolves the measured common case rather than swallowing it in the first bucket', () => {
    expect(
      PACKED_CODEC_DURATION_BUCKETS[0],
      'the first edge sits BELOW the measured typical decompress, so a typical sample is resolvable'
    ).toBeLessThan(TYPICAL_SMALL_SECONDS);
    expect(
      resolvesTypicalCase(PACKED_CODEC_DURATION_BUCKETS),
      'the edges give the common case a first edge below it and >=3 edges within 10x'
    ).toBe(true);
  });

  it('still covers the large-blob tail the metric exists to show', () => {
    expect(coversLargeTail(PACKED_CODEC_DURATION_BUCKETS)).toBe(true);
  });

  // 🔴 NEGATIVE CONTROL. Without this the predicate above could be one that returns `true` for
  // anything — including the edge set this PR replaced, which is exactly the failure the guard is
  // supposed to catch. The pre-fix list is checked here and must be REJECTED.
  it('rejects the pre-fix edge set, whose 0.5ms floor swallowed the common case', () => {
    const preFix = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1];

    expect(
      resolvesTypicalCase(preFix),
      'the old floor of 0.0005 is ~19x the measured typical value, so it must not pass'
    ).toBe(false);
    // …and the discrimination really is about the FLOOR, not about the tail: the old list covered
    // the large end perfectly well. A guard that failed the old list for the wrong reason would
    // pass this line too, which is why it is asserted separately.
    expect(coversLargeTail(preFix), 'the old list was fine at the LARGE end').toBe(true);
  });
});
