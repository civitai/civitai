import { describe, expect, it } from 'vitest';
import client from 'prom-client';

/**
 * App Block LAUNCH-LATENCY histograms — `observeAppBlockLaunch` and its
 * `launchSampleSeconds` gate, exercised against the REAL default prom-client
 * registry (the same one /api/metrics scrapes).
 *
 * What is pinned here, and why each one matters:
 *   - the NEVER-EMIT-A-ZERO gate (a zero reads as an instant leg and drags every
 *     percentile down, in the reassuring direction);
 *   - DROP-NEVER-CLAMP for an out-of-range sample (a clamp folds junk onto the
 *     +Inf edge and pollutes _sum and the tail);
 *   - `total` is the ANCHOR — an invalid total suppresses the phases too, WITH a
 *     positive control proving the same phase is observed when the total is
 *     valid (otherwise "0 phase observations" is indistinguishable from a
 *     histogram wired to nothing);
 *   - the BUCKET EDGES are the ones the design justified against the real launch
 *     constants, not prom-client's defaults;
 *   - the emitter never throws (it runs on a public fire-and-forget beacon).
 */

import {
  APP_BLOCK_LAUNCH_HELLO,
  launchHelloLabel,
  launchInitPostsSample,
  launchSampleSeconds,
  MAX_APP_BLOCK_LAUNCH_INIT_POSTS,
  MAX_APP_BLOCK_LAUNCH_SECONDS,
  observeAppBlockLaunch,
} from '~/server/metrics/app-block-runtime.metrics';

const TOTAL_METRIC = 'civitai_app_block_launch_total_seconds';
const PHASE_METRIC = 'civitai_app_block_launch_phase_seconds';

type HistPoint = { metricName?: string; labels: Record<string, string>; value: number };

/**
 * Read one histogram aggregate for a label set. Returns 0 when the series does
 * not exist yet, so every assertion can be a before/after DELTA — the registry
 * is process-global and other suites may already have observed samples.
 */
async function readHist(
  name: string,
  suffix: '_count' | '_sum',
  labels: Record<string, string>
): Promise<number> {
  const metric = client.register.getSingleMetric(name);
  if (!metric) return 0;
  const data = await (metric as unknown as { get(): Promise<{ values: HistPoint[] }> }).get();
  const point = data.values.find(
    (v) =>
      v.metricName === `${name}${suffix}` &&
      Object.entries(labels).every(([k, val]) => v.labels[k] === val)
  );
  return point?.value ?? 0;
}

/** Cumulative count in the `le` bucket for a label set. */
async function readBucket(
  name: string,
  le: string,
  labels: Record<string, string>
): Promise<number> {
  const metric = client.register.getSingleMetric(name);
  if (!metric) return 0;
  const data = await (metric as unknown as { get(): Promise<{ values: HistPoint[] }> }).get();
  const point = data.values.find(
    (v) =>
      v.metricName === `${name}_bucket` &&
      // prom-client stores `le` as a NUMBER on the in-memory point (it is only
      // stringified at render time), so compare stringified or this silently
      // matches nothing and every bucket reads 0 — a false PASS on any
      // assertion whose "before" is also 0.
      String(v.labels.le) === le &&
      Object.entries(labels).every(([k, val]) => v.labels[k] === val)
  );
  return point?.value ?? 0;
}

