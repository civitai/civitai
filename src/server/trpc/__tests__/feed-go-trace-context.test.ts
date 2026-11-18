/**
 * Trace context on the feed-go shadow and Go-first probe POSTs (`~/server/trpc/feed-go-shadow`):
 * each POST carries the W3C `traceparent` of the request that was sampled, so feed-go's spans join
 * Node's trace, and the request's span is marked `feed_go.shadow_sampled` so a Tempo query can find
 * the mirrored requests.
 *
 * Runs against the real `@opentelemetry/api` globals with the W3C propagator and a minimal
 * synchronous context manager (the app's own one is async-hooks based; the sampler reads the
 * context synchronously in `begin` / `probe`, which is all this needs). The shadow POST is flushed
 * OUTSIDE the request's context on purpose: production sends it from `setImmediate` after the
 * response, so the header must come from the context the request was sampled in.
 */
import {
  context,
  propagation,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
  type Context,
  type ContextManager,
  type Span,
} from '@opentelemetry/api';
import { suppressTracing, W3CTraceContextPropagator } from '@opentelemetry/core';
import superjson from 'superjson';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFeedGoShadow, type FeedGoShadowConfig } from '~/server/trpc/feed-go-shadow';

const SHADOW_URL = 'http://feed-go.test:9090/internal/shadow/image.getImagesAsPostsInfinite';
const PROBE_URL = 'http://feed-go.test:9090/internal/probe/image.getImagesAsPostsInfinite';
const MODELS_URL = 'http://feed-go.test:9090/internal/shadow/model.getAll';
const V1_URL = 'http://feed-go.test:9090/internal/shadow/api/v1/images';
const INPUT = '{"json":{"modelVersionId":9,"limit":20}}';

const TRACE_ID = '5c1e0d4a9b8f7e6d5c4b3a2918070605';
const SPAN_ID = '1a2b3c4d5e6f7081';
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;
const UNSAMPLED = /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/;

/** Synchronous stack context manager: enough for `context.with` + `context.active()`. */
class StackContextManager implements ContextManager {
  private stack: Context[] = [];
  active(): Context {
    return this.stack[this.stack.length - 1] ?? ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    this.stack.push(ctx);
    try {
      return fn.call(thisArg, ...args);
    } finally {
      this.stack.pop();
    }
  }
  bind<T>(_ctx: Context, target: T): T {
    return target;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    this.stack = [];
    return this;
  }
}

beforeAll(() => {
  expect(context.setGlobalContextManager(new StackContextManager())).toBe(true);
  expect(propagation.setGlobalPropagator(new W3CTraceContextPropagator())).toBe(true);
});

afterAll(() => {
  propagation.disable();
  context.disable();
});

/** A request span whose attribute writes are recorded. */
function requestSpan() {
  const attributes: Record<string, unknown> = {};
  const span = {
    spanContext: () => ({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED }),
    setAttribute: vi.fn((k: string, v: unknown) => {
      attributes[k] = v;
      return span;
    }),
    setAttributes: vi.fn((attrs: Record<string, unknown>) => {
      Object.assign(attributes, attrs);
      return span;
    }),
    isRecording: () => true,
  } as unknown as Span;
  return { span, attributes, ctx: trace.setSpan(ROOT_CONTEXT, span) };
}

function config(overrides: Partial<FeedGoShadowConfig> = {}): FeedGoShadowConfig {
  return {
    url: SHADOW_URL,
    v1ImagesUrl: V1_URL,
    infiniteUrl: undefined,
    modelGetAllUrl: MODELS_URL,
    v1ModelsUrl: undefined,
    v1ModelsIdUrl: undefined,
    rate: 1,
    timeoutMs: 500,
    maxInFlight: 4,
    maxPerSecond: 1000,
    probeUrl: PROBE_URL,
    probeInfiniteUrl: undefined,
    probeModelGetAllUrl: undefined,
    probeRate: 1,
    ...overrides,
  };
}

function harness(opts: { random?: number; probe?: boolean } = {}) {
  const queued: Array<() => void> = [];
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () => new Response(null, { status: 202 })
  );
  const shadow = createFeedGoShadow({
    config: config(),
    enabled: () => true,
    enabledV1Images: () => true,
    enabledModelGetAll: () => true,
    enabledProbe: () => opts.probe ?? true,
    random: () => opts.random ?? 0,
    fetch: fetchMock as unknown as typeof fetch,
    record: () => undefined,
    recordEncode: () => undefined,
    recordProbe: () => undefined,
    now: () => 0,
    epochNow: () => 1_763_200_000_000,
    schedule: (fn) => void queued.push(fn),
  });
  const flush = async () => {
    // Deliberately outside any `context.with`: the scheduled send runs after the request.
    expect(context.active()).toBe(ROOT_CONTEXT);
    while (queued.length) queued.shift()!();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  const headersFor = (url: string) =>
    fetchMock.mock.calls.filter(([u]) => u === url).map(([, init]) => init.headers);
  return { shadow, fetchMock, flush, headersFor };
}

