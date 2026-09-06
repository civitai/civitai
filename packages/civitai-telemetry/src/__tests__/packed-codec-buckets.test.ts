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
 * The measurements the edges are cut against, all from the compress-aware caches that exist today
 * and all taken through the same `promisify(zlib.brotli*)` shape the codec actually uses:
 *   - the DISPATCH FLOOR: a 1-byte payload costs p50 17.7 us. That is threadpool round trip, not
 *     codec work, so nothing this metric ever samples can be meaningfully faster than it.
 *   - the SMALL end: 48 real image-meta values off the live cache decompress at p50 21.9-30.2 us,
 *     p90 41.9-66.2 us. This is the overwhelming majority of samples by count, so it is what the
 *     quantiles will be made of. Compress at q6 is p50 111.6 us, p90 216.3 us, p99 3.8 ms.
 *   - the LARGE end: the tensor-metadata blob is ~335 KB, ~36 ms to compress in the worst case
 *     measured. Rare, but it is the tail the metric exists to show.
 *
 * These are inputs to the design, so they are spelled here as constants and the predicates below
 * are derived from them — not the other way round.
 */

/**
 * Measured p50 of the async threadpool round trip for a 1-BYTE payload, in seconds — i.e. pure
 * dispatch overhead with no codec work in it. The first edge has to sit BELOW this, so that
 * bucket one means "impossibly fast, suspect the instrument" rather than "typical". (Tracked
 * separately as civitai#4656: making the codec sync for small values would remove most of it.)
 */
const DISPATCH_FLOOR_SECONDS = 0.0000177;
/** Measured decompress time for a typical imageMetaCache value (~0.026 ms), in seconds. */
const TYPICAL_SMALL_SECONDS = 0.000026;
/** Measured worst-case compress time for the large tensor-metadata blob (~36 ms), in seconds. */
const LARGE_BLOB_TAIL_SECONDS = 0.036;
/**
 * 🔴 THE SHIPPED LIST'S RESOLUTION IS PINNED AS AN EXACT ORDERED SEQUENCE OF ADJACENT RATIOS, NOT
 * AS A BOUND, and that is the whole point of this constant. A bound on the widest adjacent ratio
 * is the obvious guard and it has a hole that this file walked into: deleting an edge does not
 * invent a new ratio, it MULTIPLIES the two steps either side of it, so a list built from 2x and
 * 2.5x steps composes to 4x, 5x and 6.25x. The previous revision bounded the widest ratio at 4x
 * inclusive and asserted in a comment that 4 "is not a multiple of any step in the list, so it
 * cannot be satisfied by accident" — false, and demonstrably so: deleting any one of 0.0005,
 * 0.005, 0.05 or 0.5 left neighbours exactly 4x apart and all 35 tests in this package stayed
 * green. Raising the bound to 3 would have closed that particular hole and left the same shape of
 * guard in place for the next re-cut to reopen.
 *
 * An equality has no hole to reason about. Deleting ANY edge shortens this sequence, changing ANY
 * edge changes at least one entry, and inserting one lengthens it — each is a plain `toEqual`
 * failure with the before/after visible in the diff. The cost is that a deliberate re-cut of the
 * edges has to update this list too. That is the intended price: these edges reset every series'
 * history when they change, so a change here should be loud.
 *
 * Rounded to 3 decimals because the list's 1.5x and 1.667x steps are not exact in IEEE754
 * (0.00003/0.00002 is 1.4999999999999998). 3 decimals is ~0.05% resolution — far finer than any
 * step the list uses, so no real edge change survives the rounding.
 */
const EXPECTED_EDGE_RATIOS = [
  // 5 -> 10 -> 15 -> 20 -> 30 -> 50 -> 75 -> 100 -> 150 -> 250 us: the dispatch floor and the
  // decompress/compress bulk, deliberately the finest part of the list.
  2, 1.5, 1.333, 1.5, 1.667, 1.5, 1.333, 1.5, 1.667,
  // 250us -> 1s: the usual 1-2-5 decade steps over the ms tail and the ~36 ms large-blob tail.
  2, 2, 2.5, 2, 2, 2.5, 2, 2, 2.5, 2, 2,
];
/**
 * A coarse "is this list uniform at all" threshold, used ONLY to discriminate the known-bad
 * control lists at the bottom of this file — never as the verdict on the shipped list, which is
 * pinned by EXPECTED_EDGE_RATIOS above.
 *
 * No claim is made that this value is unreachable by composing the list's own steps. It is not:
 * two consecutive 2x steps compose to exactly 4x, which is what made it useless as the real
 * guard. It survives here because the control lists it has to separate are nowhere near it (the
 * pre-fix list's widest pair is 2.5x; the coarse-tail control's is 4000x).
 */
const CONTROL_MAX_EDGE_RATIO = 4;

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

