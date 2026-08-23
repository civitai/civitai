/**
 * Instrumentation contract for the orchestrator SUBMIT leg.
 *
 * WHY this file exists: `orchestrator.generateFromGraph` consumes ~9.5 server-s/s at the daily peak —
 * ~12.6% of ALL tRPC procedure wall time — and 82–98% of that latency sat in one contiguous interval
 * with no span and no metric anywhere in it. The interval is structurally three things (pure-CPU
 * metadata assembly, `refreshBlobUrlsInBody`, and the submit POST); the first two were excluded by live
 * measurement, so the submit POST carries essentially the whole endpoint. These tests pin the
 * instruments that close that gap:
 *
 *   1. an `orchestrator:submit` span around the retry-wrapped submit, plus a PER-ATTEMPT child span
 *      (so a retried submit is distinguishable from a single slow one);
 *   2. a sibling `civitai_app_orchestrator_submit_duration_seconds{source,outcome}` histogram — its
 *      VALUE as well as its count, because the whole deliverable of this work is a duration number;
 *   3. the `onRetry` hook — which shipped with the retry wrapper and has had ZERO call sites, leaving a
 *      3x latency multiplier completely uncounted — wired to a retries counter;
 *   4. W3C trace-context propagation on the outbound call, so the (already-instrumented) orchestrator
 *      can join the trace.
 *
 * 🔴 EVERY instrument is recorded in `submitWorkflowWithRetry`, not in `submitWorkflow`. Every caller of
 * `submitWorkflow` reaches the wrapper but not the reverse — image ingestion calls the wrapper directly —
 * so the wrapper is the lower of the two funnels. Tests below pin that placement explicitly, because
 * instrumenting a level up silently puts the spans and the histogram on DIFFERENT populations and
 * contaminates the attempts↔duration join. (The wrapper is NOT the app's only route to the submit
 * endpoint: five call sites use the generated client directly. That limit is documented on the metric
 * help strings rather than tested here, because closing it would be a behaviour change.)
 *
 * 🔴 SCOPE OF WHAT THESE TESTS PROVE. They prove the CODE emits: a real (SDK-registered) span, a real
 * prom-client observation on the shared registry with a PLAUSIBLE value in the right unit, a real
 * counter increment, and a real `traceparent` on the outbound options. They do NOT prove a span reaches
 * Tempo in production — that additionally depends on `OTEL_ENABLED=true` and survives head sampling at
 * ratio 0.1 (`instrumentation.node.ts:182-185`), neither of which a unit test can exercise. To make the
 * assertions meaningful rather than tautological, the span tests install a REAL `NodeTracerProvider`
 * with an in-memory exporter and read back the exported spans — a `vi.fn()` stub for `withSpan` would
 * prove only that we called our own wrapper.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import promClient from 'prom-client';
import type * as TelemetryClient from '@civitai/telemetry/client';
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-node';

const { mockSubmitWorkflow } = vi.hoisted(() => ({ mockSubmitWorkflow: vi.fn() }));

vi.mock('@civitai/client', () => ({
  submitWorkflow: mockSubmitWorkflow,
  addWorkflowTag: vi.fn(),
  deleteWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  patchWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  removeWorkflowTag: vi.fn(),
  updateWorkflow: vi.fn(),
  refreshBlob: vi.fn(),
  handleError: vi.fn((e: unknown) => (typeof e === 'string' ? e : 'err')),
}));

vi.mock('~/server/services/orchestrator/client', () => ({
  createOrchestratorClient: vi.fn(() => ({})),
  internalOrchestratorClient: {},
}));

vi.mock('~/env/other', () => ({ isDev: false, isProd: true }));

// Use the REAL prom-client registry (not the global test stub in src/__tests__/setup.ts) so the
// histogram/counter assertions read back what was ACTUALLY recorded on the shared `civitai_app_*`
// registry that /api/metrics scrapes — the same technique as orchestrator-read-metrics.test.ts.
vi.mock('~/server/prom/client', async () => {
  const pkg = await vi.importActual<typeof TelemetryClient>('@civitai/telemetry/client');
  return pkg;
});

import {
  submitWorkflow,
  submitWorkflowWithRetry,
  withTraceHeaders,
} from '~/server/services/orchestrator/workflows';
import { observeOrchestratorRead } from '~/server/services/orchestrator/orchestrator-read-metrics';
import {
  clampSubmitSource,
  classifySubmitRetryOutcome,
  submitSourceForSurface,
} from '~/server/services/orchestrator/orchestrator-submit-metrics';
import { GENERATION_SURFACES } from '~/shared/data-graph/generation/model-substitution';
import { withSpan } from '~/server/utils/otel-helpers';

const DURATION = 'civitai_app_orchestrator_submit_duration_seconds';
const READ_DURATION = 'civitai_app_orchestrator_read_duration_seconds';
const RETRIES = 'civitai_app_orchestrator_submit_retries_total';
const TIMEOUTS = 'civitai_app_orchestrator_submit_timeouts_total';

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;

beforeAll(() => {
  // A REAL tracer provider. `.register()` installs the AsyncLocalStorage context manager AND the W3C
  // propagator, i.e. the same two globals `instrumentation.node.ts` installs in production — so both
  // the span assertions and the traceparent assertions below run against real machinery. Without a
  // registered provider the `@opentelemetry/api` tracer is a no-op, the propagator injects nothing,
  // and EVERY assertion in this file would pass vacuously; the first test is the positive control
  // that proves it did not.
  provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

beforeEach(() => {
  vi.clearAllMocks();
  // 🔴 `clearAllMocks` clears CALLS but NOT the `mockResolvedValueOnce` queue. A test whose submit
  // throws before consuming every queued value leaves the remainder in place, and the next test's own
  // `…Once(…)` lands BEHIND it — so that test silently exercises the previous test's fixture and can
  // pass or fail for a reason that has nothing to do with it. `mockReset` empties the queue. (Found by
  // exactly that: the 600-status reachability test read a leftover success and counted no retry.)
  mockSubmitWorkflow.mockReset();
  exporter.reset();
});

const okResult = (id = 'wf-1') => ({ data: { id }, response: { status: 200 } });
const serverErrorResult = (status = 500) => ({ data: undefined, response: { status } });
const timeoutError = () =>
  Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const timeoutResolveResult = () => ({
  data: undefined,
  response: undefined,
  error: timeoutError(),
});

const spanNames = (): string[] => exporter.getFinishedSpans().map((s: ReadableSpan) => s.name);
const spansNamed = (name: string): ReadableSpan[] =>
  exporter.getFinishedSpans().filter((s: ReadableSpan) => s.name === name);

async function histRow(
  metricName: string,
  suffix: string,
  match: (labels: Record<string, string | number>) => boolean
): Promise<number> {
  const metric = promClient.register.getSingleMetric(metricName) as promClient.Histogram<string>;
  if (!metric) return 0;
  const data = await metric.get();
  const row = data.values.find(
    (v) => v.metricName === `${metricName}${suffix}` && match(v.labels as never)
  );
  return (row?.value as number) ?? 0;
}

const histCount = (source: string, outcome: string) =>
  histRow(DURATION, '_count', (l) => l.source === source && l.outcome === outcome);
/** `_sum` — the observed VALUE, in seconds. The one number this whole change exists to produce. */
const histSum = (source: string, outcome: string) =>
  histRow(DURATION, '_sum', (l) => l.source === source && l.outcome === outcome);
