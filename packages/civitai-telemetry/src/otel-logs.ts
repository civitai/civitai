// OTel Logs bridge: emits the app's structured log records over OTLP, in addition to
// (never instead of) the existing sinks.
//
// DELIBERATELY NOT RE-EXPORTED FROM `./index`. The barrel is imported by code that also
// reaches the browser graph; this module pulls `@opentelemetry/sdk-logs`, which is
// server-only. Import it by subpath: `@civitai/telemetry/otel-logs`.
//
// The emitter is injected into `@civitai/axiom` rather than imported by it (see that
// package's `env.ts` header, which prescribes exactly this shape) so the Axiom package
// keeps no OpenTelemetry dependency and no OpenTelemetry semantics of its own.
import {
  logs,
  SeverityNumber,
  type Logger,
  type LogRecord as ApiLogRecord,
} from '@opentelemetry/api-logs';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
  type LogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import type { HrTime } from '@opentelemetry/api';
import type { Resource } from '@opentelemetry/resources';
import promClient from 'prom-client';
import { instrumentationRegistry, registerInstrumentationMetric, PROM_PREFIX } from './client';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MixedObject = Record<string, any>;

// ---------------------------------------------------------------------------
// Counters — the positive/negative control for "is this thing wired to anything"
// ---------------------------------------------------------------------------
// A count of zero records arriving at the far end is indistinguishable from a bridge
// that never runs. These make the difference observable in-process, before the record
// ever leaves it.
//
// 🔴 REGISTERED ON `instrumentationRegistry`, NOT on prom-client's default registry.
// This module is only ever loaded from `src/instrumentation.node.ts`, i.e. from the
// INSTRUMENTATION graph, and `/api/metrics` scrapes prom-client's default registry as it
// exists in the REQUEST graph. A metric created here with `registerCounter` therefore
// lands in a registry nothing scrapes: it is registered, it increments, and it is absent
// from every `/metrics` response. That is not a theory — it is what shipped: the first
// production window of this bridge had a live `/metrics` returning 1,758 lines (90 of them
// `nodejs_*`, so the endpoint itself was healthy) and ZERO `otel_log*` series, which left
// the one instrument designed to make the bridge's failure legible completely mute.
//
// `instrumentationRegistry` is pinned on `globalThis` precisely so it crosses that
// boundary, and `src/pages/api/metrics.ts` already merges it into the scrape. This is the
// same trap, and the same cure, as the event-loop long-task metrics (PR #2451); see the
// WHY note on `instrumentationRegistry` above.
//
// `registerInstrumentationMetric` is get-or-create, so a second evaluation of this module
// (another graph, or HMR) adopts the existing counter instead of throwing "already
// registered" inside the constructor.
const EMITTED_METRIC = PROM_PREFIX + 'otel_log_records_emitted_total';
const SKIPPED_METRIC = PROM_PREFIX + 'otel_log_records_skipped_total';

export const otelLogRecordsEmittedCounter = registerInstrumentationMetric(
  EMITTED_METRIC,
  () =>
    new promClient.Counter({
      name: EMITTED_METRIC,
      help: 'Structured log records handed to the OTel Logs API by the Axiom bridge',
      registers: [instrumentationRegistry],
    })
);

export const OTEL_LOG_SKIP_REASONS = ['disabled', 'no_provider', 'emit_threw'] as const;
export type OtelLogSkipReason = (typeof OTEL_LOG_SKIP_REASONS)[number];

