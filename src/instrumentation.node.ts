// Node.js-specific OpenTelemetry instrumentation
// Using STATIC imports so Next.js can trace dependencies for standalone output
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { logs } from '@opentelemetry/api-logs';
import { trace } from '@opentelemetry/api';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { registerCpuProfiler, registerEventLoopStallProfiler } from '~/server/cpu-profiler';
import { registerEventLoopLongTaskDetector } from '~/server/eventloop-longtask';
import { registerLivenessHeartbeat } from '~/server/liveness-heartbeat';
import { registerNotificationsFailureLogging } from '~/server/notifications/register-failure-logging';

// Arm the on-demand, signal-triggered V8 CPU profiler. Zero steady-state
// overhead; only does work when signalled. Independent of OTEL so it is
// always available for live incident capture. See src/server/cpu-profiler.ts.
registerCpuProfiler();

// Arm the event-loop-stall SELF-TRIGGER for the same CPU profiler. An external
// signal can't reach a fully-pinned loop (the SIGWINCH black-hole), so this
// watches the pod's OWN event-loop lag and auto-arms V8's (separate-thread)
// sampler when lag crosses a threshold — the one mechanism that captures a 504
// wave's pin. DISARMED by default (no timer, no histogram, zero overhead) unless
// CPU_PROFILE_LAG_TRIGGER_MS is set (suggested: 1000) on the dp-prod-api
// deployment. See src/server/cpu-profiler.ts.
registerEventLoopStallProfiler();

// Arm the event-loop long-task detector. DISARMED by default (no-op unless
// EVENTLOOP_LONGTASK_THRESHOLD_MS > 0), in which case the request hot path runs
// completely untouched (no ALS wrapper). Base armed mode adds only the
// monitorEventLoopDelay lag gauge + a drift detector (cheap, no async_hooks).
// Per-procedure ALS label attribution (EVENTLOOP_LONGTASK_LABELS) and async_hooks
// stack capture (EVENTLOOP_LONGTASK_STACKS) are separate opt-in tiers for short
// diagnostic windows — they add async-context-propagation cost and are NOT
// enabled by base armed mode. Independent of OTEL.
// See src/server/eventloop-longtask.ts.
registerEventLoopLongTaskDetector();

// Write an on-the-event-loop liveness heartbeat file (epoch-seconds, every 2s)
// for an EXEC liveness probe to read. Lets the kubelet tell a busy-but-alive
// pinned pod (loop still flushing timers) from a truly-wedged one — retiring the
// ~15min probe-tolerance band-aid that the httpGet `/api/live` liveness needed
// because it's served by the same saturated loop. See liveness-heartbeat.ts and
// the liveness history in datapacket-talos deployment-api.yaml.
registerLivenessHeartbeat();

// Route ALL notification-server request failures to one Axiom event
// (name 'notifications-request-failed', datastream 'notifications'), so a
// failed create/read/mark/bulk anywhere is a single thing to alert on.
registerNotificationsFailureLogging();

// Kick the in-process route warmer (fire-and-forget). Next standalone
// lazy-require()s each route on first hit; the dependency-only readiness probe
// marks a pod Ready while every hot route is still cold, so the first real
// /api/v1/images / tRPC / SSR request pays lazy-require + JIT on the single
// loop thread → pin → 504/502/499 on every rollout. The warmer self-requests
// the hot routes over localhost during startup and flips /api/ready's warm gate
// only once warm (fail-open). It is OPT-IN via WARMUP_ENABLED (default FALSE —
// runs ONLY when WARMUP_ENABLED='true', set on the dp-prod SSR/API/heavy pools;
// elsewhere it no-ops + flips warm immediately). It self-imports lazily so the
// fetch/route code isn't pulled into the boot path needlessly.
//
// CRITICAL: do NOT await this. register() must return so Next can start the
// HTTP listener — the warmer needs that listener up to self-request, so
// awaiting here would deadlock boot. Any import/throw is swallowed: warmup must
// never block or crash boot.
void import('~/server/warmup')
  .then((m) => m.runWarmup())
  .catch((err) => {
    console.error('[instrumentation.node] warmup kick failed (fail-open):', err);
  });

// Only enable OTEL if explicitly set AND endpoint is configured
const OTEL_ENABLED = process.env.OTEL_ENABLED === 'true';
const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

console.log('[instrumentation.node] OTEL config:', {
  OTEL_ENABLED: process.env.OTEL_ENABLED,
  OTEL_EXPORTER_OTLP_ENDPOINT: OTEL_ENDPOINT,
  NODE_ENV: process.env.NODE_ENV,
  NEXT_RUNTIME: process.env.NEXT_RUNTIME,
  OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME,
});