const histBucket = (source: string, outcome: string, le: string) =>
  histRow(
    DURATION,
    '_bucket',
    (l) => l.source === source && l.outcome === outcome && String(l.le) === le
  );

async function counterValue(
  metricName: string,
  match: (labels: Record<string, string | number>) => boolean
): Promise<number> {
  const metric = promClient.register.getSingleMetric(metricName) as promClient.Counter<string>;
  if (!metric) return 0;
  const data = await metric.get();
  const row = data.values.find((v) => match(v.labels as never));
  return (row?.value as number) ?? 0;
}

const retryCount = (source: string, attempt: string, outcome: string) =>
  counterValue(
    RETRIES,
    (l) => l.source === source && l.attempt === attempt && l.outcome === outcome
  );
const timeoutCount = (source: string) => counterValue(TIMEOUTS, (l) => l.source === source);

// Backoff uses real setTimeout; skip it deterministically so a 3-attempt case doesn't cost ~2s.
const runWithFakeTimers = async <T>(fn: () => Promise<T>): Promise<T> => {
  vi.useFakeTimers();
  try {
    const p = fn();
    await vi.runAllTimersAsync();
    return await p;
  } finally {
    vi.useRealTimers();
  }
};

describe('orchestrator:submit — the span over the uninstrumented interval', () => {
  it('emits a real, SDK-exported span around the submit (positive control: the exporter DOES see spans)', async () => {
    mockSubmitWorkflow.mockResolvedValue(okResult());

    await submitWorkflow({ token: 'tok', body: {} as never, query: {} as never });

    // If the tracer provider were not registered this list would be empty and every other span
    // assertion in this file would pass vacuously. Assert non-empty FIRST.
    expect(exporter.getFinishedSpans().length).toBeGreaterThan(0);
    expect(spanNames()).toContain('orchestrator:submit');
  });

  it('records the attempts count on the parent span, so a 3x-retry park is distinguishable from one long attempt', async () => {
    mockSubmitWorkflow
      .mockResolvedValueOnce(serverErrorResult(500))
      .mockResolvedValueOnce(serverErrorResult(503))
      .mockResolvedValueOnce(okResult('wf-3'));

    await runWithFakeTimers(() =>
      submitWorkflow({ token: 'tok', source: 'generate', body: {} as never, query: {} as never })
    );

    const parent = spansNamed('orchestrator:submit');
    expect(parent).toHaveLength(1);
    // 🔴 The load-bearing attribute: `attempts` is what the wrapper has always returned and every
    // caller has always discarded. Without it a ~95s span is unattributable between `3 x ~30s` and
    // one ~95s attempt.
    expect(parent[0].attributes['orchestrator.submit.attempts']).toBe(3);
    expect(parent[0].attributes['orchestrator.submit.source']).toBe('generate');
  });

  it('emits ONE per-attempt child span per attempt, numbered, nested under the parent', async () => {
    mockSubmitWorkflow
      .mockResolvedValueOnce(serverErrorResult(502))
      .mockResolvedValueOnce(okResult('wf-2'));

    await runWithFakeTimers(() =>
      submitWorkflow({ token: 'tok', body: {} as never, query: {} as never })
    );

    const attempts = spansNamed('orchestrator:submit:attempt');
    expect(attempts).toHaveLength(2);
    expect(attempts.map((s) => s.attributes['orchestrator.submit.attempt'])).toEqual([1, 2]);
    // Nesting is the whole point: the children must sit UNDER the submit span, not beside it, or a
    // trace cannot show three attempts adding up to one park.
    const parent = spansNamed('orchestrator:submit')[0];
    for (const a of attempts) expect(a.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });

  it('a single slow submit produces exactly ONE attempt span (the discriminator this PR exists for)', async () => {
    mockSubmitWorkflow.mockResolvedValue(okResult());

    await submitWorkflow({ token: 'tok', body: {} as never, query: {} as never });

    expect(spansNamed('orchestrator:submit:attempt')).toHaveLength(1);
    expect(spansNamed('orchestrator:submit')[0].attributes['orchestrator.submit.attempts']).toBe(1);
  });
});

describe('civitai_app_orchestrator_submit_duration_seconds — sizing the leg', () => {
  it('records exactly one ok observation per successful submit', async () => {
    mockSubmitWorkflow.mockResolvedValue(okResult());
    const before = await histCount('generate', 'ok');

    await submitWorkflow({
      token: 'tok',
      source: 'generate',
      body: {} as never,
      query: {} as never,
    });

    expect(await histCount('generate', 'ok')).toBe(before + 1);
  });

  // 🔴 THE VALUE TEST. Every other assertion in this file proves only that "a number was written" —
  // which is exactly how a 1000x unit error ships green. Three mutants survive a suite without this
  // test: the duration hardcoded to 0, the timer restarted immediately before the observation, and
  // MILLISECONDS instead of seconds. All three are caught here, and by two independent assertions
  // each (the `_sum` band and the bucket placement), because the entire deliverable of this change is
  // a duration number and nothing else in the file constrains it.
  it('observes the duration in SECONDS, and it tracks the real elapsed time', async () => {
    const DELAY_MS = 60;
    mockSubmitWorkflow.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(okResult()), DELAY_MS))
    );
    const beforeSum = await histSum('other', 'ok');
    const beforeFast = await histBucket('other', 'ok', '0.05');
    const beforeSlow = await histBucket('other', 'ok', '5');

    // REAL timers: a faked clock would let a hardcoded observation coincide with a faked elapsed.
    await submitWorkflow({ token: 'tok', body: {} as never, query: {} as never });

    const observed = (await histSum('other', 'ok')) - beforeSum;
    // Lower bound kills `0` and kills a timer restarted just before the observation (both ≈ 0).
    // `setTimeout(60)` cannot fire earlier than 60ms, so 30ms is a floor with 2x of slack.
    expect(observed).toBeGreaterThanOrEqual(DELAY_MS / 1000 / 2);
    // Upper bound kills MILLISECONDS-instead-of-seconds, which would record ≈60 here. A 60ms sleep
    // cannot take 5 real seconds even on a loaded runner, so this band is wide AND still 12x below
    // the value the unit bug produces.
    expect(observed).toBeLessThan(5);

    // Independent of the sum: bucket placement. A ≥60ms observation in seconds MUST fall above the
    // 0.05 boundary and at or below 5 — the exact inverse of where the millisecond bug puts it.
    expect(await histBucket('other', 'ok', '0.05')).toBe(beforeFast);
    expect(await histBucket('other', 'ok', '5')).toBe(beforeSlow + 1);
  });

  it('records ONE observation (not one per attempt) for a retried submit — the caller-visible interval', async () => {
    mockSubmitWorkflow
      .mockResolvedValueOnce(serverErrorResult(500))
      .mockResolvedValueOnce(okResult());
    const before = await histCount('generate', 'ok');

    await runWithFakeTimers(() =>
      submitWorkflow({ token: 'tok', source: 'generate', body: {} as never, query: {} as never })
    );

    // Whole-call timing: 2 attempts, ONE observation. Anything else double-counts the leg against the
    // procedure's own wall time, which is the single comparison this metric exists to support.
    expect(await histCount('generate', 'ok')).toBe(before + 1);
  });

  it('classifies an exhausted per-attempt abort as outcome=timeout, and counts it on the timeouts counter', async () => {
    mockSubmitWorkflow.mockResolvedValue(timeoutResolveResult());
    const beforeTimeout = await histCount('whatIf', 'timeout');
    const beforeError = await histCount('whatIf', 'error');
    const beforeCounter = await timeoutCount('whatIf');

    await runWithFakeTimers(() =>
      submitWorkflow({ token: 'tok', body: {} as never, query: { whatif: true } as never }).catch(
        (e) => e
      )
    );

    expect(await histCount('whatIf', 'timeout')).toBe(beforeTimeout + 1);
    expect(await histCount('whatIf', 'error')).toBe(beforeError);
    expect(await timeoutCount('whatIf')).toBe(beforeCounter + 1);
  });

  it('records an error observation when the final attempt THROWS', async () => {
    mockSubmitWorkflow.mockRejectedValue(new TypeError('boom'));
    const before = await histCount('generate', 'error');

    await runWithFakeTimers(() =>
      submitWorkflow({
        token: 'tok',
        source: 'generate',
        body: {} as never,
        query: {} as never,
      }).catch((e) => e)
    );

    expect(await histCount('generate', 'error')).toBe(before + 1);
  });

  it('carries buckets above 30s, or the entire population this metric was added to see collapses into +Inf', async () => {
    // prom-client materializes bucket rows only for label sets that have been observed, so make one
    // observation here rather than depending on an earlier test having run.
    mockSubmitWorkflow.mockResolvedValue(okResult());
    await submitWorkflowWithRetry({ client: {} as never, body: {} as never });

    const metric = promClient.register.getSingleMetric(DURATION) as promClient.Histogram<string>;
    const data = await metric.get();
    const buckets = new Set(
      data.values
        .filter((v) => v.metricName === `${DURATION}_bucket`)
        .map((v) => String(v.labels.le))
    );
    // The generate submit has NO per-attempt timeout and its observed ceiling recurs at ~95s.
    expect(buckets.has('45')).toBe(true);
    expect(buckets.has('90')).toBe(true);
    // …and a low end fine enough to resolve the healthy population, or the metric only sees parks.
    expect(buckets.has('0.05')).toBe(true);
  });

  // ⚠️ INVARIANT GUARD, not regression coverage — measured green at the pre-change base, because the
  // base read family already looked like this. It pins the DESIGN DECISION that the submit lives in its own
  // family: prom-client applies one bucket array family-wide, so putting `submit` on the read family
  // would mint >30s boundaries for two funnels hard-capped at 20s (never anything but a copy of
  // le=30), force every read query to filter `op!="submit"` forever, and make `sum by (le)`
  // non-monotonic across a rollout. This test fails the moment someone merges the two back together.
  it('leaves the READ family completely untouched — no submit op, no widened buckets', async () => {
    // One real read observation, so the read histogram materializes its bucket rows and this test is
    // reading the family's ACTUAL boundaries rather than an empty value list that would vacuously pass.
    observeOrchestratorRead('getWorkflow', 'ok', 0.01);

    const metric = promClient.register.getSingleMetric(
      READ_DURATION
    ) as promClient.Histogram<string>;
    const data = await metric.get();
    const buckets = new Set(
      data.values
        .filter((v) => v.metricName === `${READ_DURATION}_bucket`)
        .map((v) => String(v.labels.le))
    );
    for (const le of ['45', '60', '90', '120']) expect(buckets.has(le)).toBe(false);
    expect(buckets.has('20')).toBe(true);
    expect(data.values.some((v) => v.labels.op === 'submit')).toBe(false);
  });
});