export const otelLogRecordsSkippedCounter = registerInstrumentationMetric(
  SKIPPED_METRIC,
  () =>
    // `Counter<T>`'s type parameter is the LABEL NAME union, not the label VALUE union —
    // so it is `'reason'`, matching `labelNames` below. (`OtelLogSkipReason` is the set of
    // values that label may take; putting it here type-checks the call sites backwards.)
    new promClient.Counter<'reason'>({
      name: SKIPPED_METRIC,
      help: 'Structured log records NOT emitted over OTLP, by reason',
      labelNames: ['reason'] as const,
      registers: [instrumentationRegistry],
    })
);

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------
// `type` is a HYBRID field, not a severity field: measured across the call sites, ~84%
// carry a severity word, the rest carry an event name (`job-error`, `buzz`,
// `job-summary`, ...) and some carry no `type` at all.
//
// Anything not in this table maps to UNSPECIFIED(0) with severityText OMITTED. Both
// halves matter:
//   - Guessing ERROR mislabels `job-summary`; guessing INFO hides `job-error`. A
//     `-error`/`-failed` suffix heuristic would be wrong for cases nobody can
//     enumerate, so there is no default worth inventing — UNSPECIFIED is the honest
//     "this event does not declare a severity".
//   - severityText is omitted rather than set to a placeholder because the downstream
//     level resolution prefers the TEXT over the NUMBER, so an invented string would
//     outrank a correct number.
// No information is lost: the raw value always travels verbatim as `civitai.type`.
//
// A Map, NOT an object literal. An object-literal lookup with a caller-supplied key
// FAILS OPEN — `SEVERITY['toString']` is a truthy function, so `type: 'toString'` would
// resolve to garbage instead of falling through to the default.
const SEVERITY_BY_TYPE: ReadonlyMap<string, DerivedSeverity> = new Map([
  ['error', { severityNumber: SeverityNumber.ERROR, severityText: 'ERROR' }],
  ['warning', { severityNumber: SeverityNumber.WARN, severityText: 'WARN' }],
  ['warn', { severityNumber: SeverityNumber.WARN, severityText: 'WARN' }],
  ['info', { severityNumber: SeverityNumber.INFO, severityText: 'INFO' }],
]);

export type DerivedSeverity = { severityNumber: SeverityNumber; severityText?: string };

const UNSPECIFIED: DerivedSeverity = { severityNumber: SeverityNumber.UNSPECIFIED };

