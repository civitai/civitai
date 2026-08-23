/**
 * Instrumentation contract for the orchestrator SUBMIT leg.
 *
 * WHY this file exists: `orchestrator.generateFromGraph` consumes ~9.5 server-s/s at the daily peak —
 * ~12.6% of ALL dp-prod tRPC procedure wall time — and 82–98% of that latency sat in one contiguous
 * interval with no span and no metric anywhere in it. The interval is structurally three things
 * (pure-CPU metadata assembly, `refreshBlobUrlsInBody`, and the submit POST); the first two were
 * excluded by live measurement, so the submit POST carries essentially the whole endpoint. These tests
 * pin the four instruments that close that gap:
 *
 *   1. a `gen:submit:orchestrator` span around the retry-wrapped submit, plus a PER-ATTEMPT child span
 *      (so a retried submit is distinguishable from a single slow one);
 *   2. the `submit` op on the existing `civitai_app_orchestrator_read_duration_seconds` histogram;
 *   3. the `onRetry` hook — which shipped with the retry wrapper and has had ZERO call sites, leaving a
 *      3x latency multiplier completely uncounted — wired to a retries counter;
 *   4. W3C trace-context propagation on the outbound call, so the (already-instrumented) orchestrator
 *      can join the trace.
 *
 * 🔴 SCOPE OF WHAT THESE TESTS PROVE. They prove the CODE emits: a real (SDK-registered) span, a real
 * prom-client observation on the shared registry, a real counter increment, and a real `traceparent` on
 * the outbound options. They do NOT prove a span reaches Tempo in production — that additionally
 * depends on `OTEL_ENABLED=true` and survives head sampling at ratio 0.1
 * (`instrumentation.node.ts:182-185`), neither of which a unit test can exercise. To make the assertions
 * meaningful rather than tautological, the span tests install a REAL `NodeTracerProvider` with an
 * in-memory exporter and read back the exported spans — a `vi.fn()` stub for `withSpan` would prove
 * only that we called our own wrapper.
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
import { withSpan } from '~/server/utils/otel-helpers';

const DURATION = 'civitai_app_orchestrator_read_duration_seconds';
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

async function histCount(op: string, outcome: string): Promise<number> {
  const metric = promClient.register.getSingleMetric(DURATION) as promClient.Histogram<string>;
  if (!metric) return 0;
  const data = await metric.get();
  const row = data.values.find(
    (v) =>
      v.metricName === `${DURATION}_count` && v.labels.op === op && v.labels.outcome === outcome
  );
  return (row?.value as number) ?? 0;
}

async function retryCount(attempt: string, outcome: string): Promise<number> {
  const metric = promClient.register.getSingleMetric(RETRIES) as promClient.Counter<string>;
  if (!metric) return 0;
  const data = await metric.get();
  const row = data.values.find((v) => v.labels.attempt === attempt && v.labels.outcome === outcome);
  return (row?.value as number) ?? 0;
}

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

describe('gen:submit:orchestrator — the span over the uninstrumented interval', () => {
  it('emits a real, SDK-exported span around the submit (positive control: the exporter DOES see spans)', async () => {
    mockSubmitWorkflow.mockResolvedValue(okResult());

    await submitWorkflow({ token: 'tok', body: {} as never, query: {} as never });

    // If the tracer provider were not registered this list would be empty and every other span
    // assertion in this file would pass vacuously. Assert non-empty FIRST.
    expect(exporter.getFinishedSpans().length).toBeGreaterThan(0);
    expect(spanNames()).toContain('gen:submit:orchestrator');
  });

  it('records the attempts count on the parent span, so a 3x-retry park is distinguishable from one long attempt', async () => {
    mockSubmitWorkflow
      .mockResolvedValueOnce(serverErrorResult(500))
      .mockResolvedValueOnce(serverErrorResult(503))
      .mockResolvedValueOnce(okResult('wf-3'));

    await runWithFakeTimers(() =>
      submitWorkflow({ token: 'tok', body: {} as never, query: {} as never })
    );

    const parent = spansNamed('gen:submit:orchestrator');
    expect(parent).toHaveLength(1);
    // 🔴 The load-bearing attribute: `attempts` is what the wrapper has always returned and every
    // caller has always discarded. Without it a ~95s span is unattributable between `3 x ~30s` and
    // one ~95s attempt.
    expect(parent[0].attributes['orchestrator.submit.attempts']).toBe(3);
    expect(parent[0].attributes['orchestrator.submit.whatif']).toBe(false);
  });

  it('emits ONE per-attempt child span per attempt, numbered, nested under the parent', async () => {
    mockSubmitWorkflow
      .mockResolvedValueOnce(serverErrorResult(502))
      .mockResolvedValueOnce(okResult('wf-2'));

    await runWithFakeTimers(() =>
      submitWorkflow({ token: 'tok', body: {} as never, query: {} as never })
    );

    const attempts = spansNamed('gen:submit:orchestrator:attempt');
    expect(attempts).toHaveLength(2);
    expect(attempts.map((s) => s.attributes['orchestrator.submit.attempt'])).toEqual([1, 2]);
    // Nesting is the whole point: the children must sit UNDER the submit span, not beside it, or a
    // trace cannot show three attempts adding up to one park.
    const parent = spansNamed('gen:submit:orchestrator')[0];
    for (const a of attempts) expect(a.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });

  it('a single slow submit produces exactly ONE attempt span (the discriminator this PR exists for)', async () => {
    mockSubmitWorkflow.mockResolvedValue(okResult());

    await submitWorkflow({ token: 'tok', body: {} as never, query: {} as never });

    expect(spansNamed('gen:submit:orchestrator:attempt')).toHaveLength(1);
    expect(
      spansNamed('gen:submit:orchestrator')[0].attributes['orchestrator.submit.attempts']
    ).toBe(1);
  });
});

describe('civitai_app_orchestrator_read_duration_seconds{op="submit"} — sizing the leg', () => {
  it('records exactly one ok observation per successful submit', async () => {
    mockSubmitWorkflow.mockResolvedValue(okResult());
    const before = await histCount('submit', 'ok');

    await submitWorkflow({ token: 'tok', body: {} as never, query: {} as never });

    expect(await histCount('submit', 'ok')).toBe(before + 1);
  });

  it('records ONE observation (not one per attempt) for a retried submit — the caller-visible interval', async () => {
    mockSubmitWorkflow
      .mockResolvedValueOnce(serverErrorResult(500))
      .mockResolvedValueOnce(okResult());
    const before = await histCount('submit', 'ok');

    await runWithFakeTimers(() =>
      submitWorkflow({ token: 'tok', body: {} as never, query: {} as never })
    );

    // Whole-call timing: 2 attempts, ONE observation. Anything else double-counts the leg against the
    // procedure's own wall time, which is the single comparison this metric exists to support.
    expect(await histCount('submit', 'ok')).toBe(before + 1);
  });

  it('classifies an exhausted per-attempt abort as outcome=timeout, not error', async () => {
    mockSubmitWorkflow.mockResolvedValue(timeoutResolveResult());
    const beforeTimeout = await histCount('submit', 'timeout');
    const beforeError = await histCount('submit', 'error');

    await runWithFakeTimers(() =>
      submitWorkflow({ token: 'tok', body: {} as never, query: { whatif: true } as never }).catch(
        (e) => e
      )
    );

    expect(await histCount('submit', 'timeout')).toBe(beforeTimeout + 1);
    expect(await histCount('submit', 'error')).toBe(beforeError);
  });

  it('records an error observation when the final attempt THROWS', async () => {
    mockSubmitWorkflow.mockRejectedValue(new TypeError('boom'));
    const before = await histCount('submit', 'error');

    await runWithFakeTimers(() =>
      submitWorkflow({ token: 'tok', body: {} as never, query: {} as never }).catch((e) => e)
    );

    expect(await histCount('submit', 'error')).toBe(before + 1);
  });

  it('carries buckets above 30s, or the entire population this metric was added to see collapses into +Inf', async () => {
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
    // Purely additive: every pre-existing boundary must survive, or existing read queries change meaning.
    for (const le of ['0.005', '0.05', '0.5', '1', '2', '5', '10', '20', '30'])
      expect(buckets.has(le)).toBe(true);
  });
});

describe('onRetry → civitai_app_orchestrator_submit_retries_total (the 3x multiplier, finally counted)', () => {
  it('increments once per fired retry, labeled by the FAILED attempt and its 5xx status', async () => {
    mockSubmitWorkflow
      .mockResolvedValueOnce(serverErrorResult(500))
      .mockResolvedValueOnce(serverErrorResult(503))
      .mockResolvedValueOnce(okResult());
    const before1 = await retryCount('1', '500');
    const before2 = await retryCount('2', '503');

    await runWithFakeTimers(() =>
      submitWorkflow({ token: 'tok', body: {} as never, query: {} as never })
    );

    // 🔴 The assertion the mutation test targets: a 3-attempt submit contributes exactly 2 retries,
    // attributed to the attempt that failed and the status it failed with.
    expect(await retryCount('1', '500')).toBe(before1 + 1);
    expect(await retryCount('2', '503')).toBe(before2 + 1);
  });

  // ⚠️ INVARIANT GUARD, not regression coverage: this passes at the pre-change base too (the counter
  // did not exist there, so 0 === 0). It pins that the counter stays quiet on the happy path — worth
  // having, but it is NOT evidence the wiring works. The two tests above it are.
  it('does NOT increment when the submit succeeds first try', async () => {
    mockSubmitWorkflow.mockResolvedValue(okResult());
    const before = await retryCount('1', '500');

    await submitWorkflow({ token: 'tok', body: {} as never, query: {} as never });

    expect(await retryCount('1', '500')).toBe(before);
  });

  it('labels a status-less failure (thrown network error / fired abort) as outcome=network', async () => {
    mockSubmitWorkflow.mockRejectedValueOnce(timeoutError()).mockResolvedValueOnce(okResult());
    const before = await retryCount('1', 'network');

    await runWithFakeTimers(() =>
      submitWorkflow({ token: 'tok', body: {} as never, query: {} as never })
    );

    expect(await retryCount('1', 'network')).toBe(before + 1);
  });

  // ⚠️ INVARIANT GUARD, not regression coverage: also green at the pre-change base, because the hook
  // itself always worked — it simply had no call sites. It pins the hook's contract for the direct
  // callers (orchestrator.service.ts, blocks.router.ts) so a future refactor of the wrapper cannot
  // quietly drop the parameter that this PR's wiring now depends on.
  it('still counts the retry when the caller passes its OWN onRetry (wiring must not be caller-exclusive)', async () => {
    mockSubmitWorkflow
      .mockResolvedValueOnce(serverErrorResult(504))
      .mockResolvedValueOnce(okResult());
    const seen: number[] = [];

    await runWithFakeTimers(() =>
      submitWorkflowWithRetry(
        { client: {} as never, body: {} as never },
        { baseDelayMs: 1, onRetry: ({ attempt, status }) => seen.push(status ?? attempt) }
      )
    );

    expect(seen).toEqual([504]);
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
    const attemptSpan = spansNamed('gen:submit:orchestrator:attempt')[0];
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

  // 🔴 These MUST run inside an active span. Outside one the propagator injects nothing,
  // `withTraceHeaders` short-circuits and returns its argument by reference, and every assertion below
  // would pass while testing nothing at all — the merge branches would never execute.
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