describe('the instruments live on the ONE funnel every submit passes through', () => {
  // 🔴 REGRESSION COVERAGE for the seam. Image ingestion calls `submitWorkflowWithRetry` DIRECTLY and
  // never touches `submitWorkflow`. Instrumenting a level up gave the attempt spans one population and
  // the duration histogram another — the two signals this change exists to JOIN. This test builds the
  // direct-call state and demands both signals from it.
  it('a direct wrapper call (the image-ingestion shape) gets BOTH the span and the histogram', async () => {
    mockSubmitWorkflow.mockResolvedValue(okResult());
    const before = await histCount('imageIngest', 'ok');

    await submitWorkflowWithRetry(
      { client: {} as never, body: {} as never },
      { source: 'imageIngest' }
    );

    expect(await histCount('imageIngest', 'ok')).toBe(before + 1);
    expect(spansNamed('orchestrator:submit')).toHaveLength(1);
    expect(spansNamed('orchestrator:submit:attempt')).toHaveLength(1);
    expect(spansNamed('orchestrator:submit')[0].attributes['orchestrator.submit.source']).toBe(
      'imageIngest'
    );
  });

  // 🔴 The span's `attempts` attribute is claimed to settle "is a ~95s park 3x30s or one long attempt?".
  // It was set only on the RESOLVE path, so the throw-shaped park — a network failure that exhausts every
  // attempt — produced a span with NO attempt count, which is one of the exactly two shapes the attribute
  // exists to tell apart. The fired-AbortSignal park resolves instead, which is why this read as covered.
  it('stamps `attempts` on the parent span even when the submit exhausts its attempts by THROWING', async () => {
    mockSubmitWorkflow.mockRejectedValue(new TypeError('socket hang up'));

    await runWithFakeTimers(() =>
      submitWorkflowWithRetry({ client: {} as never, body: {} as never }).catch((e) => e)
    );

    const parent = spansNamed('orchestrator:submit');
    expect(parent).toHaveLength(1);
    expect(parent[0].attributes['orchestrator.submit.attempts']).toBe(3);
  });

  it('an unlabelled caller lands in `other`, never silently in `generate`', async () => {
    mockSubmitWorkflow.mockResolvedValue(okResult());
    const beforeOther = await histCount('other', 'ok');
    const beforeGenerate = await histCount('generate', 'ok');

    await submitWorkflowWithRetry({ client: {} as never, body: {} as never });

    expect(await histCount('other', 'ok')).toBe(beforeOther + 1);
    // The whole point of the label: `generate` must mean the generate leg and nothing else, or the
    // comparison against generateFromGraph's own wall time is contaminated by every other funnel.
    expect(await histCount('generate', 'ok')).toBe(beforeGenerate);
  });

  it('a whatIf is always its own population, even when the caller declares another source', async () => {
    mockSubmitWorkflow.mockResolvedValue(okResult());
    const beforeWhatIf = await histCount('whatIf', 'ok');
    const beforeGenerate = await histCount('generate', 'ok');

    await submitWorkflow({
      token: 'tok',
      source: 'generate',
      body: {} as never,
      query: { whatif: true } as never,
    });

    expect(await histCount('whatIf', 'ok')).toBe(beforeWhatIf + 1);
    expect(await histCount('generate', 'ok')).toBe(beforeGenerate);
  });

  // The coercion lives in the WRAPPER, not in `submitWorkflow`, so it applies to a direct caller too.
  // Pinning this is the difference between the label's docstring ("any submit carrying
  // query.whatif === true") being true and being true-only-for-callers-who-took-the-long-way.
  it('classifies a DIRECT wrapper call carrying query.whatif as whatIf, not as its declared source', async () => {
    mockSubmitWorkflow.mockResolvedValue(okResult());
    const beforeWhatIf = await histCount('whatIf', 'ok');
    const beforeIngest = await histCount('imageIngest', 'ok');

    await submitWorkflowWithRetry(
      { client: {} as never, body: {} as never, query: { whatif: true } as never },
      { source: 'imageIngest' }
    );

    expect(await histCount('whatIf', 'ok')).toBe(beforeWhatIf + 1);
    expect(await histCount('imageIngest', 'ok')).toBe(beforeIngest);
  });

  // 🔴 The TYPE on `source` is a compile-time guarantee only, and excess-property checking does not
  // apply to spread properties — so a call site doing `submitWorkflow({ ...opts, token })` where `opts`
  // carries a stray `source` string would mint an unbounded label on a hot-path histogram with a fully
  // green suite. The runtime clamp is what actually bounds it; this is the test that the clamp exists.
  it('clamps an out-of-enum source to `other` rather than minting an unbounded label', async () => {
    mockSubmitWorkflow.mockResolvedValue(okResult());
    const beforeOther = await histCount('other', 'ok');

    await submitWorkflowWithRetry(
      { client: {} as never, body: {} as never },
      { source: 'definitely-not-a-source' as never }
    );

    expect(await histCount('other', 'ok')).toBe(beforeOther + 1);
    expect(await histCount('definitely-not-a-source', 'ok')).toBe(0);
    // …and the retries counter shares the clamp, not just the histogram.
    expect(clampSubmitSource('definitely-not-a-source')).toBe('other');
    expect(clampSubmitSource(undefined)).toBe('other');
    expect(clampSubmitSource('preset')).toBe('preset');
  });
});

