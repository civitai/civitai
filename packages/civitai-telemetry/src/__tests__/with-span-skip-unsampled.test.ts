import {
  context,
  INVALID_SPAN_CONTEXT,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
  type Span,
  type SpanContext,
  type Tracer,
  type TracerProvider,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { setWithSpanSkipUnsampledGate, withSpan } from '../otel-helpers';

// `withSpan` under an unsampled LOCAL parent may skip opening its span when the gate (the
// `otel-withspan-skip-unsampled` flag in the app) is on. Every other parent shape must still
// get a span, because under the app's sampler those spans can be recorded and exported.
//
// The tracer is a spy registered as the global provider, so "a span was opened" is observed
// directly (startActiveSpan calls), and the context manager is the real AsyncLocalStorage one,
// so "the active span inside the work" is real context propagation, not a stub.

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const PARENT_SPAN_ID = 'b7ad6b7169203331';
const CHILD_SPAN_ID = '53995c3f42cd8ad8';

const started: string[] = [];
const childSpans: Span[] = [];

const spyTracer = {
  startSpan: vi.fn(),
  // The two-argument form is the one withSpan uses. Behaves like the SDK: opens a child and runs
  // the callback with it active.
  startActiveSpan: vi.fn((name: string, fn: (span: Span) => unknown) => {
    started.push(name);
    const span = trace.wrapSpanContext({
      traceId: TRACE_ID,
      spanId: CHILD_SPAN_ID,
      traceFlags: TraceFlags.NONE,
    });
    vi.spyOn(span, 'setAttributes');
    vi.spyOn(span, 'end');
    childSpans.push(span);
    return context.with(trace.setSpan(context.active(), span), () => fn(span));
  }),
} as unknown as Tracer;

const spyProvider: TracerProvider = { getTracer: () => spyTracer };

function parentContext(overrides: Partial<SpanContext> = {}): SpanContext {
  return {
    traceId: TRACE_ID,
    spanId: PARENT_SPAN_ID,
    traceFlags: TraceFlags.NONE,
    isRemote: false,
    ...overrides,
  };
}

/** What the SDK hands out for an unsampled local span: non-recording, sampled flag clear. */
const unsampledLocalParent = () => trace.wrapSpanContext(parentContext());

function underParent<T>(parent: Span | undefined, fn: () => T): T {
  const ctx = parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT;
  return context.with(ctx, fn);
}

beforeAll(() => {
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  expect(context.setGlobalContextManager(contextManager)).toBe(true);
  expect(trace.setGlobalTracerProvider(spyProvider)).toBe(true);
});

afterEach(() => {
  setWithSpanSkipUnsampledGate(undefined);
  started.length = 0;
  childSpans.length = 0;
  vi.clearAllMocks();
});

afterAll(() => {
  trace.disable();
  context.disable();
});

describe('withSpan with no gate installed (flag off) — invariant guards: unchanged behaviour', () => {
  it('opens a span under an unsampled local parent, sets its attributes and ends it', () => {
    const result = underParent(unsampledLocalParent(), () =>
      withSpan('gate-off.attrs', { rows: 7 }, () => 'value-a')
    );
    expect(result).toBe('value-a');
    expect(started).toEqual(['gate-off.attrs']);
    expect(childSpans[0].setAttributes).toHaveBeenCalledWith({ rows: 7 });
    expect(childSpans[0].end).toHaveBeenCalledTimes(1);
  });

  it('makes the opened span the active span inside the work', () => {
    const seen = underParent(unsampledLocalParent(), () =>
      withSpan('gate-off.active', () => trace.getActiveSpan()?.spanContext().spanId)
    );
    expect(seen).toBe(CHILD_SPAN_ID);
  });

  it('still opens a span when a gate is installed but answers false', () => {
    setWithSpanSkipUnsampledGate(() => false);
    const result = underParent(unsampledLocalParent(), () =>
      withSpan('gate-false', () => 'value-b')
    );
    expect(result).toBe('value-b');
    expect(started).toEqual(['gate-false']);
  });
});

describe('withSpan with the gate on, under an unsampled local parent', () => {
  it('opens no span and returns the work result', () => {
    setWithSpanSkipUnsampledGate(() => true);
    const work = vi.fn(() => 'value-c');
    const result = underParent(unsampledLocalParent(), () => withSpan('skip.plain', work));
    expect(result).toBe('value-c');
    expect(work).toHaveBeenCalledTimes(1);
    expect(spyTracer.startActiveSpan).not.toHaveBeenCalled();
  });

  it('opens no span for the attributes overload either', () => {
    setWithSpanSkipUnsampledGate(() => true);
    const work = vi.fn(() => 41);
    const result = underParent(unsampledLocalParent(), () =>
      withSpan('skip.attrs', { pairs: 3 }, work)
    );
    expect(result).toBe(41);
    expect(work).toHaveBeenCalledTimes(1);
    expect(spyTracer.startActiveSpan).not.toHaveBeenCalled();
  });

  it('leaves the parent active inside the work, so trace-id readers see the same trace', () => {
    setWithSpanSkipUnsampledGate(() => true);
    const seen = underParent(unsampledLocalParent(), () =>
      withSpan('skip.active', () => trace.getActiveSpan()?.spanContext())
    );
    expect(seen?.spanId).toBe(PARENT_SPAN_ID);
    expect(seen?.traceId).toBe(TRACE_ID);
  });

  it('propagates a synchronous throw unchanged', () => {
    setWithSpanSkipUnsampledGate(() => true);
    const boom = new Error('sync boom');
    expect(() =>
      underParent(unsampledLocalParent(), () =>
        withSpan('skip.throw', () => {
          throw boom;
        })
      )
    ).toThrow(boom);
    expect(spyTracer.startActiveSpan).not.toHaveBeenCalled();
  });

  it('propagates an async result and an async rejection unchanged', async () => {
    setWithSpanSkipUnsampledGate(() => true);
    const resolved = await underParent(unsampledLocalParent(), () =>
      withSpan('skip.async-ok', async () => 'value-d')
    );
    expect(resolved).toBe('value-d');

    const boom = new Error('async boom');
    const rejected = underParent(unsampledLocalParent(), () =>
      withSpan('skip.async-fail', () => Promise.reject(boom))
    );
    await expect(rejected).rejects.toBe(boom);
    expect(spyTracer.startActiveSpan).not.toHaveBeenCalled();
  });
});

describe('withSpan with the gate on still opens a span when the child could be recorded', () => {
  const cases: Array<[string, () => Span | undefined]> = [
    // A new root is ratio-sampled, so some of these are exported today.
    ['no active span', () => undefined],
    // Sampled flag set but not recording — e.g. a parent that already ended. Its children ARE
    // recorded under ParentBased(localParentSampled = AlwaysOn).
    [
      'a sampled, non-recording parent',
      () => trace.wrapSpanContext(parentContext({ traceFlags: TraceFlags.SAMPLED })),
    ],
    // The app's sampler re-applies the ratio to remote parents.
    ['an unsampled REMOTE parent', () => trace.wrapSpanContext(parentContext({ isRemote: true }))],
    // A recording parent, whatever its flags say.
    [
      'a recording parent',
      () => Object.assign(trace.wrapSpanContext(parentContext()), { isRecording: () => true }),
    ],
    // An invalid parent context is treated as no parent by the sampler.
    ['an invalid parent context', () => trace.wrapSpanContext(INVALID_SPAN_CONTEXT)],
  ];

  it.each(cases)('%s', (label, makeParent) => {
    setWithSpanSkipUnsampledGate(() => true);
    const result = underParent(makeParent(), () => withSpan(`kept:${label}`, () => label));
    expect(result).toBe(label);
    expect(started).toEqual([`kept:${label}`]);
  });

  it('a gate that throws falls back to opening the span', () => {
    setWithSpanSkipUnsampledGate(() => {
      throw new Error('gate broke');
    });
    const result = underParent(unsampledLocalParent(), () => withSpan('gate-throws', () => 5));
    expect(result).toBe(5);
    expect(started).toEqual(['gate-throws']);
  });
});

describe('the gate is shared across module copies', () => {
  // The server build can emit this module more than once; the app installs the gate once.
  it('a gate installed through one copy is honoured by another copy', async () => {
    vi.resetModules();
    const copyB = await import('../otel-helpers');
    expect(copyB.withSpan).not.toBe(withSpan); // a genuinely separate module instance

    setWithSpanSkipUnsampledGate(() => true); // installed through the FIRST copy
    const result = underParent(unsampledLocalParent(), () =>
      copyB.withSpan('copy-b.skip', () => 'value-e')
    );
    expect(result).toBe('value-e');
    expect(spyTracer.startActiveSpan).not.toHaveBeenCalled();

    setWithSpanSkipUnsampledGate(undefined);
    underParent(unsampledLocalParent(), () => copyB.withSpan('copy-b.kept', () => null));
    expect(started).toEqual(['copy-b.kept']);
  });
});
