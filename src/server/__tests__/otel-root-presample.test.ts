import { createServer, get, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  trace,
  type Context,
} from '@opentelemetry/api';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  NodeTracerProvider,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  type Sampler,
} from '@opentelemetry/sdk-trace-node';
import { isTracingSuppressed } from '@opentelemetry/core';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRootPresampleIgnoreHook,
  PresampledRootSampler,
  resetRootPresampleForTests,
  setRootPresampleGate,
} from '~/server/otel-root-presample';
import { buildOtelInstrumentations } from '~/server/otel-instrumentations';

// Root pre-sampling (`otel-root-presample`): the inbound HTTP instrumentation's ignore hook draws
// the head-sampling decision before any span work. These drive the hook and the sampler in the
// order the instrumentation does — hook, then (synchronously) the root SERVER span — against the
// REAL trace SDK with an in-memory exporter, so "recorded" means exported, not a stub's say-so.

const RATIO = 0.1;
// What the HTTP instrumentation passes for an inbound request; the exact set is not the point,
// only that the exported span carries exactly what was passed.
const SERVER_ATTRS = {
  'http.request.method': 'GET',
  'url.path': '/models/123',
  'url.scheme': 'http',
  'server.address': 'example.test',
};

const req = (headers: Record<string, string> = {}) => ({ headers } as unknown as IncomingMessage);

function provider(delegate: Sampler) {
  const exporter = new InMemorySpanExporter();
  const tp = new BasicTracerProvider({
    sampler: new PresampledRootSampler(delegate),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { tracer: tp.getTracer('test'), exporter };
}

/** The app's head sampler, at a fixed ratio. */
const appSampler = (ratio: number) =>
  new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(ratio),
    remoteParentSampled: new TraceIdRatioBasedSampler(ratio),
  });

/** A request's spans as the instrumentation and Next produce them: root SERVER span plus a child. */
function serveRequest(
  tracer: ReturnType<typeof provider>['tracer'],
  parent: Context = ROOT_CONTEXT
) {
  const root = tracer.startSpan('GET', { kind: SpanKind.SERVER, attributes: SERVER_ATTRS }, parent);
  const child = tracer.startSpan('render route', {}, trace.setSpan(parent, root));
  child.end();
  root.end();
  return root;
}

afterEach(() => {
  resetRootPresampleForTests();
});