describe('onRetry → civitai_app_orchestrator_submit_retries_total (the 3x multiplier, finally counted)', () => {
  it('increments once per fired retry, labeled by the FAILED attempt and its 5xx status', async () => {
    mockSubmitWorkflow
      .mockResolvedValueOnce(serverErrorResult(500))
      .mockResolvedValueOnce(serverErrorResult(503))
      .mockResolvedValueOnce(okResult());
    const before1 = await retryCount('generate', '1', '500');
    const before2 = await retryCount('generate', '2', '503');

    await runWithFakeTimers(() =>
      submitWorkflow({ token: 'tok', source: 'generate', body: {} as never, query: {} as never })
    );

    // 🔴 The assertion the mutation test targets: a 3-attempt submit contributes exactly 2 retries,
    // attributed to the attempt that failed and the status it failed with.
    expect(await retryCount('generate', '1', '500')).toBe(before1 + 1);
    expect(await retryCount('generate', '2', '503')).toBe(before2 + 1);
  });

  // ⚠️ INVARIANT GUARD, not regression coverage: this passes at the pre-change base too (the counter
  // did not exist there, so 0 === 0). It pins that the counter stays quiet on the happy path — worth
  // having, but it is NOT evidence the wiring works. The test above it is.
  it('does NOT increment when the submit succeeds first try', async () => {
    mockSubmitWorkflow.mockResolvedValue(okResult());
    const before = await retryCount('generate', '1', '500');

    await submitWorkflow({
      token: 'tok',
      source: 'generate',
      body: {} as never,
      query: {} as never,
    });

    expect(await retryCount('generate', '1', '500')).toBe(before);
  });

  it('labels a status-less failure (thrown network error / fired abort) as outcome=network', async () => {
    mockSubmitWorkflow.mockRejectedValueOnce(timeoutError()).mockResolvedValueOnce(okResult());
    const before = await retryCount('generate', '1', 'network');

    await runWithFakeTimers(() =>
      submitWorkflow({ token: 'tok', source: 'generate', body: {} as never, query: {} as never })
    );

    expect(await retryCount('generate', '1', 'network')).toBe(before + 1);
  });

  it('counts the retry even when the caller supplies its OWN onRetry — the hook cannot be displaced', async () => {
    mockSubmitWorkflow
      .mockResolvedValueOnce(serverErrorResult(504))
      .mockResolvedValueOnce(okResult());
    const before = await retryCount('other', '1', '504');
    const seen: number[] = [];

    await runWithFakeTimers(() =>
      submitWorkflowWithRetry(
        { client: {} as never, body: {} as never },
        { baseDelayMs: 1, onRetry: ({ attempt, status }) => seen.push(status ?? attempt) }
      )
    );

    // Both must hold: the caller's hook still runs, AND our counter fired anyway. Before this change
    // the built-in count was the CALLER's job, so a caller that supplied a hook got no counter at all.
    expect(seen).toEqual([504]);
    expect(await retryCount('other', '1', '504')).toBe(before + 1);
  });

  it('counts the retry even when the caller-supplied onRetry THROWS, and still surfaces that throw', async () => {
    mockSubmitWorkflow
      .mockResolvedValueOnce(serverErrorResult(502))
      .mockResolvedValueOnce(okResult());
    const before = await retryCount('other', '1', '502');

    const thrown = await runWithFakeTimers(() =>
      submitWorkflowWithRetry(
        { client: {} as never, body: {} as never },
        {
          baseDelayMs: 1,
          onRetry: () => {
            throw new Error('caller hook exploded');
          },
        }
      ).catch((e: unknown) => e)
    );

    expect(await retryCount('other', '1', '502')).toBe(before + 1);
    // 🔴 BOTH halves. Asserting only the counter leaves the caller-visible behaviour unpinned, and the
    // most natural future "hardening" — wrapping `onRetry?.(info)` in a try/catch — would swallow the
    // throw and change what callers see while this test stayed green.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('caller hook exploded');
  });
});

