import { describe, expect, it } from 'vitest';
import { PACKED_CODEC_DURATION_BUCKETS, packedCodecDuration } from '../client';

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
 * 🔴 WHY IT READS THE REGISTERED HISTOGRAM AND NOT THE EXPORTED CONSTANT. The constant is an input
 * to `registerHistogram`, not the thing scraped. An earlier version of this file imported only the
 * constant, and two mutants walked straight past it: (N1) leave the constant correct and set
 * `buckets:` on `packedCodecDuration` to the pre-fix literal — the exact histogram this guard
 * exists to prevent, shipped with the whole suite green; (N2) coarsen the constant to
 * `[0.00002, 0.00005, 0.0001, 0.00025, 1]`, which satisfies a last-edge-only tail check while
 * being one 0.25 ms → 1 s bucket, i.e. unable to resolve the ~36 ms tail at all. So the verdict
 * comes from `packedCodecDuration.get()` — prom-client's own view of the registered metric, after
 * an observation — and the constant is checked separately for agreement with it.
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
 * The coarsest any adjacent pair of edges is allowed to be. A histogram's resolution is exactly
 * its widest bucket: `histogram_quantile` interpolates linearly inside one, so a pair 4x apart
 * already means a quantile that can be off by most of a bucket's width. The shipped list's widest
 * pair is 2.5x, so 4 leaves real headroom rather than pinning today's number — and it is not a
 * multiple of any step in the list, so it cannot be satisfied by accident.
 */
const MAX_EDGE_RATIO = 4;

/**
 * The three properties that make a quantile readable, as functions of an arbitrary edge list — so
 * they can be run against KNOWN-BAD lists as negative controls, not only against the shipped one.
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

/** The widest adjacent edge ratio in the list — the histogram's worst-case resolution. */
function widestEdgeRatio(buckets: readonly number[]) {
  let widest = 1;
  for (let i = 1; i < buckets.length; i += 1)
    widest = Math.max(widest, buckets[i] / buckets[i - 1]);
  return widest;
}

function resolutionIsUniform(buckets: readonly number[]) {
  return widestEdgeRatio(buckets) <= MAX_EDGE_RATIO;
}

/**
 * The `le` edges prom-client is actually holding for the registered histogram, in order and
 * without the implicit `+Inf`. A labelled histogram emits no series until something is observed,
 * so a sample is recorded first; the label values are arbitrary (this asserts on edges, not counts)
 * but are spelled as a real op/cache pair so the observe cannot be rejected for a bad label.
 */
async function registeredBuckets(): Promise<number[]> {
  packedCodecDuration.observe(
    { op: 'decompress', cache_name: 'packed:caches:bucket-guard' },
    0.001
  );
  // `le` is not in the declared label union, so prom-client's own types cannot express it.
  const values = (await packedCodecDuration.get()).values as unknown as Array<{
    metricName?: string;
    labels: Record<string, string | number | undefined>;
  }>;
  const edges = values
    .filter((v) => v.metricName?.endsWith('_bucket') && v.labels.le !== '+Inf')
    .map((v) => Number(v.labels.le));
  return [...new Set(edges)].sort((a, b) => a - b);
}

describe('packed_codec_duration_seconds buckets', () => {
  it('the REGISTERED histogram carries the exported edge set (the seam the constant alone cannot see)', async () => {
    const registered = await registeredBuckets();

    // Positive control first: a bucketless or unobserved metric would give an empty list, and
    // every equality below would then be a claim about nothing.
    expect(registered.length, 'prom-client reported bucket edges for the registered metric').toBe(
      PACKED_CODEC_DURATION_BUCKETS.length
    );
    expect(registered).toEqual([...PACKED_CODEC_DURATION_BUCKETS]);
  });

  it('is strictly ascending (prom requires it; an out-of-order edge is silently accepted here)', () => {
    const sorted = [...PACKED_CODEC_DURATION_BUCKETS].sort((a, b) => a - b);
    expect(PACKED_CODEC_DURATION_BUCKETS).toEqual(sorted);
    expect(new Set(PACKED_CODEC_DURATION_BUCKETS).size).toBe(PACKED_CODEC_DURATION_BUCKETS.length);
  });

  it('resolves the measured common case rather than swallowing it in the first bucket', async () => {
    const registered = await registeredBuckets();

    expect(
      registered[0],
      'the first REGISTERED edge sits BELOW the measured typical decompress, so a typical sample is resolvable'
    ).toBeLessThan(TYPICAL_SMALL_SECONDS);
    expect(
      resolvesTypicalCase(registered),
      'the registered edges give the common case a first edge below it and >=3 edges within 10x'
    ).toBe(true);
  });

  it('has no bucket coarser than the allowed ratio anywhere in its range', async () => {
    const registered = await registeredBuckets();

    expect(
      widestEdgeRatio(registered),
      `the widest adjacent edge ratio must stay at or under ${MAX_EDGE_RATIO}x, or one bucket spans the range it is supposed to resolve`
    ).toBeLessThanOrEqual(MAX_EDGE_RATIO);
  });

  it('still covers the large-blob tail the metric exists to show', async () => {
    const registered = await registeredBuckets();
    expect(coversLargeTail(registered)).toBe(true);
  });

  // 🔴 NEGATIVE CONTROL #1. Without this the predicates above could be ones that return `true` for
  // anything — including the edge set this PR replaced, which is exactly the failure the guard is
  // supposed to catch. The pre-fix list is checked here and must be REJECTED.
  it('rejects the pre-fix edge set, whose 0.5ms floor swallowed the common case', () => {
    const preFix = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1];

    expect(
      resolvesTypicalCase(preFix),
      'the old floor of 0.0005 is ~19x the measured typical value, so it must not pass'
    ).toBe(false);
    // …and the discrimination really is about the FLOOR, not about the tail: the old list covered
    // the large end perfectly well, and its resolution was uniform. A guard that failed the old
    // list for either of those reasons would pass these lines too, which is why they are asserted
    // separately.
    expect(coversLargeTail(preFix), 'the old list was fine at the LARGE end').toBe(true);
    expect(resolutionIsUniform(preFix), 'the old list was fine on RESOLUTION too').toBe(true);
  });

  // 🔴 NEGATIVE CONTROL #2, and it is the one that motivates `resolutionIsUniform`. This list has a
  // correct floor and a last edge above the tail, so both of the other predicates accept it — while
  // being a single 0.25 ms → 1 s bucket that cannot resolve the ~36 ms tail at all. Asserting the
  // other two ACCEPT it is the point: it isolates which predicate is doing the rejecting.
  it('rejects a list that reaches the tail in one enormous bucket', () => {
    const coarseTail = [0.00002, 0.00005, 0.0001, 0.00025, 1];

    expect(resolutionIsUniform(coarseTail), 'a 4000x bucket is not resolution').toBe(false);
    expect(resolvesTypicalCase(coarseTail), 'its FLOOR is fine — that is not what is wrong').toBe(
      true
    );
    expect(coversLargeTail(coarseTail), 'its last edge is fine — that is not what is wrong').toBe(
      true
    );
  });
});