describe('the ignore hook', () => {
  it('with no gate installed (flag never armed): never ignores, never marks', () => {
    const hook = createRootPresampleIgnoreHook(RATIO, () => 0.99);
    expect(hook(req())).toBe(false);
    const { tracer, exporter } = provider(new AlwaysOffSampler());
    serveRequest(tracer);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('with the gate off: never ignores, never marks', () => {
    setRootPresampleGate(() => false);
    const hook = createRootPresampleIgnoreHook(RATIO, () => 0.01);
    expect(hook(req())).toBe(false);
    const { tracer, exporter } = provider(new AlwaysOffSampler());
    serveRequest(tracer);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('a throwing gate reads as off', () => {
    setRootPresampleGate(() => {
      throw new Error('gate');
    });
    expect(createRootPresampleIgnoreHook(RATIO, () => 0.99)(req())).toBe(false);
  });

  it('gate on, unsampled draw: ignores the request', () => {
    setRootPresampleGate(() => true);
    expect(createRootPresampleIgnoreHook(RATIO, () => 0.5)(req())).toBe(true);
  });

  it('gate on, a request WITH a traceparent: not pre-sampled, the normal sampler decides', () => {
    setRootPresampleGate(() => true);
    const hook = createRootPresampleIgnoreHook(RATIO, () => 0.01);
    expect(
      hook(req({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00' }))
    ).toBe(false);
    // No mark: an AlwaysOff delegate keeps the root unrecorded.
    const { tracer, exporter } = provider(new AlwaysOffSampler());
    serveRequest(tracer);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('keeps the sampled share at the ratio', () => {
    setRootPresampleGate(() => true);
    let i = 0;
    // A uniform grid over [0, 1): exactly RATIO of it falls below RATIO.
    const hook = createRootPresampleIgnoreHook(RATIO, () => i++ / 1000);
    let kept = 0;
    for (let n = 0; n < 1000; n++) if (!hook(req())) kept++;
    expect(kept).toBe(100);
  });
});

describe('a pre-sampled request', () => {
  it('records its root SERVER span and children, even under a ratio-0 delegate', () => {
    setRootPresampleGate(() => true);
    const hook = createRootPresampleIgnoreHook(RATIO, () => 0.01);
    const { tracer, exporter } = provider(appSampler(0));

    // POSITIVE CONTROL: without the hook, this delegate records nothing.
    serveRequest(tracer);
    expect(exporter.getFinishedSpans()).toHaveLength(0);

    expect(hook(req())).toBe(false);
    serveRequest(tracer);
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(['render route', 'GET']);
  });

  it('exports the same span name, kind and attributes as a ratio-sampled request', () => {
    setRootPresampleGate(() => true);
    const hook = createRootPresampleIgnoreHook(RATIO, () => 0.01);

    const normal = provider(appSampler(1)); // what a sampled draw of the ratio sampler records
    serveRequest(normal.tracer);

    const pre = provider(appSampler(0));
    hook(req());
    serveRequest(pre.tracer);

    const shape = (e: InMemorySpanExporter) =>
      e.getFinishedSpans().map((s) => ({
        name: s.name,
        kind: s.kind,
        attributes: s.attributes,
        hasParent: s.parentSpanContext !== undefined,
        sampled: s.spanContext().traceFlags,
      }));
    expect(shape(pre.exporter)).toEqual(shape(normal.exporter));
    expect(shape(pre.exporter)).toHaveLength(2);
  });

  it('the mark is used once: the next root goes back to the delegate', () => {
    setRootPresampleGate(() => true);
    createRootPresampleIgnoreHook(RATIO, () => 0.01)(req());
    const { tracer, exporter } = provider(new AlwaysOffSampler());
    serveRequest(tracer);
    serveRequest(tracer);
    expect(exporter.getFinishedSpans().filter((s) => s.name === 'GET')).toHaveLength(1);
  });

  it('the mark never applies to a non-SERVER span, and that span clears it', () => {
    setRootPresampleGate(() => true);
    createRootPresampleIgnoreHook(RATIO, () => 0.01)(req());
    const { tracer, exporter } = provider(new AlwaysOffSampler());
    tracer.startSpan('internal', { kind: SpanKind.INTERNAL }, ROOT_CONTEXT).end();
    serveRequest(tracer);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('the mark never applies to a span with a parent', () => {
    setRootPresampleGate(() => true);
    createRootPresampleIgnoreHook(RATIO, () => 0.01)(req());
    const { tracer, exporter } = provider(new AlwaysOffSampler());
    const remoteParent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: 0,
      isRemote: true,
    });
    serveRequest(tracer, remoteParent);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('an unused mark is gone after the current task', async () => {
    setRootPresampleGate(() => true);
    createRootPresampleIgnoreHook(RATIO, () => 0.01)(req());
    await Promise.resolve();
    const { tracer, exporter } = provider(new AlwaysOffSampler());
    serveRequest(tracer);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe('PresampledRootSampler with no mark', () => {
  it('delegates every decision (invariant guard: flag off records exactly what the delegate says)', () => {
    const on = provider(new AlwaysOnSampler());
    serveRequest(on.tracer);
    expect(on.exporter.getFinishedSpans()).toHaveLength(2);
    const off = provider(new AlwaysOffSampler());
    serveRequest(off.tracer);
    expect(off.exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('names its delegate', () => {
    expect(new PresampledRootSampler(new AlwaysOffSampler()).toString()).toBe(
      'PresampledRoot{AlwaysOffSampler}'
    );
  });
});

describe('buildOtelInstrumentations wiring', () => {
  // `NODE_ENV` is a required key of `NodeJS.ProcessEnv` here, so `{}` does not typecheck.
  const TEST_ENV: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  const built: HttpInstrumentation[] = [];
  afterEach(() => {
    for (const inst of built.splice(0)) inst.disable();
  });

  it('installs the pre-sample hook when given the ratio', () => {
    const [http] = buildOtelInstrumentations(TEST_ENV, {
      presampleRatio: RATIO,
    }) as HttpInstrumentation[];
    built.push(http);
    const hook = http.getConfig().ignoreIncomingRequestHook;
    expect(hook).toBeTypeOf('function');
    // The draw is Math.random here, so assert the deterministic answers only: gate off never
    // ignores, and gate on never ignores a request that carries a traceparent.
    setRootPresampleGate(() => false);
    expect(hook!(req())).toBe(false);
    setRootPresampleGate(() => true);
    expect(
      hook!(req({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }))
    ).toBe(false);
  });

  it('installs no incoming hook without the ratio (unchanged default)', () => {
    const [http] = buildOtelInstrumentations(TEST_ENV) as HttpInstrumentation[];
    built.push(http);
    expect(http.getConfig().ignoreIncomingRequestHook).toBeUndefined();
  });
});

// The tests above replay "hook, then the root SERVER span" by hand. This block drives the REAL
// instrumentation-http incoming-request wrapper on a real loopback server, so a version of the
// instrumentation that calls the hook after starting the span, or starts another span (and so
// runs the sampler) in between, fails here. Only this one server's `emit` is wrapped (the
// instrumentation stays disabled, so nothing global is patched), through the same private
// `_getPatchIncomingRequestFunction` the instrumentation's own `http` patch uses. If a version
// renames it, these tests fail loudly — re-check the ordering against that version's source.
describe('through the real HTTP instrumentation', () => {
  type PatchIncoming = (original: Server['emit']) => Server['emit'];
  let tp: NodeTracerProvider | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await tp?.shutdown();
    tp = undefined;
    context.disable();
    trace.disable();
    propagation.disable();
  });

  /** One request through a server whose `emit` the instrumentation wraps; resolves once the
   * response has closed (the instrumentation's own close listener, which ends the root span,
   * was registered first and so has run). */
  async function oneRequest(opts: {
    delegate: Sampler;
    draw: number;
    headers?: Record<string, string>;
  }) {
    const exporter = new InMemorySpanExporter();
    tp = new NodeTracerProvider({
      sampler: new PresampledRootSampler(opts.delegate),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    tp.register(); // async-local-storage context manager + W3C propagator, as in the app
    const instrumentation = new HttpInstrumentation({
      enabled: false,
      ignoreIncomingRequestHook: createRootPresampleIgnoreHook(RATIO, () => opts.draw),
    });
    instrumentation.setTracerProvider(tp);
    const tracer = tp.getTracer('handler');

    let suppressedInHandler: boolean | undefined;
    let closed!: Promise<void>;
    const srv = createServer((_req, res) => {
      closed = new Promise((resolve) => res.on('close', () => resolve()));
      suppressedInHandler = isTracingSuppressed(context.active());
      tracer.startActiveSpan('render route', (span) => span.end());
      res.end('ok');
    });
    const patch = (
      instrumentation as unknown as { _getPatchIncomingRequestFunction(c: string): PatchIncoming }
    )._getPatchIncomingRequestFunction('http');
    srv.emit = patch(srv.emit);
    server = srv;
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const { port } = srv.address() as AddressInfo;

    await new Promise<void>((resolve, reject) => {
      get(
        { host: '127.0.0.1', port, path: '/models/123', headers: opts.headers, agent: false },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
        }
      ).on('error', reject);
    });
    await closed;
    return { spans: exporter.getFinishedSpans(), suppressedInHandler };
  }

  it('flag on, sampled draw: the root SERVER span and its child are recorded under a ratio-0 delegate', async () => {
    setRootPresampleGate(() => true);
    const { spans, suppressedInHandler } = await oneRequest({
      delegate: appSampler(0),
      draw: 0.01,
    });
    expect(suppressedInHandler).toBe(false);
    const root = spans.find((s) => s.kind === SpanKind.SERVER);
    expect(root).toBeDefined();
    expect(root!.parentSpanContext).toBeUndefined();
    const child = spans.find((s) => s.name === 'render route');
    expect(child?.parentSpanContext?.spanId).toBe(root!.spanContext().spanId);
    expect(spans).toHaveLength(2);
  });

  it('POSITIVE CONTROL: flag off, same draw and delegate: nothing is recorded', async () => {
    setRootPresampleGate(() => false);
    const { spans, suppressedInHandler } = await oneRequest({
      delegate: appSampler(0),
      draw: 0.01,
    });
    expect(suppressedInHandler).toBe(false);
    expect(spans).toHaveLength(0);
  });

  it('flag on, unsampled draw: the request runs suppressed, nothing recorded even under an always-on delegate', async () => {
    setRootPresampleGate(() => true);
    const { spans, suppressedInHandler } = await oneRequest({
      delegate: new AlwaysOnSampler(),
      draw: 0.5,
    });
    expect(suppressedInHandler).toBe(true);
    expect(spans).toHaveLength(0);
  });

  it('flag on, with a sampled traceparent: joins the caller trace through the normal sampler', async () => {
    setRootPresampleGate(() => true);
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const { spans, suppressedInHandler } = await oneRequest({
      delegate: appSampler(1),
      draw: 0.5, // would be ignored if the traceparent check were missing
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    });
    expect(suppressedInHandler).toBe(false);
    const root = spans.find((s) => s.kind === SpanKind.SERVER);
    expect(root?.spanContext().traceId).toBe(traceId);
    expect(root?.parentSpanContext?.spanId).toBe('00f067aa0ba902b7');
  });
});
