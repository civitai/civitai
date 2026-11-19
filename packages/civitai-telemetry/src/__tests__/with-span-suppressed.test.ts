import {
  context,
  propagation,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
  type Span,
  type Tracer,
  type TracerProvider,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { suppressTracing, W3CTraceContextPropagator } from '@opentelemetry/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  isTracingSuppressedIn,
  setWithSpanSkipUnsampledGate,
  traceContextHeaders,
  unsampledTraceparent,
  withSpan,
} from '../otel-helpers';

// Under SUPPRESSED tracing — how the app's root pre-sampler (src/server/otel-root-presample.ts)
// runs an unsampled request — the SDK hands out a non-recording, invalid span for everything.
// These pin what otel-helpers does there: withSpan opens nothing when its gate is on, and
// traceContextHeaders still sends an UNSAMPLED parent so callees decide as they did before.

const started: string[] = [];
const spyTracer = {
  startSpan: vi.fn(),
  startActiveSpan: vi.fn((name: string, fn: (span: Span) => unknown) => {
    started.push(name);
    const span = trace.wrapSpanContext({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: '53995c3f42cd8ad8',
      traceFlags: TraceFlags.NONE,
    });
    return context.with(trace.setSpan(context.active(), span), () => fn(span));
  }),
} as unknown as Tracer;
const spyProvider: TracerProvider = { getTracer: () => spyTracer };

beforeAll(() => {
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  expect(context.setGlobalContextManager(contextManager)).toBe(true);
  expect(trace.setGlobalTracerProvider(spyProvider)).toBe(true);
  expect(propagation.setGlobalPropagator(new W3CTraceContextPropagator())).toBe(true);
});

afterEach(() => {
  setWithSpanSkipUnsampledGate(undefined);
  started.length = 0;
  vi.clearAllMocks();
});

afterAll(() => {
  trace.disable();
  propagation.disable();
  context.disable();
});

const suppressed = <T>(fn: () => T): T => context.with(suppressTracing(ROOT_CONTEXT), fn);

describe('isTracingSuppressedIn', () => {
  it("recognises @opentelemetry/core's own suppressTracing (pins the context key)", () => {
    expect(isTracingSuppressedIn(suppressTracing(ROOT_CONTEXT))).toBe(true);
    expect(isTracingSuppressedIn(ROOT_CONTEXT)).toBe(false);
    expect(suppressed(() => isTracingSuppressedIn())).toBe(true);
  });
});

describe('withSpan under suppressed tracing', () => {
  it('gate on: opens no span and returns the work result', () => {
    setWithSpanSkipUnsampledGate(() => true);
    const work = vi.fn(() => 'value');
    expect(suppressed(() => withSpan('suppressed.on', work))).toBe('value');
    expect(work).toHaveBeenCalledTimes(1);
    expect(spyTracer.startActiveSpan).not.toHaveBeenCalled();
  });

  it('gate on: still opens a span when tracing is NOT suppressed and there is no parent (a new root)', () => {
    setWithSpanSkipUnsampledGate(() => true);
    withSpan('not-suppressed.root', () => undefined);
    expect(started).toEqual(['not-suppressed.root']);
  });

  it('gate off: opens the span as before (invariant guard)', () => {
    setWithSpanSkipUnsampledGate(() => false);
    suppressed(() => withSpan('suppressed.off', () => undefined));
    expect(started).toEqual(['suppressed.off']);
  });

  it('no gate installed: opens the span as before (invariant guard)', () => {
    suppressed(() => withSpan('suppressed.nogate', () => undefined));
    expect(started).toEqual(['suppressed.nogate']);
  });

  it('a throwing gate falls back to opening the span', () => {
    setWithSpanSkipUnsampledGate(() => {
      throw new Error('gate');
    });
    suppressed(() => withSpan('suppressed.throw', () => undefined));
    expect(started).toEqual(['suppressed.throw']);
  });
});

describe('traceContextHeaders', () => {
  const UNSAMPLED = /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/;

  it('under suppressed tracing sends a valid, UNSAMPLED traceparent', () => {
    const headers = suppressed(() => traceContextHeaders());
    expect(headers.traceparent).toMatch(UNSAMPLED);
    expect(headers.traceparent).not.toMatch(/^00-0{32}-/);
  });

  it('under suppressed tracing a fresh id each call', () => {
    const a = suppressed(() => traceContextHeaders()).traceparent;
    const b = suppressed(() => traceContextHeaders()).traceparent;
    expect(a).not.toBe(b);
  });

  it('with an active span, injects that span as before (invariant guard)', () => {
    const span = trace.wrapSpanContext({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: TraceFlags.SAMPLED,
    });
    const headers = context.with(trace.setSpan(ROOT_CONTEXT, span), () => traceContextHeaders());
    expect(headers.traceparent).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  });

  it('with no span and tracing not suppressed, sends nothing, as before (invariant guard)', () => {
    expect(context.with(ROOT_CONTEXT, () => traceContextHeaders())).toEqual({});
  });

  it('unsampledTraceparent is well formed', () => {
    expect(unsampledTraceparent()).toMatch(UNSAMPLED);
  });
});