describe('submitSourceForSurface — keeping a CRON JOB out of the headline population', () => {
  // 🔴 `generateFromGraph` has two entry points and only one is the tRPC procedure: the preset/comics
  // path reaches the same code, and one of ITS callers is the `process-enqueued-comic-panels` cron job,
  // which runs outside the request path entirely. If `source` were stamped flat as `generate` there, the
  // number that gets divided against `orchestrator.generateFromGraph`'s wall time would include a
  // background job — the same contamination the label exists to remove, one level further up.
  it('splits `preset` out of `generate`, so `generate` is the tRPC procedure and nothing else', () => {
    expect(submitSourceForSurface('preset')).toBe('preset');
    expect(submitSourceForSurface('onsite')).toBe('generate');
    expect(submitSourceForSurface('api')).toBe('generate');
  });

  it('falls to `other` on an absent surface — an unknown caller must never inflate `generate`', () => {
    expect(submitSourceForSurface(undefined)).toBe('other');
  });

  // Pins the mapping to the WHOLE surface enum rather than the three values spelled above, so a surface
  // added later cannot silently default into `generate` without this test being looked at.
  it('maps every declared GenerationSurface, and only `preset` leaves the generate population', () => {
    const mapped = Object.fromEntries(
      GENERATION_SURFACES.map((x) => [x, submitSourceForSurface(x)])
    );
    expect(mapped).toEqual({
      api: 'generate',
      block: 'generate',
      onsite: 'generate',
      preset: 'preset',
    });
  });
});