// Skip OTEL if not explicitly enabled or no endpoint configured
if (!OTEL_ENABLED) {
  console.log('[instrumentation.node] OTEL disabled (OTEL_ENABLED != true)');
} else if (!OTEL_ENDPOINT) {
  console.log('[instrumentation.node] OTEL disabled (no OTEL_EXPORTER_OTLP_ENDPOINT)');
} else if (process.env.NODE_ENV === 'test') {
  console.log('[instrumentation.node] OTEL disabled (test environment)');
} else {
  try {
    const serviceName = process.env.OTEL_SERVICE_NAME || process.env.SERVICE_NAME || 'civitai-app';

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
    });

    // Head trace sampling. Previously unset, so NodeSDK defaulted to AlwaysOn
    // (100% of requests recorded + exported). At ~1500 req/s on a single JS
    // thread that recording/attribute/export work is a measurable slice of
    // main-thread CPU. Sample a fraction of root traces instead; child spans
    // follow their parent's decision so each trace is all-or-nothing.
    // Tune without a redeploy via OTEL_TRACES_SAMPLE_RATIO (0..1).
    const parsedRatio = parseFloat(process.env.OTEL_TRACES_SAMPLE_RATIO ?? '');
    const sampleRatio =
      Number.isFinite(parsedRatio) && parsedRatio >= 0 && parsedRatio <= 1 ? parsedRatio : 0.1;
    const ratioSampler = new TraceIdRatioBasedSampler(sampleRatio);
    const sampler = new ParentBasedSampler({
      root: ratioSampler,
      // This is a PUBLIC API with no traceparent stripping at the edge, so an
      // untrusted client could send `traceparent: ...-01` to force a sampled
      // decision. ParentBased's default `remoteParentSampled` is AlwaysOn, which
      // would let any client defeat the sampling cap and re-saturate CPU — the
      // exact failure this change prevents. Apply the ratio to remote parents
      // too. Local parents still inherit, so intra-process traces stay coherent.
      remoteParentSampled: ratioSampler,
    });
    console.log(`[instrumentation.node] OTEL trace sampling ratio: ${sampleRatio}`);

    // Trace exporter
    const traceExporter = new OTLPTraceExporter({
      url: `${OTEL_ENDPOINT}/v1/traces`,
    });

    // Log exporter
    const logExporter = new OTLPLogExporter({
      url: `${OTEL_ENDPOINT}/v1/logs`,
    });

    // Set up logger provider with processors in config
    const loggerProvider = new LoggerProvider({
      resource,
      processors: [new BatchLogRecordProcessor(logExporter)],
    });
    logs.setGlobalLoggerProvider(loggerProvider);

    // Create SDK with trace processor and auto-instrumentations
    const sdk = new NodeSDK({
      resource,
      sampler,
      spanProcessor: new BatchSpanProcessor(traceExporter),
      // RedisInstrumentation intentionally omitted: at ~5,400 redis ops/s it was
      // the highest-frequency span source (~4 spans/request) and the dominant
      // async_hooks context-propagation cost a CPU pin profile attributed to OTEL
      // — and head sampling can't remove that (the context manager runs for every
      // span regardless of the sampling decision). Observability tradeoff: this
      // removes the only PER-COMMAND redis timing the app had — there is NO redis
      // command-latency prom metric (only cache hit/miss counters). Accepted for
      // the CPU win; if per-command redis latency is needed later, add a
      // low-cardinality prom histogram around sendCommand (cheaper than a span —
      // no context.with / async_hooks propagation).
      //
      // PrismaInstrumentation intentionally omitted for the same structural reason:
      // it wraps every query on the hot DB path, and each query span pays the
      // async_hooks context-propagation cost (context.with + span alloc) that head
      // sampling can't remove — the context manager runs for every span regardless
      // of the sampling decision. Observability tradeoff: this removes Prisma query
      // spans, but the app's RED/latency dashboards are prom-client based
      // (src/server/prom/client.ts), NOT OTEL spanmetrics (which aren't scraped into
      // Prometheus), and DB pool metrics are separate labeled gauges
      // (db/db-helpers.ts). So no dashboard depends on these spans. The custom
      // withSpan() instrumentation on specific hot calls is unaffected.
      instrumentations: [
        // HttpInstrumentation narrowed to INBOUND-only. It only ever patched Node
        // core http/https, so the affected outbound spans are the core-http
        // clients (S3 via @aws-sdk, ClickHouse, axios/signals) — NOT orchestrator
        // or meilisearch, which use fetch/undici and were never auto-instrumented
        // (their visibility comes from manual withSpan()). Each remaining outgoing
        // client span is another async_hooks context.with + span alloc on the hot
        // path — the structural cost head sampling can't remove.
        // ignoreOutgoingRequestHook returning true for every outgoing request
        // suppresses those client spans (and their traceparent injection) while
        // keeping incoming server-request spans (the per-request root) intact.
        // (instrumentation-http@0.213.0 also exposes
        // disableOutgoingRequestInstrumentation, which skips patching outbound
        // entirely; the ignore hook is used here to keep the path patched for
        // future per-call allow-listing.) Tradeoff: lost cross-service trace
        // linkage for S3/ClickHouse — observability-only; nothing in the app reads
        // traceparent functionally. The custom withSpan() spans are unaffected.
        new HttpInstrumentation({ ignoreOutgoingRequestHook: () => true }),
      ],
    });

    sdk.start();
    console.log(`[instrumentation.node] OTEL SDK started - traces and logs -> ${OTEL_ENDPOINT}`);

    // Test span
    const testTracer = trace.getTracer('instrumentation-test');
    testTracer.startActiveSpan('test-span', (span) => {
      span.end();
    });

    // Test log
    const logger = logs.getLogger('instrumentation-test');
    logger.emit({
      severityNumber: 9, // INFO
      severityText: 'INFO',
      body: 'OTEL instrumentation initialized',
      attributes: { service: serviceName },
    });

    // Cleanup on exit
    process.on('SIGTERM', () => {
      loggerProvider.shutdown();
      sdk.shutdown();
    });
  } catch (error) {
    console.error('[instrumentation.node] Failed to initialize OTEL:', error);
  }
}
