import { context, trace, TraceFlags } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { ExportResultCode } from '@opentelemetry/core';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
  BatchLogRecordProcessor,
  type LogRecordExporter,
  type LogRecordProcessor,
  type ReadableLogRecord,
} from '@opentelemetry/sdk-logs';
import type { Counter } from 'prom-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  buildOtelLogAttributes,
  createOtelLoggerProvider,
  deriveSeverity,
  emitOtelLog,
  OTEL_LOG_ATTRIBUTE_KEYS,
  OTEL_SHUTDOWN_SIGNALS,
  otelLogRecordsEmittedCounter,
  otelLogRecordsSkippedCounter,
  registerOtelShutdown,
  resetOtelLogBridge,
} from '../otel-logs';

// 🔴 This suite deliberately does NOT `vi.mock('@opentelemetry/api-logs')` (or sdk-logs).
// A wholesale factory mock would make every assertion below vacuous — it would be testing
// the mock's shape, not the bridge — and the repo's `no-wholesale-module-mock` guard only
// watches `~/utils/trpc`, so nothing would catch it. The SDK exports everything needed to
// run this for real: LoggerProvider, SimpleLogRecordProcessor, InMemoryLogRecordExporter.

const VALID_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const VALID_SPAN_ID = '00f067aa0ba902b7';

/** Read one counter's current value; labels narrow to a single child series. */
async function counterValue(
  counter: Counter<string>,
  labels?: Record<string, string>
): Promise<number> {
  const metric = await counter.get();
  const match = metric.values.find((v) =>
    labels ? Object.entries(labels).every(([k, want]) => v.labels[k] === want) : true
  );
  return match?.value ?? 0;
}

/** Register a real provider that records into memory, and return the exporter. */
function registerRecordingProvider(): InMemoryLogRecordExporter {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(exporter)] });
  logs.setGlobalLoggerProvider(provider);
  return exporter;
}

/**
 * A real LogRecordExporter that appends to an array the CALLER owns, ASYNCHRONOUSLY.
 *
 * Two deliberate properties, each load-bearing for the shutdown tests:
 *
 *  1. It does not reset on shutdown. `InMemoryLogRecordExporter.shutdown()` RESETS its
 *     own store, so a test that shuts the provider down and then reads that store finds
 *     it empty whether or not the flush worked — a false 0 that reads exactly like the
 *     bug it is supposed to detect.
 *  2. It completes on a LATER TICK, like the real network exporter it stands in for. A
 *     synchronous stub cannot tell an awaited shutdown from an un-awaited one — both
 *     read 1 — so the "does SIGTERM actually flush" test would pass with the very defect
 *     it exists to catch. Measured: with a synchronous stub, removing the `await`
 *     left that test GREEN.
 */
function collectingExporter(): { exporter: LogRecordExporter; records: ReadableLogRecord[] } {
  const records: ReadableLogRecord[] = [];
  return {
    records,
    exporter: {
      export(batch, resultCallback) {
        setTimeout(() => {
          records.push(...batch);
          resultCallback({ code: ExportResultCode.SUCCESS });
        }, 5);
      },
      shutdown: async () => {},
    },
  };
}