describe('classifySubmitRetryOutcome — the bound that keeps `outcome` a bounded label', () => {
  // 🔴 The `>= 500 && <= 599` window is what caps this label at 102 values. Removing EITHER end lets a
  // hot-path counter mint a new series for any integer an upstream proxy puts on the wire — and until
  // these tests the bound was asserted only in prose, so deleting it left the suite fully green.
  //
  // ⚠️ SCOPE, measured: the three PURE cases below are green against the pre-change base as well, so
  // they are NOT base-regression coverage — the classifier ships in this change and its guard was never
  // absent. What they ARE is the kill for the mutant that removes the bound (verified: deleting
  // `<= 599` turns the first one red with `expected '600' to be 'other'`). The REACHABILITY test at the
  // end of the block is the one that is genuinely red at base, because the wiring it drives is new.
  it('rejects a status ABOVE the 5xx window, so a rogue upstream cannot mint unbounded series', () => {
    expect(classifySubmitRetryOutcome(600)).toBe('other');
    expect(classifySubmitRetryOutcome(999)).toBe('other');
    expect(classifySubmitRetryOutcome(599)).toBe('599');
  });

  it('rejects a status BELOW the 5xx window', () => {
    expect(classifySubmitRetryOutcome(499)).toBe('other');
    expect(classifySubmitRetryOutcome(0)).toBe('other');
    expect(classifySubmitRetryOutcome(500)).toBe('500');
  });

  it('maps a missing status to `network`, and a non-integer status to `other`', () => {
    expect(classifySubmitRetryOutcome(undefined)).toBe('network');
    expect(classifySubmitRetryOutcome(503.5)).toBe('other');
    expect(classifySubmitRetryOutcome(Number.NaN)).toBe('other');
  });

  // Reachability: the guard is not dead code behind an earlier check. The retry predicate is
  // `status == null || status >= 500`, so a 600 IS retryable and DOES reach the classifier on the live
  // path — proven here by driving the real wrapper rather than calling the classifier directly.
  it('is REACHABLE from the live retry path: an out-of-window 5xx-ish status lands in `other`', async () => {
    mockSubmitWorkflow
      .mockResolvedValueOnce(serverErrorResult(600))
      .mockResolvedValueOnce(okResult());
    const beforeOther = await retryCount('other', '1', 'other');
    const beforeLiteral = await retryCount('other', '1', '600');

    await runWithFakeTimers(() =>
      submitWorkflowWithRetry({ client: {} as never, body: {} as never }, { baseDelayMs: 1 })
    );

    expect(await retryCount('other', '1', 'other')).toBe(beforeOther + 1);
    expect(await retryCount('other', '1', '600')).toBe(beforeLiteral);
  });
});

