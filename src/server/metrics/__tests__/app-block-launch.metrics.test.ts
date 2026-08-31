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
  launchSampleSeconds,
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
    const beforeToken = await readHist(PHASE_METRIC, '_count', { phase: 'token_mint' });
    const beforeInit = await readHist(PHASE_METRIC, '_count', { phase: 'init_wait' });

    observeAppBlockLaunch(app, { totalMs: 1_100, tokenMintMs: 180, initWaitMs: 700 });

    expect(await readHist(TOTAL_METRIC, '_count', { app_block_id: app })).toBe(beforeTotal + 1);
    expect(await readHist(PHASE_METRIC, '_count', { phase: 'token_mint' })).toBe(beforeToken + 1);
    expect(await readHist(PHASE_METRIC, '_count', { phase: 'init_wait' })).toBe(beforeInit + 1);
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
    observeAppBlockLaunch(app, { totalMs: 2_500 });
    expect(await readHist(TOTAL_METRIC, '_sum', { app_block_id: app })).toBeCloseTo(
      before + 2.5,
      6
    );
  });

  it('🔴 `total` is the ANCHOR — an invalid total suppresses the PHASES too', async () => {
    const app = 'apb_launch_anchor';
    const beforeTotal = await readHist(TOTAL_METRIC, '_count', { app_block_id: app });
    const beforePhase = await readHist(PHASE_METRIC, '_count', { phase: 'init_wait' });

    // A perfectly valid phase, but no usable total.
    observeAppBlockLaunch(app, { totalMs: 0, initWaitMs: 700 });
    expect(await readHist(TOTAL_METRIC, '_count', { app_block_id: app })).toBe(beforeTotal);
    expect(await readHist(PHASE_METRIC, '_count', { phase: 'init_wait' })).toBe(beforePhase);

    // 🔴 POSITIVE CONTROL. Without this, the two zeros above are indistinguishable
    // from a histogram that is wired to nothing at all. Same phase, same value,
    // only the total made valid → the counter MUST move by exactly 1.
    observeAppBlockLaunch(app, { totalMs: 1_100, initWaitMs: 700 });
    expect(await readHist(TOTAL_METRIC, '_count', { app_block_id: app })).toBe(beforeTotal + 1);
    expect(await readHist(PHASE_METRIC, '_count', { phase: 'init_wait' })).toBe(beforePhase + 1);
  });

  it('🔴 omits a ZERO phase while still recording the total', async () => {
    const app = 'apb_launch_zero_phase';
    const beforeTotal = await readHist(TOTAL_METRIC, '_count', { app_block_id: app });
    const beforeToken = await readHist(PHASE_METRIC, '_count', { phase: 'token_mint' });

    observeAppBlockLaunch(app, { totalMs: 1_100, tokenMintMs: 0 });

    expect(await readHist(TOTAL_METRIC, '_count', { app_block_id: app })).toBe(beforeTotal + 1);
    expect(await readHist(PHASE_METRIC, '_count', { phase: 'token_mint' })).toBe(beforeToken);
  });

  it('🔴 DROPS an out-of-range phase rather than clamping it onto the top bucket', async () => {
    const app = 'apb_launch_drop_phase';
    const beforeToken = await readHist(PHASE_METRIC, '_count', { phase: 'token_mint' });
    const beforeSum = await readHist(PHASE_METRIC, '_sum', { phase: 'token_mint' });

    observeAppBlockLaunch(app, { totalMs: 1_100, tokenMintMs: 61_000 });

    expect(await readHist(PHASE_METRIC, '_count', { phase: 'token_mint' })).toBe(beforeToken);
    // The thing a clamp would break: _sum must be untouched, not +60.
    expect(await readHist(PHASE_METRIC, '_sum', { phase: 'token_mint' })).toBeCloseTo(beforeSum, 6);
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
    observeAppBlockLaunch('apb_launch_buckets', { totalMs: 300, tokenMintMs: 300 });

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
    observeAppBlockLaunch(app, { totalMs: 50 });
    expect(await readBucket(TOTAL_METRIC, '0.1', { app_block_id: app })).toBe(1);

    const before025 = await readBucket(TOTAL_METRIC, '0.25', { app_block_id: app });
    const before04 = await readBucket(TOTAL_METRIC, '0.4', { app_block_id: app });
    const before06 = await readBucket(TOTAL_METRIC, '0.6', { app_block_id: app });

    observeAppBlockLaunch(app, { totalMs: 300 });
    observeAppBlockLaunch(app, { totalMs: 500 });

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
    observeAppBlockLaunch(app, { totalMs: 28_000 });

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
