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
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { registerCpuProfiler } from '~/server/cpu-profiler';

// Arm the on-demand, signal-triggered V8 CPU profiler. Zero steady-state
// overhead; only does work when signalled. Independent of OTEL so it is
// always available for live incident capture. See src/server/cpu-profiler.ts.
registerCpuProfiler();

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
      // span regardless of the sampling decision). Redis latency is already
      // covered by prom-client metrics, so the observability loss is minimal.
      instrumentations: [new HttpInstrumentation(), new PrismaInstrumentation()],
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