describe('W3C trace-context propagation on the outbound submit', () => {
  it('sends a traceparent bound to the ATTEMPT span, so the orchestrator joins THIS trace', async () => {
    mockSubmitWorkflow.mockResolvedValue(okResult());

    await submitWorkflow({ token: 'tok', body: {} as never, query: {} as never });

    const headers = mockSubmitWorkflow.mock.calls[0][0].headers as Record<string, string>;
    expect(headers).toBeTruthy();
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);

    // 🔴 Not just "a traceparent exists" — it must carry the ATTEMPT span's ids, or the orchestrator's
    // spans parent onto nothing useful. A test asserting only the regex would pass on a hardcoded string.
    const attemptSpan = spansNamed('orchestrator:submit:attempt')[0];
    const [, traceId, spanId] = headers.traceparent.split('-');
    expect(traceId).toBe(attemptSpan.spanContext().traceId);
    expect(spanId).toBe(attemptSpan.spanContext().spanId);
  });

  it('gives each ATTEMPT a distinct span id in its traceparent (same trace, different parent)', async () => {
    mockSubmitWorkflow
      .mockResolvedValueOnce(serverErrorResult(500))
      .mockResolvedValueOnce(okResult());

    await runWithFakeTimers(() =>
      submitWorkflow({ token: 'tok', body: {} as never, query: {} as never })
    );

    const tp1 = (mockSubmitWorkflow.mock.calls[0][0].headers as Record<string, string>).traceparent;
    const tp2 = (mockSubmitWorkflow.mock.calls[1][0].headers as Record<string, string>).traceparent;
    expect(tp1.split('-')[1]).toBe(tp2.split('-')[1]); // same trace id
    expect(tp1.split('-')[2]).not.toBe(tp2.split('-')[2]); // different span id per attempt
  });

  // 🔴 These MUST run inside an active span. Outside one the propagator injects nothing and
  // `withTraceHeaders` short-circuits, returning its argument BY REFERENCE without entering any merge
  // branch. The record case would then pass while testing nothing (it gets its own object back); the
  // Headers and array cases would fail on the `traceparent` assertion rather than exercise the
  // normalization. Either way the branches under test never run — hence the span.
  //
  // ⚠️ SCOPE: the Headers and array branches are UNREACHABLE from any call site in this repo today.
  // Every caller passes a plain record, and one layer down the generated sdk spreads `headers` into a
  // plain object anyway (`sdk.gen.js`), which would defeat a `Headers` return before it reached the
  // wire. These two cases pin the helper's own contract, not a live path.
  it('withTraceHeaders never clobbers a caller-supplied header, in any of the three header shapes', () => {
    withSpan('test:headers', () => {
      // Plain record — the shape every caller in this repo uses.
      const record = withTraceHeaders({ 'x-caller': 'keep', traceparent: 'caller-wins' }) as Record<
        string,
        string
      >;
      expect(record['x-caller']).toBe('keep');
      expect(record.traceparent).toBe('caller-wins');

      // A `Headers` instance would be silently EMPTIED by a naive object spread — pin that it is not,
      // and that the trace header was still added alongside.
      const asHeaders = withTraceHeaders(new Headers({ 'x-caller': 'keep' })) as Headers;
      expect(asHeaders.get('x-caller')).toBe('keep');
      expect(asHeaders.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-/);

      // A [name, value][] array would spread to INDEX keys — pin that it is normalized instead.
      const asArray = withTraceHeaders([['x-caller', 'keep']] as unknown as Headers) as Headers;
      expect(asArray.get('x-caller')).toBe('keep');
      expect(asArray.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-/);
    });
  });

  it('withTraceHeaders is a pass-through when no span is active (tracing off ⇒ byte-identical behavior)', () => {
    const original = { 'x-caller': 'keep' };
    // No active span → the propagator injects nothing → the caller's value is returned BY REFERENCE.
    // This is the negative control for the test above: it proves the merge branches are reached there
    // because of the span, not unconditionally.
    expect(withTraceHeaders(original)).toBe(original);
    expect(withTraceHeaders(undefined)).toBeUndefined();
  });
});