function trpcRequest(procedure = 'image.getImagesAsPostsInfinite') {
  return {
    method: 'GET',
    headers: { host: 'civitai.com' },
    query: { trpc: procedure, input: INPUT },
  };
}

/** The route's order: begin + probe inside the request's context, the handler, finish. */
function serveTrpc(h: ReturnType<typeof harness>, ctx: Context, procedure?: string) {
  return context.with(ctx, () => {
    const sample = h.shadow.begin(trpcRequest(procedure));
    h.shadow.probe(sample);
    const data = { items: [] };
    h.shadow.run(sample, () => h.shadow.capture(data, superjson.serialize(data), false));
    if (sample) h.shadow.finish(sample, 200);
    return sample;
  });
}

describe('traceparent on the feed-go POSTs', () => {
  it('shadow POST carries the sampled request span, even though it is sent after the request', async () => {
    const h = harness({ probe: false });
    const { ctx } = requestSpan();
    serveTrpc(h, ctx);
    await h.flush();

    expect(h.headersFor(SHADOW_URL)).toEqual([
      { 'content-type': 'application/json', traceparent: TRACEPARENT },
    ]);
  });

  it('Go-first probe POST carries the same traceparent', async () => {
    const h = harness();
    const { ctx } = requestSpan();
    serveTrpc(h, ctx);
    await h.flush();

    expect(h.headersFor(PROBE_URL)).toEqual([
      { 'content-type': 'application/json', traceparent: TRACEPARENT },
    ]);
    expect(h.headersFor(SHADOW_URL)).toEqual([
      { 'content-type': 'application/json', traceparent: TRACEPARENT },
    ]);
  });

  it('model.getAll shadow POST carries it too', async () => {
    const h = harness({ probe: false });
    const { ctx } = requestSpan();
    serveTrpc(h, ctx, 'model.getAll');
    await h.flush();

    expect(h.headersFor(MODELS_URL)).toEqual([
      { 'content-type': 'application/json', traceparent: TRACEPARENT },
    ]);
  });

  it('the v1 REST shadow POST carries it too', async () => {
    const h = harness();
    const { ctx } = requestSpan();
    context.with(ctx, () => {
      const sample = h.shadow.beginV1Images({
        method: 'GET',
        url: '/api/v1/images?limit=2',
        headers: { host: 'civitai.com' },
        query: { limit: '2' },
      });
      expect(sample).toBeDefined();
      h.shadow.captureV1Images(sample!, { items: [] });
      h.shadow.finish(sample!, 200);
    });
    await h.flush();

    expect(h.headersFor(V1_URL)).toEqual([
      { 'content-type': 'application/json', traceparent: TRACEPARENT },
    ]);
  });

  it('no active span: no traceparent at all (headers exactly as before)', async () => {
    const h = harness();
    serveTrpc(h, ROOT_CONTEXT);
    await h.flush();

    expect(h.headersFor(SHADOW_URL)).toEqual([{ 'content-type': 'application/json' }]);
    expect(h.headersFor(PROBE_URL)).toEqual([{ 'content-type': 'application/json' }]);
  });

  it('tracing suppressed (an unsampled request): a valid UNSAMPLED traceparent', async () => {
    const h = harness();
    serveTrpc(h, suppressTracing(ROOT_CONTEXT));
    await h.flush();

    const [shadowHeaders] = h.headersFor(SHADOW_URL) as Array<Record<string, string>>;
    const [probeHeaders] = h.headersFor(PROBE_URL) as Array<Record<string, string>>;
    expect(shadowHeaders.traceparent).toMatch(UNSAMPLED);
    // One sampled request, one trace: the probe and the shadow name the same parent.
    expect(probeHeaders.traceparent).toBe(shadowHeaders.traceparent);
  });
});

describe('feed_go.shadow_sampled on the request span', () => {
  it('a sampled request is marked with the endpoint it was mirrored for, and probed', () => {
    const h = harness();
    const { ctx, attributes } = requestSpan();
    serveTrpc(h, ctx, 'image.getImagesAsPostsInfinite');

    expect(attributes).toEqual({
      'feed_go.shadow_sampled': true,
      'feed_go.endpoint': 'as-posts',
      'feed_go.probed': true,
    });
  });

  it('model.getAll is marked under its own endpoint, not probed with the probe off', () => {
    const h = harness({ probe: false });
    const { ctx, attributes } = requestSpan();
    serveTrpc(h, ctx, 'model.getAll');

    expect(attributes).toEqual({
      'feed_go.shadow_sampled': true,
      'feed_go.endpoint': 'model-getall',
    });
  });

  it('an unsampled request is not marked (positive control: the cases above are)', () => {
    // rate is 1: a draw of exactly 1 is the only one not below it (`random() >= rate` skips).
    const h = harness({ random: 1 });
    const { ctx, attributes, span } = requestSpan();
    expect(serveTrpc(h, ctx)).toBeUndefined();

    expect(attributes).toEqual({});
    expect(span.setAttributes).not.toHaveBeenCalled();
  });
});