async function bucketEdges(name: string): Promise<number[]> {
  const metric = client.register.getSingleMetric(name);
  if (!metric) return [];
  const data = await (metric as unknown as { get(): Promise<{ values: HistPoint[] }> }).get();
  const les = new Set<string>();
  for (const v of data.values) if (v.metricName === `${name}_bucket`) les.add(String(v.labels.le));
  return [...les]
    .map((le) => Number(le))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

describe('launchSampleSeconds — the shared sample gate', () => {
  it('🔴 rejects a ZERO, so an unobserved leg can never read as an instant one', () => {
    expect(launchSampleSeconds(0)).toBe(null);
    expect(launchSampleSeconds(-1)).toBe(null);
  });

  it('🔴 DROPS an out-of-range sample rather than clamping it', () => {
    expect(launchSampleSeconds(MAX_APP_BLOCK_LAUNCH_SECONDS * 1000)).toBe(
      MAX_APP_BLOCK_LAUNCH_SECONDS
    );
    // One millisecond past the bound → dropped. A clamp would return
    // MAX_APP_BLOCK_LAUNCH_SECONDS here.
    expect(launchSampleSeconds(MAX_APP_BLOCK_LAUNCH_SECONDS * 1000 + 1)).toBe(null);
    expect(launchSampleSeconds(9_999_999)).toBe(null);
  });

  /**
   * 🔴 THE BOUND MUST CLEAR THE AUTO-RETRY WORST CASE.
   *
   * The host emits ONE `ok` for the whole bounded auto-retry sequence, whichever
   * attempt produced it, so a legitimate success can be ~47s (15 no_token + 2
   * backoff + 15 no_token + 5 backoff + ~10 ready). The previous 30s bound
   * dropped those, and the drop was slowness-correlated — it trimmed exactly the
   * tail the metric exists to show. A value pin: red if the bound is lowered back.
   */
  it('🔴 accepts a slow auto-retry success (~47s), which the old 30s bound dropped', () => {
    expect(launchSampleSeconds(47_000)).toBeCloseTo(47, 6);
    expect(launchSampleSeconds(30_001)).toBeCloseTo(30.001, 6);
    expect(MAX_APP_BLOCK_LAUNCH_SECONDS).toBeGreaterThan(47);
  });

  it('rejects non-finite and non-numeric input (the body is client-supplied)', () => {
    expect(launchSampleSeconds(Number.NaN)).toBe(null);
    expect(launchSampleSeconds(Number.POSITIVE_INFINITY)).toBe(null);
    expect(launchSampleSeconds('900' as unknown)).toBe(null);
    expect(launchSampleSeconds(undefined)).toBe(null);
    expect(launchSampleSeconds(null)).toBe(null);
    expect(launchSampleSeconds({} as unknown)).toBe(null);
  });

  it('converts milliseconds to seconds', () => {
    expect(launchSampleSeconds(1)).toBeCloseTo(0.001, 6);
    expect(launchSampleSeconds(1_234)).toBeCloseTo(1.234, 6);
  });
});

describe('observeAppBlockLaunch', () => {
  it('observes the total on the per-app histogram and each phase on the phase histogram', async () => {
    const app = 'apb_launch_ok';
    const beforeTotal = await readHist(TOTAL_METRIC, '_count', { app_block_id: app });
    const beforeToken = await readHist(PHASE_METRIC, '_count', {
      hello: 'no',
      phase: 'token_mint',
    });
    const beforeInit = await readHist(PHASE_METRIC, '_count', { hello: 'no', phase: 'init_wait' });

    observeAppBlockLaunch(app, { totalMs: 1_100, tokenMintMs: 180, initWaitMs: 700, hello: false });

    expect(await readHist(TOTAL_METRIC, '_count', { app_block_id: app })).toBe(beforeTotal + 1);
    expect(await readHist(PHASE_METRIC, '_count', { hello: 'no', phase: 'token_mint' })).toBe(
      beforeToken + 1
    );
    expect(await readHist(PHASE_METRIC, '_count', { hello: 'no', phase: 'init_wait' })).toBe(
      beforeInit + 1
    );
  });

  /**
   * 🔴 THE CROSS-ORIGIN PHASE IS DELIBERATELY ABSENT, and a stray client field
   * must not resurrect it. `frame_fetch` was designed, built, and dropped:
   * without `Timing-Allow-Origin` the parent's `responseEnd` for a subframe is
   * the frame's LOAD event, not the document response, so it measures roughly
   * what `total` already measures — and the entry frequently does not exist yet
   * when the beacon fires, which biases the missing data toward slow apps.
   *
   * The phase label is code-owned, so an old or hand-rolled client sending
   * `frameFetchMs` must produce NO series at all rather than a fourth phase.
   */
  it('🔴 ignores a client-sent frameFetchMs — no frame_fetch series is created', async () => {
    const app = 'apb_launch_no_frame';
    observeAppBlockLaunch(app, {
      totalMs: 1_100,
      initWaitMs: 700,
      frameFetchMs: 320,
    } as never);

    // Positive control first: the sample WAS accepted, so a zero below cannot be
    // "nothing was observed at all".
    expect(await readHist(TOTAL_METRIC, '_count', { app_block_id: app })).toBe(1);
    expect(await readHist(PHASE_METRIC, '_count', { phase: 'frame_fetch' })).toBe(0);
  });

  it('records the total in SECONDS on _sum (not milliseconds)', async () => {
    const app = 'apb_launch_sum';
    const before = await readHist(TOTAL_METRIC, '_sum', { app_block_id: app });
    observeAppBlockLaunch(app, { totalMs: 2_500, hello: false });
    expect(await readHist(TOTAL_METRIC, '_sum', { app_block_id: app })).toBeCloseTo(
      before + 2.5,
      6
    );
  });

  it('🔴 `total` is the ANCHOR — an invalid total suppresses the PHASES too', async () => {
    const app = 'apb_launch_anchor';
    const beforeTotal = await readHist(TOTAL_METRIC, '_count', { app_block_id: app });
    const beforePhase = await readHist(PHASE_METRIC, '_count', { hello: 'no', phase: 'init_wait' });

    // A perfectly valid phase, but no usable total.
    observeAppBlockLaunch(app, { totalMs: 0, initWaitMs: 700, hello: false });
    expect(await readHist(TOTAL_METRIC, '_count', { app_block_id: app })).toBe(beforeTotal);
    expect(await readHist(PHASE_METRIC, '_count', { hello: 'no', phase: 'init_wait' })).toBe(
      beforePhase
    );

    // 🔴 POSITIVE CONTROL. Without this, the two zeros above are indistinguishable
    // from a histogram that is wired to nothing at all. Same phase, same value,
    // only the total made valid → the counter MUST move by exactly 1.
    observeAppBlockLaunch(app, { totalMs: 1_100, initWaitMs: 700, hello: false });
    expect(await readHist(TOTAL_METRIC, '_count', { app_block_id: app })).toBe(beforeTotal + 1);
    expect(await readHist(PHASE_METRIC, '_count', { hello: 'no', phase: 'init_wait' })).toBe(
      beforePhase + 1
    );
  });

  it('🔴 omits a ZERO phase while still recording the total', async () => {
    const app = 'apb_launch_zero_phase';
    const beforeTotal = await readHist(TOTAL_METRIC, '_count', { app_block_id: app });
    const beforeToken = await readHist(PHASE_METRIC, '_count', {
      hello: 'no',
      phase: 'token_mint',
    });

    observeAppBlockLaunch(app, { totalMs: 1_100, tokenMintMs: 0, hello: false });

    expect(await readHist(TOTAL_METRIC, '_count', { app_block_id: app })).toBe(beforeTotal + 1);
    expect(await readHist(PHASE_METRIC, '_count', { hello: 'no', phase: 'token_mint' })).toBe(
      beforeToken
    );
  });

  it('🔴 DROPS an out-of-range phase rather than clamping it onto the top bucket', async () => {
    const app = 'apb_launch_drop_phase';
    const beforeToken = await readHist(PHASE_METRIC, '_count', {
      hello: 'no',
      phase: 'token_mint',
    });
    const beforeSum = await readHist(PHASE_METRIC, '_sum', { hello: 'no', phase: 'token_mint' });

    observeAppBlockLaunch(app, { totalMs: 1_100, tokenMintMs: 61_000, hello: false });

    expect(await readHist(PHASE_METRIC, '_count', { hello: 'no', phase: 'token_mint' })).toBe(
      beforeToken
    );
    // The thing a clamp would break: _sum must be untouched, not +60.
    expect(await readHist(PHASE_METRIC, '_sum', { hello: 'no', phase: 'token_mint' })).toBeCloseTo(
      beforeSum,
      6
    );
  });

  it('does nothing when `timings` is absent', async () => {
    const app = 'apb_launch_absent';
    const before = await readHist(TOTAL_METRIC, '_count', { app_block_id: app });
    observeAppBlockLaunch(app, undefined);
    expect(await readHist(TOTAL_METRIC, '_count', { app_block_id: app })).toBe(before);
  });

  it('never throws on junk input (public fire-and-forget beacon)', () => {
    expect(() =>
      observeAppBlockLaunch('apb_x', { totalMs: 'nope', tokenMintMs: {} } as never)
    ).not.toThrow();
    expect(() => observeAppBlockLaunch('apb_x', null as never)).not.toThrow();
  });
});

describe('launch histogram bucket boundaries', () => {
  it('uses the launch-specific edges, NOT prom-client defaults', async () => {
    // Force registration + at least one bucket row.
    observeAppBlockLaunch('apb_launch_buckets', { totalMs: 300, tokenMintMs: 300, hello: false });

    const expected = [0.1, 0.25, 0.4, 0.6, 0.8, 1.2, 1.8, 2.5, 4, 6, 8, 10, 15];
    expect(await bucketEdges(TOTAL_METRIC)).toEqual(expected);
    expect(await bucketEdges(PHASE_METRIC)).toEqual(expected);

    // prom-client's defaults top out at 10 with nothing between 5 and 10 and have
    // no 0.4 edge — assert we are NOT on them, since a silent fallback to the
    // defaults would still produce a plausible-looking histogram.
    expect(await bucketEdges(TOTAL_METRIC)).not.toContain(0.005);
    expect(await bucketEdges(TOTAL_METRIC)).not.toContain(5);
  });

  it('🔴 resolves the 400ms BLOCK_INIT tick — a 300ms and a 500ms sample land in different buckets', async () => {
    const app = 'apb_launch_tick';
    // 🔴 POSITIVE CONTROL FOR THE READER ITSELF. Every "before" here is 0 for a
    // fresh app label, so a `readBucket` that matched nothing would make the
    // 0.25 assertion pass for the wrong reason. Prove the reader can observe a
    // non-zero first.
    observeAppBlockLaunch(app, { totalMs: 50, hello: false });
    expect(await readBucket(TOTAL_METRIC, '0.1', { app_block_id: app })).toBe(1);

    const before025 = await readBucket(TOTAL_METRIC, '0.25', { app_block_id: app });
    const before04 = await readBucket(TOTAL_METRIC, '0.4', { app_block_id: app });
    const before06 = await readBucket(TOTAL_METRIC, '0.6', { app_block_id: app });

    observeAppBlockLaunch(app, { totalMs: 300, hello: false });
    observeAppBlockLaunch(app, { totalMs: 500, hello: false });

    // Buckets are cumulative: 300ms is <= 0.4 but > 0.25; 500ms is <= 0.6 only.
    expect(await readBucket(TOTAL_METRIC, '0.25', { app_block_id: app })).toBe(before025);
    expect(await readBucket(TOTAL_METRIC, '0.4', { app_block_id: app })).toBe(before04 + 1);
    expect(await readBucket(TOTAL_METRIC, '0.6', { app_block_id: app })).toBe(before06 + 2);
  });

  /**
   * 🔴 A SLOW AUTO-RETRY SUCCESS IS REAL DATA, NOT A BUG SIGNAL.
   *
   * An earlier revision of this test asserted that a >10s total was
   * "structurally impossible on the success path" because BLOCK_READY_TIMEOUT_MS
   * fires first. That is true of ONE ATTEMPT and false of a LAUNCH: the host
   * emits one `ok` for the whole bounded auto-retry sequence, so 12-47s `ok`
   * samples are reachable. They must be COUNTED (above the top bucket), never
   * dropped and never read as an emitter fault.
   */
  it('🔴 counts a slow auto-retry success above the top bucket instead of dropping it', async () => {
    const app = 'apb_launch_slow_retry';
    const before15 = await readBucket(TOTAL_METRIC, '15', { app_block_id: app });
    const beforeCount = await readHist(TOTAL_METRIC, '_count', { app_block_id: app });
    const beforeSum = await readHist(TOTAL_METRIC, '_sum', { app_block_id: app });

    // A success on attempt 3 of the bounded sequence.
    observeAppBlockLaunch(app, { totalMs: 28_000, hello: false });

    // Above every finite edge…
    expect(await readBucket(TOTAL_METRIC, '15', { app_block_id: app })).toBe(before15);
    // …but counted, and contributing its REAL value to _sum (not a clamp).
    expect(await readHist(TOTAL_METRIC, '_count', { app_block_id: app })).toBe(beforeCount + 1);
    expect(await readHist(TOTAL_METRIC, '_sum', { app_block_id: app })).toBeCloseTo(
      beforeSum + 28,
      6
    );
  });
});

/**
 * 🔴 `civitai_app_block_launch_init_posts` — THE DISCRIMINATING INSTRUMENT.
 *
 * `launch_phase_seconds{phase="init_wait"}` has a 0.4-0.6s mode that two
 * mutually exclusive mechanisms produce identically: the host's BLOCK_INIT
 * re-post quantization (>=2 posts) and blocks that simply boot that slowly
 * (1 post). No duration metric can separate them; the `le=1` share of THIS
 * histogram can.
 *
 * Every rule pinned below fails by producing a plausible number that points at
 * the SECOND explanation — the one that would retire the cadence lever. A clamp
 * puts junk in the top bucket ("lots of quantization"); a zero or a rounded
 * fraction lands at `le=1` ("no quantization"). Both are silent.
 */
const INIT_POSTS_METRIC = 'civitai_app_block_launch_init_posts';

describe('launchInitPostsSample — the count gate', () => {
  it('🔴 DROPS an out-of-range count rather than clamping it', () => {
    expect(launchInitPostsSample(MAX_APP_BLOCK_LAUNCH_INIT_POSTS)).toBe(
      MAX_APP_BLOCK_LAUNCH_INIT_POSTS
    );
    // One past the bound → dropped. A clamp would return the bound here, and it
    // would land in the TOP bucket — reading as a heavily-quantized launch that
    // never happened.
    expect(launchInitPostsSample(MAX_APP_BLOCK_LAUNCH_INIT_POSTS + 1)).toBe(null);
    expect(launchInitPostsSample(5_000)).toBe(null);
  });

  it('🔴 rejects ZERO (a launch that acked posted at least once)', () => {
    // A 0 would be counted at `le=1`, biasing the share toward "acks on the
    // first post" — the answer that says the cadence is not the lever.
    expect(launchInitPostsSample(0)).toBe(null);
    expect(launchInitPostsSample(-3)).toBe(null);
  });

  it('🔴 rejects a NON-INTEGER instead of rounding it', () => {
    // Rounding 1.6 to 2 would invent a re-post that never happened; rounding 2.4
    // to 2 would launder junk into a real-looking sample. A fractional value can
    // only come from something that is not counting posts.
    expect(launchInitPostsSample(1.5)).toBe(null);
    expect(launchInitPostsSample(2.0000001)).toBe(null);
    // …and a float that IS integral is fine — JSON has no int type.
    expect(launchInitPostsSample(2.0)).toBe(2);
  });

  it('rejects non-finite and non-numeric input (the body is client-supplied)', () => {
    expect(launchInitPostsSample(Number.NaN)).toBe(null);
    expect(launchInitPostsSample(Number.POSITIVE_INFINITY)).toBe(null);
    expect(launchInitPostsSample('3' as unknown)).toBe(null);
    expect(launchInitPostsSample(undefined)).toBe(null);
    expect(launchInitPostsSample(null)).toBe(null);
    expect(launchInitPostsSample({} as unknown)).toBe(null);
  });
});

describe('observeAppBlockLaunch — initPosts', () => {
  it('observes exactly ONE sample per successful launch that carries a count', async () => {
    const before = await readHist(INIT_POSTS_METRIC, '_count', { hello: 'no' });
    const beforeSum = await readHist(INIT_POSTS_METRIC, '_sum', { hello: 'no' });
    observeAppBlockLaunch('apb_initposts_one', {
      totalMs: 1_100,
      initWaitMs: 700,
      initPosts: 3,
      hello: false,
    });
    expect(await readHist(INIT_POSTS_METRIC, '_count', { hello: 'no' })).toBe(before + 1);
    // The REAL value reaches _sum — a distinct, non-1 count so this cannot pass
    // against a mutant that observes a constant.
    expect(await readHist(INIT_POSTS_METRIC, '_sum', { hello: 'no' })).toBe(beforeSum + 3);
  });

  it('🔴 the le=1 vs le=2 gap is resolvable — the whole point of the edges', async () => {
    // If the first bucket were `le=2`, a single-post launch and a two-post
    // launch would be indistinguishable, which is precisely the distinction the
    // metric exists to make.
    const beforeOne = await readBucket(INIT_POSTS_METRIC, '1', { hello: 'no' });
    const beforeTwo = await readBucket(INIT_POSTS_METRIC, '2', { hello: 'no' });
    observeAppBlockLaunch('apb_initposts_edges', { totalMs: 500, initPosts: 2, hello: false });
    // A 2-post launch does NOT count at le=1…
    expect(await readBucket(INIT_POSTS_METRIC, '1', { hello: 'no' })).toBe(beforeOne);
    // …but does at le=2 (buckets are cumulative).
    expect(await readBucket(INIT_POSTS_METRIC, '2', { hello: 'no' })).toBe(beforeTwo + 1);

    observeAppBlockLaunch('apb_initposts_edges', { totalMs: 500, initPosts: 1, hello: false });
    expect(await readBucket(INIT_POSTS_METRIC, '1', { hello: 'no' })).toBe(beforeOne + 1);
  });

  it('🔴 observes NOTHING when the count is absent — with a positive control', async () => {
    const before = await readHist(INIT_POSTS_METRIC, '_count', { hello: 'no' });
    observeAppBlockLaunch('apb_initposts_absent', {
      totalMs: 1_100,
      initWaitMs: 700,
      hello: false,
    });
    expect(await readHist(INIT_POSTS_METRIC, '_count', { hello: 'no' })).toBe(before);
    // 🔴 POSITIVE CONTROL. Without this, "0 observations" is indistinguishable
    // from a histogram wired to nothing, and every absence assertion in this
    // file would be vacuously green.
    observeAppBlockLaunch('apb_initposts_absent', {
      totalMs: 1_100,
      initWaitMs: 700,
      initPosts: 5,
      hello: false,
    });
    expect(await readHist(INIT_POSTS_METRIC, '_count', { hello: 'no' })).toBe(before + 1);
  });

  it('🔴 DROPS an out-of-range count without touching _sum or the tail', async () => {
    const beforeCount = await readHist(INIT_POSTS_METRIC, '_count', { hello: 'no' });
    const beforeSum = await readHist(INIT_POSTS_METRIC, '_sum', { hello: 'no' });
    observeAppBlockLaunch('apb_initposts_huge', {
      totalMs: 1_100,
      initPosts: MAX_APP_BLOCK_LAUNCH_INIT_POSTS + 1,
      hello: false,
    });
    // A clamp would have incremented BOTH — and the increment would sit in the
    // top bucket, reading as the strongest possible quantization evidence.
    expect(await readHist(INIT_POSTS_METRIC, '_count', { hello: 'no' })).toBe(beforeCount);
    expect(await readHist(INIT_POSTS_METRIC, '_sum', { hello: 'no' })).toBe(beforeSum);
  });

  it('🔴 is suppressed with the phases when `total` is invalid (total is the anchor)', async () => {
    const before = await readHist(INIT_POSTS_METRIC, '_count', { hello: 'no' });
    // A post count with no end-to-end duration to interpret it against is an
    // orphan that still moves the distribution.
    observeAppBlockLaunch('apb_initposts_anchor', { totalMs: 0, initPosts: 4, hello: false });
    observeAppBlockLaunch('apb_initposts_anchor', {
      totalMs: undefined,
      initPosts: 4,
      hello: false,
    });
    expect(await readHist(INIT_POSTS_METRIC, '_count', { hello: 'no' })).toBe(before);
    // POSITIVE CONTROL: the identical count with a VALID total is observed.
    observeAppBlockLaunch('apb_initposts_anchor', { totalMs: 900, initPosts: 4, hello: false });
    expect(await readHist(INIT_POSTS_METRIC, '_count', { hello: 'no' })).toBe(before + 1);
  });

  it('carries the bucket edges the design justified, not prom-client defaults', async () => {
    observeAppBlockLaunch('apb_initposts_buckets', { totalMs: 900, initPosts: 1, hello: false });
    expect(await bucketEdges(INIT_POSTS_METRIC)).toEqual([
      1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 28, 40, 64,
    ]);
  });

  /**
   * 🔴 THE CARDINALITY DECISION, ASSERTED — and it is now `hello` AND NOTHING
   * ELSE. This histogram deliberately carries no `app_block_id` (that would be
   * ~52x) and no `phase` (there is one phase it can be about). `hello` is the
   * single dimension it is allowed, because without it the `le=1` share pools
   * accelerator apps with cadence-bound ones and answers the wrong question.
   *
   * An EXACT key-set equality, not a `toContain`: the failure mode this guards
   * is a label being ADDED, so a subset test would not see it.
   */
  it('🔴 carries EXACTLY the `hello` label — no app_block_id, no phase', async () => {
    observeAppBlockLaunch('apb_initposts_labels', { totalMs: 900, initPosts: 2, hello: false });
    const metric = client.register.getSingleMetric(INIT_POSTS_METRIC);
    const data = await (metric as unknown as { get(): Promise<{ values: HistPoint[] }> }).get();
    expect(data.values.length).toBeGreaterThan(0); // guard the guard: not a vacuous loop
    for (const v of data.values) {
      // `le` is the histogram's own bucket key, not a dimension we chose.
      expect(
        Object.keys(v.labels)
          .filter((k) => k !== 'le')
          .sort()
      ).toEqual(['hello']);
    }
  });

  it('never throws on a garbage count (it runs on a public fire-and-forget beacon)', () => {
    expect(() =>
      observeAppBlockLaunch('apb_initposts_throw', {
        totalMs: 900,
        initPosts: 'many' as unknown,
      })
    ).not.toThrow();
  });
});

/**
 * 🔴 THE DENOMINATOR GUARD — the headline statistic's divisor, pinned.
 *
 * `civitai_app_block_launch_init_posts` is read as a SHARE at `le=1`. Which
 * series you divide by decides the answer, and the two candidates DIVERGE:
 * a launch is counted in `launch_total_seconds` but NOT here whenever its post
 * count is unusable — a block that acks before the host ever posted an init
 * (count 0), or a manual-retry storm past the cap.
 *
 * The first case is FAST, no-quantization traffic. Dividing by the larger
 * `launch_total_seconds_count` therefore removes it from the numerator but not
 * the denominator and UNDERSTATES the `le=1` share — making the data look more
 * quantized than it is, which is precisely the direction that flatters the
 * cadence change this metric exists to evaluate. An instrument must not be
 * biased toward its author's hypothesis.
 *
 * This test exists so the divergence is a PINNED PROPERTY rather than a
 * surprise, and so nobody "simplifies" the help text back to the wrong divisor.
 */
describe('launch_init_posts: the denominator is its OWN _count', () => {
  it('🔴 the two histograms’ _count series genuinely diverge', async () => {
    const app = 'apb_denominator_guard';
    const t0 = await readHist(TOTAL_METRIC, '_count', { app_block_id: app });
    const i0 = await readHist(INIT_POSTS_METRIC, '_count', { hello: 'no' });

    // (a) acked before any BLOCK_INIT was posted — count 0, dropped.
    observeAppBlockLaunch(app, { totalMs: 900, initWaitMs: 400, hello: false });
    // (b) manual-retry storm past the cap — dropped, never clamped.
    observeAppBlockLaunch(app, {
      totalMs: 51_000,
      initWaitMs: 50_000,
      initPosts: MAX_APP_BLOCK_LAUNCH_INIT_POSTS + 17,
      hello: false,
    });
    // (c) an ordinary launch — observed by both.
    observeAppBlockLaunch(app, { totalMs: 500, initWaitMs: 200, initPosts: 1, hello: false });

    const dTotal = (await readHist(TOTAL_METRIC, '_count', { app_block_id: app })) - t0;
    const dPosts = (await readHist(INIT_POSTS_METRIC, '_count', { hello: 'no' })) - i0;

    // 3 launches reached the total histogram; only 1 reached this one.
    expect(dTotal).toBe(3);
    expect(dPosts).toBe(1);
    // Stated as the inequality a reader would rely on, not just two numbers.
    expect(dPosts).toBeLessThan(dTotal);
  });

  it('🔴 the help text names the correct divisor and warns off the wrong one', async () => {
    const metric = client.register.getSingleMetric(INIT_POSTS_METRIC);
    const help = (metric as unknown as { help: string }).help;
    // Pin the WHOLE claim, not a keyword: a guard on a word is walkable by
    // rewording, and this text is the only thing standing between a reader and
    // a systematically understated share.
    expect(help).toContain('civitai_app_block_launch_init_posts_count');
    expect(help).toContain('NEVER `launch_total_seconds_count`');
    expect(help).toContain('UNDERSTATES');
  });
});

/**
 * 🔴 THE `hello` STRATIFIER — the label that makes the cadence change gradeable.
 *
 * WHY IT EXISTS. `civitai_app_block_launch_phase_seconds` carries no
 * `app_block_id` (deliberate, for cardinality), and the deployed apps that ship
 * the BLOCK_HELLO accelerator are the majority of launch traffic. BLOCK_HELLO
 * short-circuits exactly the wait the host re-post cadence governs, so a
 * fleet-wide `init_wait` before/after is mostly composed of launches the change
 * barely touches — and that mass cannot be separated without this label. A
 * diluted null would be indistinguishable from "the change did nothing".
 *
 * 🔴 WHAT IT MEANS, pinned as behaviour and not only as prose: `yes` means the
 * GUEST ANNOUNCED during the launch. It does NOT mean "the accelerator fired an
 * extra post" — those are different facts that disagree on real launches, and
 * the ambiguous-label failure is exactly how a relabelled series produced a
 * confident wrong number before.
 */
describe('launchHelloLabel — the code-owned stratifier', () => {
  it('maps the booleans onto the two literals, and nothing else', () => {
    expect(launchHelloLabel(true)).toBe('yes');
    expect(launchHelloLabel(false)).toBe('no');
    expect(APP_BLOCK_LAUNCH_HELLO).toEqual(['yes', 'no', 'unknown']);
  });

  /**
   * 🔴 ABSENT IS ITS OWN VALUE — neither `no` (which would bias the very
   * population being isolated) nor a DROP (which would silently cut coverage of
   * an existing metric, and cut it in a latency-correlated way — see
   * `launchHelloLabel`). It gets `unknown`, so the sample stays visible and
   * `sum without (hello)` still recovers every launch.
   */
  it('🔴 returns `unknown` for an absent or non-boolean value — never "no", never a drop', () => {
    expect(launchHelloLabel(undefined)).toBe('unknown');
    expect(launchHelloLabel(null)).toBe('unknown');
    // Truthy/falsy look-alikes must not be coerced — a client sending a string
    // must not become a label value, and must not be read as a boolean either.
    expect(launchHelloLabel('yes')).toBe('unknown');
    expect(launchHelloLabel('true')).toBe('unknown');
    expect(launchHelloLabel(1)).toBe('unknown');
    expect(launchHelloLabel(0)).toBe('unknown');
    expect(launchHelloLabel({})).toBe('unknown');
  });

  it('🔴 no client-supplied string can become a label value', () => {
    // The beacon field is a BOOLEAN and this is the only mapping, so the label
    // set is closed by construction — the same rule `phase` follows, and what
    // keeps a public beacon body from touching cardinality. A junk value lands
    // in `unknown`, never in a bucket of its own.
    for (const junk of ['maybe', '../../etc', 'yes ', 'YES', '', 'unknown']) {
      expect(launchHelloLabel(junk)).toBe('unknown');
    }
    // TOTAL: whatever it returns is always inside the closed set.
    for (const junk of [undefined, null, 1, {}, [], 'x', true, false]) {
      expect(APP_BLOCK_LAUNCH_HELLO).toContain(launchHelloLabel(junk));
    }
  });
});

/** Total `_count` across every `hello` value for one phase. */
async function phaseCountAllHello(phase: string): Promise<number> {
  const metric = client.register.getSingleMetric(PHASE_METRIC);
  if (!metric) return 0;
  const data = await (metric as unknown as { get(): Promise<{ values: HistPoint[] }> }).get();
  return data.values
    .filter((v) => v.metricName === `${PHASE_METRIC}_count` && v.labels.phase === phase)
    .reduce((a, v) => a + v.value, 0);
}

describe('observeAppBlockLaunch — hello stratification', () => {
  it('labels a hello launch `yes` and a hello-less launch `no`, on BOTH histograms', async () => {
    const app = 'apb_hello_split';
    const pY = await readHist(PHASE_METRIC, '_count', { phase: 'init_wait', hello: 'yes' });
    const pN = await readHist(PHASE_METRIC, '_count', { phase: 'init_wait', hello: 'no' });
    const iY = await readHist(INIT_POSTS_METRIC, '_count', { hello: 'yes' });
    const iN = await readHist(INIT_POSTS_METRIC, '_count', { hello: 'no' });

    observeAppBlockLaunch(app, { totalMs: 900, initWaitMs: 300, initPosts: 1, hello: true });
    observeAppBlockLaunch(app, { totalMs: 900, initWaitMs: 500, initPosts: 3, hello: false });

    expect(await readHist(PHASE_METRIC, '_count', { phase: 'init_wait', hello: 'yes' })).toBe(
      pY + 1
    );
    expect(await readHist(PHASE_METRIC, '_count', { phase: 'init_wait', hello: 'no' })).toBe(
      pN + 1
    );
    expect(await readHist(INIT_POSTS_METRIC, '_count', { hello: 'yes' })).toBe(iY + 1);
    expect(await readHist(INIT_POSTS_METRIC, '_count', { hello: 'no' })).toBe(iN + 1);
  });

  /**
   * 🔴 A STALE-CLIENT BEACON IS BUCKETED, NOT DROPPED — and this test is the
   * reason the earlier design was caught. Dropping it cut `launch_phase_seconds`
   * coverage for any browser bundle older than the label (the beacon route runs
   * no client-version gate, so those persist as long as their tab does), and cut
   * it in a latency-correlated way: a pre-label bundle is also a pre-cadence
   * bundle, so the dropped launches were systematically the slow ones.
   *
   * 🔴 THE ASSERTION IS ON `unknown` MOVING, NOT ONLY ON yes/no STAYING PUT. An
   * earlier version of this test checked only that `yes` and `no` did not move —
   * which stayed green after the drop was removed, because a bucketed sample
   * does not move them either. Green for the wrong reason is the failure mode a
   * negative-only assertion invites.
   */
  it('🔴 buckets a hello-less beacon as `unknown` — coverage is preserved, yes/no stay clean', async () => {
    const app = 'apb_hello_absent';
    const t0 = await readHist(TOTAL_METRIC, '_count', { app_block_id: app });
    const pY = await readHist(PHASE_METRIC, '_count', { phase: 'init_wait', hello: 'yes' });
    const pN = await readHist(PHASE_METRIC, '_count', { phase: 'init_wait', hello: 'no' });
    const pU = await readHist(PHASE_METRIC, '_count', { phase: 'init_wait', hello: 'unknown' });
    const iU = await readHist(INIT_POSTS_METRIC, '_count', { hello: 'unknown' });

    // Exactly what a browser bundle older than this label sends.
    observeAppBlockLaunch(app, { totalMs: 900, initWaitMs: 300, initPosts: 2 });

    // 🔴 The sample IS observed — this is the coverage regression that the
    // drop-based design introduced and this bucket removes.
    expect(await readHist(PHASE_METRIC, '_count', { phase: 'init_wait', hello: 'unknown' })).toBe(
      pU + 1
    );
    expect(await readHist(INIT_POSTS_METRIC, '_count', { hello: 'unknown' })).toBe(iU + 1);
    // …and neither analysis bucket is contaminated.
    expect(await readHist(PHASE_METRIC, '_count', { phase: 'init_wait', hello: 'yes' })).toBe(pY);
    expect(await readHist(PHASE_METRIC, '_count', { phase: 'init_wait', hello: 'no' })).toBe(pN);
    // …and the end-to-end count still matches, as it always did.
    expect(await readHist(TOTAL_METRIC, '_count', { app_block_id: app })).toBe(t0 + 1);
  });

  /**
   * 🔴 THE COVERAGE INVARIANT, stated directly: summing the phase histogram over
   * every `hello` value must recover the pre-label series exactly. This is what
   * makes `sum without (hello)` a safe rewrite of any existing query, and it is
   * the property the drop-based design silently broke.
   */
  it('🔴 sum over all hello values equals one sample per launch — no launch is lost', async () => {
    const app = 'apb_hello_coverage';
    const before = await phaseCountAllHello('init_wait');
    observeAppBlockLaunch(app, { totalMs: 900, initWaitMs: 300, hello: true });
    observeAppBlockLaunch(app, { totalMs: 900, initWaitMs: 300, hello: false });
    observeAppBlockLaunch(app, { totalMs: 900, initWaitMs: 300 }); // stale client
    expect(await phaseCountAllHello('init_wait')).toBe(before + 3);
  });

  it('🔴 the existing discipline still gates the label — total anchor, drop-not-clamp', async () => {
    const app = 'apb_hello_discipline';
    const pN = await readHist(PHASE_METRIC, '_count', { phase: 'init_wait', hello: 'no' });
    const iN = await readHist(INIT_POSTS_METRIC, '_count', { hello: 'no' });
    // An invalid total suppresses everything, label or no label.
    observeAppBlockLaunch(app, { totalMs: 0, initWaitMs: 300, initPosts: 2, hello: false });
    // An out-of-range count is dropped rather than clamped into the `no` bucket.
    observeAppBlockLaunch(app, {
      totalMs: 900,
      initPosts: MAX_APP_BLOCK_LAUNCH_INIT_POSTS + 1,
      hello: false,
    });
    expect(await readHist(PHASE_METRIC, '_count', { phase: 'init_wait', hello: 'no' })).toBe(pN);
    expect(await readHist(INIT_POSTS_METRIC, '_count', { hello: 'no' })).toBe(iN);
  });

  it('carries exactly {phase, hello} on the phase histogram — no app_block_id leaked in', async () => {
    observeAppBlockLaunch('apb_hello_phaselabels', {
      totalMs: 900,
      initWaitMs: 300,
      hello: true,
    });
    const metric = client.register.getSingleMetric(PHASE_METRIC);
    const data = await (metric as unknown as { get(): Promise<{ values: HistPoint[] }> }).get();
    expect(data.values.length).toBeGreaterThan(0);
    for (const v of data.values) {
      expect(
        Object.keys(v.labels)
          .filter((k) => k !== 'le')
          .sort()
      ).toEqual(['hello', 'phase']);
    }
  });
});