/**
 * Strictly stronger than `resolvesTypicalCase`'s first clause, and separate from it on purpose:
 * "below the typical sample" still allows a floor sitting inside the population, which is exactly
 * the mistake both previous edge sets made. "Below the dispatch floor" does not.
 */
function floorIsBelowDispatchFloor(buckets: readonly number[]) {
  return buckets[0] < DISPATCH_FLOOR_SECONDS;
}

function coversLargeTail(buckets: readonly number[]) {
  return buckets[buckets.length - 1] >= LARGE_BLOB_TAIL_SECONDS;
}

/** Every adjacent edge ratio in order, rounded — the histogram's resolution profile. */
function edgeRatios(buckets: readonly number[]) {
  const ratios: number[] = [];
  for (let i = 1; i < buckets.length; i += 1)
    ratios.push(Math.round((buckets[i] / buckets[i - 1]) * 1000) / 1000);
  return ratios;
}

/** The widest adjacent edge ratio in the list — the histogram's worst-case resolution. */
function widestEdgeRatio(buckets: readonly number[]) {
  let widest = 1;
  for (let i = 1; i < buckets.length; i += 1)
    widest = Math.max(widest, buckets[i] / buckets[i - 1]);
  return widest;
}

function resolutionIsUniform(buckets: readonly number[]) {
  return widestEdgeRatio(buckets) <= CONTROL_MAX_EDGE_RATIO;
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

  it('puts its floor below the measured dispatch floor, so bucket one means "impossibly fast"', async () => {
    const registered = await registeredBuckets();

    expect(
      registered[0],
      `the first REGISTERED edge must sit below the ${DISPATCH_FLOOR_SECONDS}s threadpool dispatch floor — a floor inside the sample population cannot be resolved past, and the previous 0.00002 floor swallowed 38.5% of measured decompress samples`
    ).toBeLessThan(DISPATCH_FLOOR_SECONDS);
  });

  it('carries exactly the resolution profile it was cut for, edge for edge', async () => {
    const registered = await registeredBuckets();

    // An EQUALITY, not a bound. A bound on the widest adjacent ratio is satisfiable by deleting an
    // edge — the two neighbouring steps compose — which is the regression this must catch; see
    // EXPECTED_EDGE_RATIOS. Deleting any edge shortens this array; changing one moves an entry.
    expect(
      edgeRatios(registered),
      'the registered edges have exactly the adjacent-ratio sequence this list was designed with — an edge was added, removed or moved'
    ).toEqual(EXPECTED_EDGE_RATIOS);
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

  // 🔴 NEGATIVE CONTROL #1b, and it is the one that motivates `floorIsBelowDispatchFloor`. This is
  // the edge set the FIRST revision of this PR shipped — the one that replaced the 0.5 ms floor
  // above and was itself wrong, in the same direction and by much less. Its floor of 20 us is
  // below the 26 us typical, so `resolvesTypicalCase` accepts it; measured against 48 real
  // image-meta values it still swallowed 38.5% of decompress samples in bucket one. Asserting
  // that the other three predicates ACCEPT it is the point — it isolates which predicate rejects.
  it('rejects the 20us floor, which was under the typical value and still inside the population', () => {
    const twentyMicroFloor = [
      0.00002, 0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25,
      0.5, 1,
    ];

    expect(
      floorIsBelowDispatchFloor(twentyMicroFloor),
      'a 20us floor sits ABOVE the 17.7us dispatch floor, i.e. inside the sample population'
    ).toBe(false);
    expect(
      resolvesTypicalCase(twentyMicroFloor),
      'it passes the weaker floor test — which is exactly why that test was not enough'
    ).toBe(true);
    expect(coversLargeTail(twentyMicroFloor), 'its tail was fine — not what is wrong').toBe(true);
    expect(
      resolutionIsUniform(twentyMicroFloor),
      'its resolution was fine — not what is wrong'
    ).toBe(true);
  });

  // 🔴 POSITIVE CONTROL for `floorIsBelowDispatchFloor`: it must be capable of returning true, or
  // the assertion above is a claim about a predicate that always rejects.
  it('accepts the shipped floor (positive control for the dispatch-floor predicate)', async () => {
    expect(floorIsBelowDispatchFloor(await registeredBuckets())).toBe(true);
  });

  // 🔴 NEGATIVE CONTROL #2: resolution, independent of both ends. This list has a floor under the
  // typical value and a last edge above the tail, so both of the other predicates accept it —
  // while being a single 0.25 ms → 1 s bucket that cannot resolve the ~36 ms tail at all.
  // Asserting the other two ACCEPT it is the point: it isolates which predicate is rejecting.
  // (`resolutionIsUniform` is a control-only predicate — the shipped list's resolution is pinned
  // by the exact ratio sequence above, not by this threshold. See CONTROL_MAX_EDGE_RATIO.)
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
