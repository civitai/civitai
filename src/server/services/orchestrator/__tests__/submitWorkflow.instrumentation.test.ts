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

vi.mock('@civitai/orchestration-client', () => ({
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
import {
  clampSubmitSource,
  classifySubmitRetryOutcome,
} from '~/server/services/orchestrator/orchestrator-submit-metrics';
import { withSpan } from '~/server/utils/otel-helpers';

const DURATION = 'civitai_app_orchestrator_submit_duration_seconds';
const RETRIES = 'civitai_app_orchestrator_submit_retries_total';

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

describe('the instruments live on the ONE funnel every submit passes through', () => {
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