/** Map a raw `type` value to an OTel severity. Unknown/absent/non-string → UNSPECIFIED. */
export function deriveSeverity(rawType: unknown): DerivedSeverity {
  if (typeof rawType !== 'string') return UNSPECIFIED;
  return SEVERITY_BY_TYPE.get(rawType) ?? UNSPECIFIED;
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------
// A CLOSED set, never a spread of the payload. Spreading reproduces exactly the schema
// explosion that `safeError` exists to prevent (every key of a nested `.config`,
// `.headers`, `.cause` becomes its own field), and on the receiving side it mints
// unbounded metadata keys. The full payload is already carried, intact, in the body.
//
// Nothing here is k8s identity. Pod/namespace/deployment/node identity is attached
// downstream, after the record leaves this process — the app must not set it, and a
// value guessed in-process would be worse than an absent one.
export const OTEL_LOG_ATTRIBUTE_KEYS = [
  'civitai.datastream',
  'civitai.type',
  'civitai.name',
  'civitai.pod',
  'civitai.user_id',
  'civitai.request_id',
] as const;

export type OtelLogAttributes = Record<string, string | number | boolean>;

function coerce(value: unknown): string | number | boolean | undefined {
  if (value === undefined || value === null) return undefined;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean')
    return value as string | number | boolean;
  return String(value);
}

/** Build the closed attribute set for one record. Keys absent from `data` are omitted. */
export function buildOtelLogAttributes(data: MixedObject, datastream?: string): OtelLogAttributes {
  const attrs: OtelLogAttributes = {};
  const put = (key: string, value: unknown) => {
    const v = coerce(value);
    if (v !== undefined) attrs[key] = v;
  };

  put('civitai.datastream', datastream);
  put('civitai.type', data?.type);
  put('civitai.name', data?.name);
  put('civitai.pod', data?.pod);
  put('civitai.user_id', data?.userId ?? data?.user);
  put('civitai.request_id', data?.requestId ?? data?.request_id);

  return attrs;
}

// ---------------------------------------------------------------------------
// Logger resolution
// ---------------------------------------------------------------------------
const LOGS_API_GLOBAL = Symbol.for('io.opentelemetry.js.api.logs');

let cachedLogger: Logger | undefined;

/**
 * Resolve the Logger LAZILY, per emit, and only once a provider is actually registered.
 *
 * `logs.getLogger()` called BEFORE `setGlobalLoggerProvider()` returns a ProxyLogger
 * bound to this module copy's ProxyLoggerProvider. That proxy provider is only ever
 * delegated on the copy that called `setGlobalLoggerProvider`, so the ProxyLogger
 * resolves to the no-op logger FOREVER — a permanent, silent no-op with no error and no
 * exception. A module-scope `getLogger()` is therefore not a style question; it is the
 * bug.
 *
 * This is a TIMING problem, and the guard below is the fix for it. Checking the global
 * first makes the permanently-silent state unreachable, and makes the not-yet-registered
 * state OBSERVABLE (counted as `no_provider`) rather than invisible.
 *
 * 🔴 It is NOT the whole story, and the note that used to stand here was read as if it
 * were. It argued that a second BUNDLED copy of the logs API would still read the same
 * global, so identity could not matter. Both halves of that have now been measured on a
 * real production build, and the conclusion drawn from them was wrong:
 *
 *   - The premise is true but idle. `@opentelemetry/api-logs` is not bundled AT ALL —
 *     Next externalizes node_modules for the server build, and a scan of the emitted
 *     server source maps finds ZERO copies of it. There is one instance, from the require
 *     cache. Externalizing it via `serverExternalPackages` would change nothing.
 *   - The conclusion is false. Identity DID sink the bridge — just not this module's.
 *     The duplicated module was the app's own logger shim, `src/server/logging/client.ts`
 *     (14 emitted copies), whose module-scope sink object the boot-time registration
 *     could only ever arm in one of them. Fixed by pinning that object on `globalThis`;
 *     see `src/server/logging/structured-log-sink.ts`.
 *
 * The lesson worth keeping: "which module instance holds this state" is a question about
 * the BUNDLER's output, and reasoning about `Symbol.for` keys cannot answer it. Read the
 * build.
 */
function resolveLogger(): Logger | undefined {
  if (cachedLogger) return cachedLogger;
  if (!(globalThis as Record<symbol, unknown>)[LOGS_API_GLOBAL]) return undefined;
  cachedLogger = logs.getLogger('civitai-axiom-bridge');
  return cachedLogger;
}

/**
 * Drop the memoized Logger. For tests that register/unregister a provider between
 * cases; production code has no reason to call it.
 */
export function resetOtelLogBridge(): void {
  cachedLogger = undefined;
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------
// 🔴 WHY THE BRIDGE STAMPS ITS OWN TIMESTAMPS
//
// Left to itself, `@opentelemetry/sdk-logs` stamps a record with `Date.now()`, which has
// MILLISECOND resolution (read off the installed 0.219.0 build: `LogRecordImpl` sets
// `hrTime = timeInputToHrTime(timestamp ?? Date.now())`). So two records from the same
// process with the same body, emitted in the same millisecond, leave this process
// byte-identical: same resource, same body, same timestamp.
//
// Log stores commonly treat an entry with the same stream, timestamp and line as a
// duplicate and keep ONE. For a log store that does that, every same-millisecond repeat
// is silently discarded. Nothing errors and nothing counts it, and it is not rare. One
// request that runs the same procedure several times in a batch logs the same line
// several times in under a millisecond. Measured against such a store, a logger whose
// repeats come in bursts like that lost most of its records on the OTLP path. Loggers
// whose lines never repeat within one millisecond lost none, including one whose line
// text repeats constantly at different milliseconds. The OTLP-side count matched the
// number of distinct (process, line, millisecond) groups on the stdout copy, so the
// timestamp collision is the discriminating signal. Content alone is not enough.
//
// The fix is to make the timestamp unique per process. It keeps `Date.now()`'s
// millisecond as the wall-clock source of truth, and puts a per-process sequence number
// in the sub-millisecond nanoseconds, so the Nth record in a millisecond is stamped
// `ms + N ns`.
//   - Not `performance.now()`. It is offset from a time origin fixed at process start, so
//     it drifts from wall time across a long uptime, while the stdout copy of the same
//     line is stamped from wall time. `Date.now()` is also what the SDK uses here.
//   - Strictly increasing, even if the wall clock steps BACKWARDS. A backward step holds
//     the stamp at the last millisecond issued, still incrementing, until the wall clock
//     passes it again. A step of S ms therefore stamps records up to S ms late. The other
//     choice is to repeat a timestamp, which is the bug.
//   - Uniqueness holds only if every emitter in the process shares ONE sequence. Module
//     scope is enough for that because this module is a build-checked SINGLETON
//     (`scripts/server-graph-watchlist.mjs`). The build fails if a second emitted copy
//     appears, and such a copy would have its own counter and issue `ms + 0 ns` again.
const NANOS_PER_MS = 1_000_000;

const clock = { ms: -Infinity, seq: 0 };

/**
 * A wall-clock timestamp that is unique and strictly increasing within this process.
 *
 * Millisecond part from `now()` (default `Date.now()`), sub-millisecond part is a
 * per-millisecond sequence number. Exported for tests; `now` is injectable so a test can
 * hold the clock still or step it backwards.
 */
export function nextOtelLogTimestamp(now: () => number = Date.now): HrTime {
  const wall = Math.floor(now());
  if (wall > clock.ms) {
    clock.ms = wall;
    clock.seq = 0;
  } else if (++clock.seq >= NANOS_PER_MS) {
    // A million records in one millisecond: borrow the next millisecond rather than
    // wrap the sequence back onto a stamp already issued.
    clock.ms += 1;
    clock.seq = 0;
  }
  const seconds = Math.floor(clock.ms / 1000);
  const nanos = (clock.ms - seconds * 1000) * NANOS_PER_MS + clock.seq;
  return [seconds, nanos];
}

/** Forget the shared clock state. For tests only. */
export function resetOtelLogClock(): void {
  clock.ms = -Infinity;
  clock.seq = 0;
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------
/**
 * Emit one structured record over OTLP.
 *
 * DARK BY DEFAULT: does nothing unless `OTEL_LOGS_ENABLED === 'true'`. Read from
 * `process.env` on every call (a property read on a plain object) rather than captured
 * at module load, so the value a pod boots with is the value that applies.
 *
 * `body` is the CALLER'S already-serialized line, passed in verbatim rather than
 * re-serialized here. One serialization, two sinks: a query written against either path
 * matches on the other, and the hot path pays for one `JSON.stringify`, not two.
 *
 * Never throws. This runs inside a logging call that hot paths await; a telemetry sink
 * must not be able to fail the thing it is observing.
 *
 * @returns true if a record was handed to the Logs API.
 */
export function emitOtelLog(body: string, data: MixedObject, datastream?: string): boolean {
  try {
    if (process.env.OTEL_LOGS_ENABLED !== 'true') {
      otelLogRecordsSkippedCounter.inc({ reason: 'disabled' });
      return false;
    }

    const logger = resolveLogger();
    if (!logger) {
      otelLogRecordsSkippedCounter.inc({ reason: 'no_provider' });
      return false;
    }

    const { severityNumber, severityText } = deriveSeverity(data?.type);

    // Timestamps are set HERE, not left to the SDK — see `nextOtelLogTimestamp`. Both
    // fields get the SAME value, so a receiver that treats "observed == timestamp" as
    // redundant can still drop the second copy.
    // No trace/span id — the SDK reads the active context itself.
    const timestamp = nextOtelLogTimestamp();
    const record: ApiLogRecord = {
      severityNumber,
      body,
      attributes: buildOtelLogAttributes(data, datastream),
      timestamp,
      observedTimestamp: timestamp,
    };
    if (severityText !== undefined) record.severityText = severityText;

    logger.emit(record);
    otelLogRecordsEmittedCounter.inc();
    return true;
  } catch {
    try {
      otelLogRecordsSkippedCounter.inc({ reason: 'emit_threw' });
    } catch {
      /* a counter must not be able to break logging either */
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Provider construction
// ---------------------------------------------------------------------------
/** Batch settings. Defaults are the SDK's own; see `createOtelLoggerProvider`. */
export type OtelLoggerProviderOptions = {
  resource?: Resource;
  exporter: LogRecordExporter;
  /**
   * Hard ceiling on one export attempt. Coupled to the pod's termination grace period:
   * shutdown flushes on SIGTERM, and a hung collector must not hold that flush past the
   * grace period or the kubelet kills the process mid-export. The default is the value
   * that is safe under the SHORTEST grace period in the fleet; raise it per-workload
   * only where the grace period is known to be longer.
   */
  exportTimeoutMillis?: number;
};

export const OTEL_LOG_EXPORT_TIMEOUT_MS_DEFAULT = 5000;

/**
 * Build the LoggerProvider for the OTLP logs pipeline.
 *
 * Centralized here, rather than inline at the call site, so the `traceBased` hazard
 * below has exactly one place it could ever be introduced — and so a test can pin it.
 *
 * 🔴 NEVER pass a `loggerConfigurator` that sets `traceBased: true`. It drops any record
 * emitted inside a valid-but-unsampled span. Head trace sampling runs well below 1.0, so
 * enabling it would silently discard the large majority of in-request log records — with
 * no error, no counter, and no dropped-record signal anywhere. It is inert at the SDK's
 * defaults; keep it that way. Pinned by the `traceBased` regression test.
 *
 * The batch sizes are the SDK defaults, chosen deliberately rather than by omission:
 * measured record volume is well under one record/second/pod, so the queue holds many
 * minutes of buffer and each export is per-request overhead rather than payload.
 * `exportTimeoutMillis` is the one value made explicit, because it is the only one
 * coupled to something outside this process.
 */
export function createOtelLoggerProvider(opts: OtelLoggerProviderOptions): LoggerProvider {
  const processor: LogRecordProcessor = new BatchLogRecordProcessor(opts.exporter, {
    exportTimeoutMillis: opts.exportTimeoutMillis ?? OTEL_LOG_EXPORT_TIMEOUT_MS_DEFAULT,
  });

  return new LoggerProvider({
    ...(opts.resource ? { resource: opts.resource } : {}),
    processors: [processor],
  });
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------
export type OtelShutdownTarget = { shutdown: () => Promise<unknown> };

export type OtelShutdownController = {
  /** Run the shutdown (or return the already-running one). */
  shutdown: (reason?: string) => Promise<void>;
  /** The in-flight/settled shutdown promise, or undefined if nothing started it yet. */
  settled: () => Promise<void> | undefined;
  /** Remove the signal listeners this registration installed. */
  unregister: () => void;
};

export const OTEL_SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/**
 * Flush telemetry on termination.
 *
 * The shape this replaces listened on SIGTERM only and awaited NEITHER shutdown promise,
 * so the final batch raced pod termination — immaterial while the pipeline carried one
 * record per boot, a real loss path the moment it carries traffic.
 *
 * We only FLUSH here; we never `process.exit()`. The framework owns process lifecycle,
 * and exiting would kill in-flight requests during the drain.
 */
export function registerOtelShutdown(
  targets: OtelShutdownTarget[],
  opts: {
    signals?: readonly NodeJS.Signals[];
    log?: (message: string) => void;
    onError?: (reason: unknown) => void;
  } = {}
): OtelShutdownController {
  const signals = opts.signals ?? OTEL_SHUTDOWN_SIGNALS;
  const log = opts.log ?? ((m: string) => console.log(m));
  const onError =
    opts.onError ?? ((reason: unknown) => console.error('[otel] shutdown error:', reason));

  let inflight: Promise<void> | undefined;

  const run = async (reason: string): Promise<void> => {
    log(`[otel] flushing telemetry on ${reason}`);
    // allSettled, not all: a failing exporter must not prevent the other flush, and a
    // rejection here must not surface as an unhandled rejection during termination.
    const results = await Promise.allSettled(targets.map((t) => t.shutdown()));
    for (const r of results) if (r.status === 'rejected') onError(r.reason);
  };

  // `??=` is the idempotence guard AND the await seam. A second signal (SIGINT after
  // SIGTERM) joins the first shutdown instead of starting a second one against
  // already-shut providers.
  const start = (reason: string): Promise<void> => (inflight ??= run(reason));

  const listeners = signals.map((signal) => {
    const listener = () => {
      void start(signal);
    };
    // `once` alone is not enough — it is per-signal, so SIGINT after SIGTERM would still
    // start a second shutdown. The `??=` above is what actually makes it idempotent.
    process.once(signal, listener);
    return { signal, listener };
  });

  return {
    shutdown: (reason = 'manual') => start(reason),
    settled: () => inflight,
    unregister: () => {
      for (const { signal, listener } of listeners) process.removeListener(signal, listener);
    },
  };
}