beforeAll(() => {
  // Production registers a context manager (the Node SDK does it); the API's default is
  // a no-op whose `with()` does NOT propagate, so `context.active()` inside it still
  // returns ROOT_CONTEXT. Without this, every trace-context assertion below would read
  // "no active span" and pass or fail for a reason that has nothing to do with the code.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

afterAll(() => {
  context.disable();
});

beforeEach(() => {
  // A clean global on every test: `setGlobalLoggerProvider` is a no-op when one is
  // already registered, so without this the second test would silently reuse the first
  // test's provider and its exporter would look empty.
  logs.disable();
  resetOtelLogBridge();
  process.env.OTEL_LOGS_ENABLED = 'true';
});

afterEach(() => {
  logs.disable();
  resetOtelLogBridge();
  delete process.env.OTEL_LOGS_ENABLED;
});

// ---------------------------------------------------------------------------
describe('deriveSeverity', () => {
  it('maps the four severity words to their exact OTel (number, text) pair', () => {
    // Asserts the exact pair per key, so changing ONE row fails ONLY that row.
    expect(deriveSeverity('error')).toEqual({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
    });
    expect(deriveSeverity('warning')).toEqual({
      severityNumber: SeverityNumber.WARN,
      severityText: 'WARN',
    });
    expect(deriveSeverity('warn')).toEqual({
      severityNumber: SeverityNumber.WARN,
      severityText: 'WARN',
    });
    expect(deriveSeverity('info')).toEqual({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
    });

    // Pin the literal numbers too — the constants above are the SDK's, so a table that
    // silently swapped ERROR for WARN would still satisfy the assertions above if the
    // expectation were derived from the same lookup the implementation uses.
    expect(deriveSeverity('error').severityNumber).toBe(17);
    expect(deriveSeverity('warning').severityNumber).toBe(13);
    expect(deriveSeverity('info').severityNumber).toBe(9);
  });

  it('maps an EVENT-NAME type to UNSPECIFIED with severityText OMITTED (not a placeholder)', () => {
    for (const eventName of ['job-error', 'buzz', 'job-summary', 'oauth.bust-cache.failed']) {
      const derived = deriveSeverity(eventName);
      expect(derived.severityNumber).toBe(SeverityNumber.UNSPECIFIED);
      expect(derived.severityNumber).toBe(0);
      // Omitted, not ''/'UNSPECIFIED': downstream level resolution prefers the TEXT over
      // the NUMBER, so any invented string would outrank a correct number.
      expect(derived.severityText).toBeUndefined();
      expect('severityText' in derived).toBe(false);
    }
  });

  it('maps an ABSENT / non-string type to UNSPECIFIED', () => {
    expect(deriveSeverity(undefined)).toEqual({ severityNumber: SeverityNumber.UNSPECIFIED });
    expect(deriveSeverity(null)).toEqual({ severityNumber: SeverityNumber.UNSPECIFIED });
    expect(deriveSeverity(42)).toEqual({ severityNumber: SeverityNumber.UNSPECIFIED });
  });

  it('does NOT fail open on an inherited-prototype key', () => {
    // An object-literal lookup would resolve `SEVERITY['toString']` to a truthy function
    // and never reach the default. A Map cannot.
    for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(deriveSeverity(key)).toEqual({ severityNumber: SeverityNumber.UNSPECIFIED });
    }
  });
});

// ---------------------------------------------------------------------------
describe('buildOtelLogAttributes', () => {
  it('emits a CLOSED key set — unknown payload fields never become attributes', () => {
    const attrs = buildOtelLogAttributes(
      {
        type: 'error',
        name: 'model.getById',
        pod: 'pod-1',
        userId: 12345,
        requestId: 'req-9',
        weirdField: 'y',
        another: 1,
        config: { headers: { authorization: 'secret' } },
      },
      'a-datastream'
    );

    // Structural: the EXACT key set, not "does it contain". A spread of the payload
    // fails here by name.
    expect(Object.keys(attrs).sort()).toEqual([...OTEL_LOG_ATTRIBUTE_KEYS].sort());
    expect(attrs['civitai.type']).toBe('error');
    expect(attrs['civitai.name']).toBe('model.getById');
    expect(attrs['civitai.user_id']).toBe(12345);
    expect(attrs['civitai.datastream']).toBe('a-datastream');
    expect(attrs).not.toHaveProperty('weirdField');
    expect(attrs).not.toHaveProperty('config');
  });

  it('omits keys the payload does not carry rather than emitting undefined', () => {
    const attrs = buildOtelLogAttributes({ type: 'info' });
    expect(Object.keys(attrs)).toEqual(['civitai.type']);
  });

  it('keeps the RAW type verbatim even when it is unmapped — no information is lost', () => {
    expect(buildOtelLogAttributes({ type: 'job-error' })['civitai.type']).toBe('job-error');
    expect(buildOtelLogAttributes({ type: 'toString' })['civitai.type']).toBe('toString');
  });

  it('accepts the two alternate spellings for user and request id', () => {
    expect(buildOtelLogAttributes({ user: 7 })['civitai.user_id']).toBe(7);
    expect(buildOtelLogAttributes({ request_id: 'r' })['civitai.request_id']).toBe('r');
  });
});

// ---------------------------------------------------------------------------
describe('emitOtelLog — provider binding', () => {
  it('THE PAIR: 1 record exported with a provider registered, 0 without', async () => {
    // NEGATIVE: no global provider. This is the state a bad bind leaves behind, and the
    // reason the assertion is a RECORD COUNT and a counter delta rather than a spy —
    // a spy on getLogger stays green through the exact failure being guarded.
    const skippedBefore = await counterValue(otelLogRecordsSkippedCounter, {
      reason: 'no_provider',
    });
    expect(emitOtelLog('{"a":1}', { type: 'error' })).toBe(false);
    expect(await counterValue(otelLogRecordsSkippedCounter, { reason: 'no_provider' })).toBe(
      skippedBefore + 1
    );

    // POSITIVE: same call, provider registered.
    resetOtelLogBridge();
    const exporter = registerRecordingProvider();
    const emittedBefore = await counterValue(otelLogRecordsEmittedCounter);

    expect(emitOtelLog('{"a":1}', { type: 'error' })).toBe(true);

    expect(exporter.getFinishedLogRecords()).toHaveLength(1);
    expect(await counterValue(otelLogRecordsEmittedCounter)).toBe(emittedBefore + 1);
  });

  it('a logger bound EAGERLY (before registration) is permanently silent; the lazy bind is not', async () => {
    // Reproduces the state the lazy bind exists to make unreachable: a ProxyLogger whose
    // proxy provider is never delegated resolves to the no-op logger FOREVER — no error,
    // no exception, no record. In production that state is reached by a second bundled
    // module copy, which Vitest structurally cannot stage; here it is reached by binding
    // before the provider that eventually gets registered exists. Same terminal state,
    // and it is the state that matters.
    const eagerLogger = logs.getLogger('bound-too-early');
    logs.disable();

    const exporter = registerRecordingProvider();

    eagerLogger.emit({ severityNumber: SeverityNumber.ERROR, body: 'from the eager logger' });
    expect(exporter.getFinishedLogRecords()).toHaveLength(0); // silently dropped

    resetOtelLogBridge();
    expect(emitOtelLog('from the lazy bridge', { type: 'error' })).toBe(true);
    expect(exporter.getFinishedLogRecords()).toHaveLength(1);
    expect(exporter.getFinishedLogRecords()[0].body).toBe('from the lazy bridge');
  });
});

// ---------------------------------------------------------------------------
describe('emitOtelLog — dark launch gate', () => {
  it('emits NOTHING unless OTEL_LOGS_ENABLED === "true", and counts the skip', async () => {
    const exporter = registerRecordingProvider();

    for (const value of [undefined, 'false', '1', 'TRUE', 'yes']) {
      resetOtelLogBridge();
      if (value === undefined) delete process.env.OTEL_LOGS_ENABLED;
      else process.env.OTEL_LOGS_ENABLED = value;

      const before = await counterValue(otelLogRecordsSkippedCounter, { reason: 'disabled' });
      expect(emitOtelLog('{"a":1}', { type: 'error' })).toBe(false);
      expect(await counterValue(otelLogRecordsSkippedCounter, { reason: 'disabled' })).toBe(
        before + 1
      );
    }

    // The pair: nothing reached the exporter across all five dark configurations, and the
    // SAME call with the flag on does export — so the zero above is the gate, not a
    // probe wired to nothing.
    expect(exporter.getFinishedLogRecords()).toHaveLength(0);

    process.env.OTEL_LOGS_ENABLED = 'true';
    resetOtelLogBridge();
    expect(emitOtelLog('{"a":1}', { type: 'error' })).toBe(true);
    expect(exporter.getFinishedLogRecords()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('emitOtelLog — record shape', () => {
  it('uses the caller-supplied line as the body VERBATIM and maps severity + attributes', () => {
    const exporter = registerRecordingProvider();
    const line = '{"_axiom":"ds","pod":"pod-1","type":"error","name":"model.getById"}';

    emitOtelLog(line, { pod: 'pod-1', type: 'error', name: 'model.getById' }, 'ds');

    const [record] = exporter.getFinishedLogRecords();
    expect(record.body).toBe(line);
    expect(record.severityNumber).toBe(SeverityNumber.ERROR);
    expect(record.severityText).toBe('ERROR');
    expect(record.attributes).toEqual({
      'civitai.datastream': 'ds',
      'civitai.pod': 'pod-1',
      'civitai.type': 'error',
      'civitai.name': 'model.getById',
    });
  });

  it('leaves severityText UNSET on the wire for an unmapped type', () => {
    const exporter = registerRecordingProvider();
    emitOtelLog('{"type":"job-summary"}', { type: 'job-summary' });

    const [record] = exporter.getFinishedLogRecords();
    expect(record.severityNumber).toBe(SeverityNumber.UNSPECIFIED);
    expect(record.severityText).toBeUndefined();
    expect(record.attributes['civitai.type']).toBe('job-summary');
  });

  it('emits a record for a payload with NO type at all', () => {
    const exporter = registerRecordingProvider();
    expect(emitOtelLog('{"name":"no-type-here"}', { name: 'no-type-here' })).toBe(true);

    const [record] = exporter.getFinishedLogRecords();
    expect(record.severityNumber).toBe(SeverityNumber.UNSPECIFIED);
    expect(record.severityText).toBeUndefined();
    expect(record.attributes).not.toHaveProperty('civitai.type');
  });
});

// ---------------------------------------------------------------------------
describe('emitOtelLog — containment', () => {
  it('never throws when the pipeline throws, and counts it', async () => {
    const throwing: LogRecordProcessor = {
      onEmit() {
        throw new Error('processor boom');
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    };
    logs.setGlobalLoggerProvider(new LoggerProvider({ processors: [throwing] }));

    const before = await counterValue(otelLogRecordsSkippedCounter, { reason: 'emit_threw' });
    expect(() => emitOtelLog('{"a":1}', { type: 'error' })).not.toThrow();
    expect(emitOtelLog('{"a":1}', { type: 'error' })).toBe(false);
    expect(await counterValue(otelLogRecordsSkippedCounter, { reason: 'emit_threw' })).toBe(
      before + 2
    );
  });
});

// ---------------------------------------------------------------------------
describe('trace context', () => {
  it('CONTRACT: the SDK attaches the active span context itself — the bridge sets none', () => {
    const exporter = registerRecordingProvider();
    const spanContext = {
      traceId: VALID_TRACE_ID,
      spanId: VALID_SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    };

    context.with(trace.setSpanContext(context.active(), spanContext), () => {
      emitOtelLog('{"type":"error"}', { type: 'error' });
    });

    const [record] = exporter.getFinishedLogRecords();
    expect(record.spanContext?.traceId).toBe(VALID_TRACE_ID);
    expect(record.spanContext?.spanId).toBe(VALID_SPAN_ID);
    // Correlation is free; nothing is stamped as an attribute for it.
    expect(record.attributes).not.toHaveProperty('civitai.trace_id');
  });

  it('omits the span context when there is no active span', () => {
    const exporter = registerRecordingProvider();
    emitOtelLog('{"type":"error"}', { type: 'error' });
    expect(exporter.getFinishedLogRecords()[0].spanContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('createOtelLoggerProvider', () => {
  const UNSAMPLED_SPAN_CONTEXT = {
    traceId: VALID_TRACE_ID,
    spanId: VALID_SPAN_ID,
    traceFlags: TraceFlags.NONE, // valid span context, trace NOT sampled
    isRemote: false,
  };

  it('REGRESSION GUARD: keeps records emitted inside an UNSAMPLED span (traceBased stays off)', async () => {
    // Head trace sampling runs well below 1.0, so a provider built with
    // `traceBased: true` would silently discard the large majority of in-request log
    // records. This asserts the shipped factory does not.
    const exporter = new InMemoryLogRecordExporter();
    const provider = createOtelLoggerProvider({ exporter });
    logs.setGlobalLoggerProvider(provider);

    context.with(trace.setSpanContext(context.active(), UNSAMPLED_SPAN_CONTEXT), () => {
      emitOtelLog('{"type":"error"}', { type: 'error' });
    });
    await provider.forceFlush();

    expect(exporter.getFinishedLogRecords()).toHaveLength(1);
  });

  it('POSITIVE CONTROL for that guard: traceBased:true really does drop the same record', async () => {
    // Without this, the assertion above is indistinguishable from a test that would pass
    // whatever the config said. Same record, same unsampled span, one config difference.
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor(exporter)],
      loggerConfigurator: () => ({
        disabled: false,
        minimumSeverity: SeverityNumber.UNSPECIFIED,
        traceBased: true,
      }),
    });
    logs.setGlobalLoggerProvider(provider);

    context.with(trace.setSpanContext(context.active(), UNSAMPLED_SPAN_CONTEXT), () => {
      emitOtelLog('{"type":"error"}', { type: 'error' });
    });
    await provider.forceFlush();

    expect(exporter.getFinishedLogRecords()).toHaveLength(0);
  });

  it('keeps records with an UNSPECIFIED severity (they bypass the minimum-severity filter)', async () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = createOtelLoggerProvider({ exporter });
    logs.setGlobalLoggerProvider(provider);

    emitOtelLog('{"type":"job-summary"}', { type: 'job-summary' });
    await provider.forceFlush();

    expect(exporter.getFinishedLogRecords()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('registerOtelShutdown', () => {
  let registered: { unregister: () => void } | undefined;

  afterEach(() => {
    registered?.unregister();
    registered = undefined;
  });

  it('defaults to SIGTERM *and* SIGINT', () => {
    expect([...OTEL_SHUTDOWN_SIGNALS]).toEqual(['SIGTERM', 'SIGINT']);
  });

  it('SIGTERM FLUSHES a batch the timer is still holding', async () => {
    const { exporter, records } = collectingExporter();
    // A deliberately long scheduled delay: nothing can leave on the timer within this
    // test, so a record that arrives at the exporter can only have been flushed by the
    // shutdown path.
    const provider = new LoggerProvider({
      processors: [new BatchLogRecordProcessor(exporter, { scheduledDelayMillis: 60_000 })],
    });
    logs.setGlobalLoggerProvider(provider);

    const before = process.listeners('SIGTERM').length;
    const ctl = registerOtelShutdown([provider], { log: () => {} });
    registered = ctl;
    expect(process.listeners('SIGTERM').length).toBe(before + 1);

    emitOtelLog('{"type":"error"}', { type: 'error' });

    // NEGATIVE CONTROL: the timer is holding it. If this reads 1, the assertion below
    // proves nothing — the record would have arrived with or without a shutdown.
    expect(records).toHaveLength(0);

    // Invoke the listener actually registered on SIGTERM, then AWAIT what it started.
    // Awaiting is the whole point: the shape this replaces returned before the flush
    // completed, and that difference is invisible to a `shutdown()` spy.
    const listener = process.listeners('SIGTERM').at(-1) as () => void;
    listener();
    await ctl.settled();

    expect(records).toHaveLength(1);
    expect(records[0].body).toBe('{"type":"error"}');
  });

  it('is IDEMPOTENT across a second signal — SIGINT after SIGTERM joins, it does not re-run', async () => {
    let shutdownCalls = 0;
    const target = {
      shutdown: async () => {
        shutdownCalls += 1;
      },
    };

    const ctl = registerOtelShutdown([target], { log: () => {} });
    registered = ctl;

    const sigterm = process.listeners('SIGTERM').at(-1) as () => void;
    const sigint = process.listeners('SIGINT').at(-1) as () => void;
    sigterm();
    sigint();
    await ctl.settled();

    expect(shutdownCalls).toBe(1);
  });

  it('a failing target does not prevent the other flush, and does not reject', async () => {
    const failing = { shutdown: async () => Promise.reject(new Error('exporter down')) };
    let otherRan = false;
    const other = {
      shutdown: async () => {
        otherRan = true;
      },
    };
    const errors: unknown[] = [];

    const ctl = registerOtelShutdown([failing, other], {
      log: () => {},
      onError: (reason) => errors.push(reason),
    });
    registered = ctl;

    await expect(ctl.shutdown('test')).resolves.toBeUndefined();
    expect(otherRan).toBe(true);
    expect(errors).toHaveLength(1);
  });
});
