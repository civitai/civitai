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
  BasicTracerProvider,
  InMemorySpanExporter,
  NodeTracerProvider,
  RandomIdGenerator,
  SamplingDecision,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  type IdGenerator,
} from '@opentelemetry/sdk-trace-node';
import { isTracingSuppressed } from '@opentelemetry/core';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildHeadSampling,
  resetRootPresampleForTests,
  setRootPresampleGate,
} from '~/server/otel-root-presample';
import { rootPresampleState } from '~/server/otel-root-presample-state';
import { buildOtelInstrumentations } from '~/server/otel-instrumentations';

// Root pre-sampling (`otel-root-presample`): the inbound HTTP instrumentation's ignore hook takes
// the head-sampling decision before any span work, by drawing the root trace id and asking the
// app's ratio sampler about it. These run the hook and spans in the instrumentation's order (hook,
// then synchronously the root SERVER span) against the REAL trace SDK with an in-memory exporter,
// so "recorded" means exported, not a stub's say-so.

const RATIO = 0.1;
// Trace ids on either side of TraceIdRatioBased(RATIO): it XORs the id's four 32-bit words and
// samples below floor(RATIO * 0xffffffff). The first test pins which side each is on.
const PASS = '00000000000000000000000000000001';
const FAIL = 'ffffffff000000000000000000000000';
const SERVER_ATTRS = {
  'http.request.method': 'GET',
  'url.path': '/models/123',
  'url.scheme': 'http',
  'server.address': 'example.test',
};

/** An independent ratio sampler, NOT the one under test: what a downstream hop applies. */
const independent = new TraceIdRatioBasedSampler(RATIO);
const passesRatio = (traceId: string) =>
  independent.shouldSample(ROOT_CONTEXT, traceId).decision === SamplingDecision.RECORD_AND_SAMPLED;

const req = (headers: Record<string, string> = {}) => ({ headers } as unknown as IncomingMessage);

/** Hands out the given trace ids in order (then FAIL); counts the calls. Span ids are random. */
function scriptedIds(traceIds: string[]): IdGenerator & { traceIdCalls: number } {
  const random = new RandomIdGenerator();
  const queue = [...traceIds];
  const gen = {
    traceIdCalls: 0,
    generateTraceId() {
      gen.traceIdCalls++;
      return queue.shift() ?? FAIL;
    },
    generateSpanId: () => random.generateSpanId(),
  };
  return gen;
}

function provider(head: ReturnType<typeof buildHeadSampling>) {
  const exporter = new InMemorySpanExporter();
  const tp = new BasicTracerProvider({
    sampler: head.sampler,
    idGenerator: head.idGenerator,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { tracer: tp.getTracer('test'), exporter };
}

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

const remoteParent = (traceId: string) =>
  trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId: '00f067aa0ba902b7',
    traceFlags: 1,
    isRemote: true,
  });

afterEach(() => {
  resetRootPresampleForTests();
});

it('fixtures: PASS is sampled at the ratio and FAIL is not', () => {
  expect(passesRatio(PASS)).toBe(true);
  expect(passesRatio(FAIL)).toBe(false);
});

describe('the ignore hook', () => {
  it('with no gate installed (flag never armed): never ignores, draws nothing, stashes nothing', () => {
    const ids = scriptedIds([PASS]);
    expect(buildHeadSampling(RATIO, ids).ignoreIncomingRequestHook(req())).toBe(false);
    expect(ids.traceIdCalls).toBe(0);
    expect(rootPresampleState.pendingTraceId).toBeUndefined();
  });

  it('with the gate off: never ignores, draws nothing, stashes nothing', () => {
    setRootPresampleGate(() => false);
    const ids = scriptedIds([PASS]);
    expect(buildHeadSampling(RATIO, ids).ignoreIncomingRequestHook(req())).toBe(false);
    expect(ids.traceIdCalls).toBe(0);
    expect(rootPresampleState.pendingTraceId).toBeUndefined();
  });

  it('a throwing gate reads as off', () => {
    setRootPresampleGate(() => {
      throw new Error('gate');
    });
    expect(buildHeadSampling(RATIO, scriptedIds([FAIL])).ignoreIncomingRequestHook(req())).toBe(
      false
    );
  });

  it('gate on, a request WITH a traceparent: not pre-sampled, nothing drawn', () => {
    setRootPresampleGate(() => true);
    const ids = scriptedIds([FAIL]);
    const hook = buildHeadSampling(RATIO, ids).ignoreIncomingRequestHook;
    expect(hook(req({ traceparent: `00-${FAIL}-00f067aa0ba902b7-01` }))).toBe(false);
    expect(ids.traceIdCalls).toBe(0);
    expect(rootPresampleState.pendingTraceId).toBeUndefined();
  });

  it('gate on, the drawn trace id fails the ratio: ignores the request, stashes nothing', () => {
    setRootPresampleGate(() => true);
    const hook = buildHeadSampling(RATIO, scriptedIds([FAIL])).ignoreIncomingRequestHook;
    expect(hook(req())).toBe(true);
    expect(rootPresampleState.pendingTraceId).toBeUndefined();
  });

  it('gate on, the drawn trace id passes the ratio: keeps the request, stashes that id', () => {
    setRootPresampleGate(() => true);
    const hook = buildHeadSampling(RATIO, scriptedIds([PASS])).ignoreIncomingRequestHook;
    expect(hook(req())).toBe(false);
    expect(rootPresampleState.pendingTraceId).toBe(PASS);
  });

  it('keeps the unsampled share at 1 - ratio (real random ids)', () => {
    setRootPresampleGate(() => true);
    const hook = buildHeadSampling(RATIO).ignoreIncomingRequestHook;
    const n = 20_000;
    let ignored = 0;
    for (let i = 0; i < n; i++) if (hook(req())) ignored++;
    // Binomial sd at n=20000, p=0.9 is about 0.0021; 0.015 is about 7 sd.
    expect(Math.abs(ignored / n - (1 - RATIO))).toBeLessThan(0.015);
  });
});

describe('a pre-sampled request', () => {
  it('its root span takes the stashed trace id, and the trace is recorded', () => {
    setRootPresampleGate(() => true);
    const head = buildHeadSampling(RATIO, scriptedIds([PASS]));
    const { tracer, exporter } = provider(head);
    expect(head.ignoreIncomingRequestHook(req())).toBe(false);
    serveRequest(tracer);
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual(['render route', 'GET']);
    for (const s of spans) expect(s.spanContext().traceId).toBe(PASS);
    expect(rootPresampleState.pendingTraceId).toBeUndefined();
  });

  it('every pre-sampled trace id passes the ratio, so a downstream hop that re-applies it keeps the trace (real random ids)', () => {
    setRootPresampleGate(() => true);
    const head = buildHeadSampling(RATIO);
    const { tracer, exporter } = provider(head);
    for (let i = 0; i < 2000; i++) if (!head.ignoreIncomingRequestHook(req())) serveRequest(tracer);

    const roots = exporter.getFinishedSpans().filter((s) => s.kind === SpanKind.SERVER);
    // POSITIVE CONTROL: about RATIO * 2000 = 200 recorded; a broken hook records none.
    expect(roots.length).toBeGreaterThan(100);
    expect(roots.every((s) => passesRatio(s.spanContext().traceId))).toBe(true);

    // The next service applies the same ratio to a sampled remote parent.
    const downstream = buildHeadSampling(RATIO).sampler;
    const kept = roots.filter(
      (s) =>
        downstream.shouldSample(
          remoteParent(s.spanContext().traceId),
          s.spanContext().traceId,
          'GET',
          SpanKind.SERVER,
          {},
          []
        ).decision === SamplingDecision.RECORD_AND_SAMPLED
    );
    expect(kept).toHaveLength(roots.length);
  });

  it('the stashed id is used once: the next root gets a fresh id', () => {
    setRootPresampleGate(() => true);
    const head = buildHeadSampling(RATIO, scriptedIds([PASS])); // then FAIL for every later root
    const { tracer, exporter } = provider(head);
    head.ignoreIncomingRequestHook(req());
    serveRequest(tracer);
    serveRequest(tracer);
    expect(exporter.getFinishedSpans().filter((s) => s.kind === SpanKind.SERVER)).toHaveLength(1);
  });

  it('an unused stashed id is gone after the current task', async () => {
    setRootPresampleGate(() => true);
    const head = buildHeadSampling(RATIO, scriptedIds([PASS]));
    head.ignoreIncomingRequestHook(req());
    expect(rootPresampleState.pendingTraceId).toBe(PASS);
    await Promise.resolve();
    expect(rootPresampleState.pendingTraceId).toBeUndefined();
    const { tracer, exporter } = provider(head);
    serveRequest(tracer);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('the next request clears an id the previous one left', () => {
    setRootPresampleGate(() => true);
    const hook = buildHeadSampling(RATIO, scriptedIds([PASS, FAIL])).ignoreIncomingRequestHook;
    hook(req());
    expect(rootPresampleState.pendingTraceId).toBe(PASS);
    expect(hook(req())).toBe(true);
    expect(rootPresampleState.pendingTraceId).toBeUndefined();
  });
});

describe('head sampling with no pre-sampling (flag off): the ratio, as before', () => {
  it('samples roots by trace id, and applies the ratio to sampled remote parents', () => {
    const head = buildHeadSampling(RATIO, scriptedIds([PASS, FAIL]));
    const { tracer, exporter } = provider(head);
    serveRequest(tracer); // PASS
    serveRequest(tracer); // FAIL
    serveRequest(tracer, remoteParent(FAIL)); // a client-forced sampled flag does not win
    serveRequest(tracer, remoteParent(PASS));
    const roots = exporter.getFinishedSpans().filter((s) => s.kind === SpanKind.SERVER);
    expect(roots.map((s) => s.spanContext().traceId)).toEqual([PASS, PASS]);
    expect(roots.map((s) => s.parentSpanContext !== undefined)).toEqual([false, true]);
  });
});

describe('buildOtelInstrumentations wiring', () => {
  // `NODE_ENV` is a required key of `NodeJS.ProcessEnv` here, so `{}` does not typecheck.
  const TEST_ENV: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  const built: HttpInstrumentation[] = [];
  afterEach(() => {
    for (const inst of built.splice(0)) inst.disable();
  });

  it('installs the given pre-sample hook', () => {
    const { ignoreIncomingRequestHook } = buildHeadSampling(RATIO);
    const [http] = buildOtelInstrumentations(TEST_ENV, {
      ignoreIncomingRequestHook,
    }) as HttpInstrumentation[];
    built.push(http);
    expect(http.getConfig().ignoreIncomingRequestHook).toBe(ignoreIncomingRequestHook);
  });

  it('installs no incoming hook without one (unchanged default)', () => {
    const [http] = buildOtelInstrumentations(TEST_ENV) as HttpInstrumentation[];
    built.push(http);
    expect(http.getConfig().ignoreIncomingRequestHook).toBeUndefined();
  });
});

// The tests above replay "hook, then the root SERVER span" by hand. This block drives the REAL
// instrumentation-http incoming-request wrapper on a real loopback server, so a version of the
// instrumentation that calls the hook after starting the span, or starts another parentless span
// (and so takes the stashed id) in between, fails here. Only this one server's `emit` is wrapped
// (the instrumentation stays disabled, so nothing global is patched), through the same private
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
  async function oneRequest(opts: { traceIds: string[]; headers?: Record<string, string> }) {
    const ids = scriptedIds(opts.traceIds);
    const head = buildHeadSampling(RATIO, ids);
    const exporter = new InMemorySpanExporter();
    tp = new NodeTracerProvider({
      sampler: head.sampler,
      idGenerator: head.idGenerator,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    tp.register(); // async-local-storage context manager + W3C propagator, as in the app
    const instrumentation = new HttpInstrumentation({
      enabled: false,
      ignoreIncomingRequestHook: head.ignoreIncomingRequestHook,
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
    return { spans: exporter.getFinishedSpans(), suppressedInHandler, ids };
  }

  it('flag on, sampled draw: the root SERVER span takes the drawn id and is recorded with its child', async () => {
    setRootPresampleGate(() => true);
    // Only the hook's draw is PASS; any other trace id the tracer asked for would be FAIL.
    const { spans, suppressedInHandler } = await oneRequest({ traceIds: [PASS] });
    expect(suppressedInHandler).toBe(false);
    const root = spans.find((s) => s.kind === SpanKind.SERVER);
    expect(root?.spanContext().traceId).toBe(PASS);
    expect(root!.parentSpanContext).toBeUndefined();
    const child = spans.find((s) => s.name === 'render route');
    expect(child?.parentSpanContext?.spanId).toBe(root!.spanContext().spanId);
    expect(spans).toHaveLength(2);
  });

  it('CONTROL: flag off, a trace id that fails the ratio: nothing is recorded', async () => {
    setRootPresampleGate(() => false);
    const { spans, suppressedInHandler } = await oneRequest({ traceIds: [FAIL] });
    expect(suppressedInHandler).toBe(false);
    expect(spans).toHaveLength(0);
  });

  it('flag on, unsampled draw: the request runs suppressed and nothing is recorded', async () => {
    setRootPresampleGate(() => true);
    const { spans, suppressedInHandler, ids } = await oneRequest({ traceIds: [FAIL] });
    expect(suppressedInHandler).toBe(true);
    expect(spans).toHaveLength(0);
    expect(ids.traceIdCalls).toBe(1); // the hook's draw; the suppressed tracer asks for none
  });

  it('flag on, with a sampled traceparent: joins the caller trace, nothing drawn', async () => {
    setRootPresampleGate(() => true);
    const { spans, suppressedInHandler, ids } = await oneRequest({
      traceIds: [],
      headers: { traceparent: `00-${PASS}-00f067aa0ba902b7-01` },
    });
    expect(suppressedInHandler).toBe(false);
    expect(ids.traceIdCalls).toBe(0);
    const root = spans.find((s) => s.kind === SpanKind.SERVER);
    expect(root?.spanContext().traceId).toBe(PASS);
    expect(root?.parentSpanContext?.spanId).toBe('00f067aa0ba902b7');
  });
});
