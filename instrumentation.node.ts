// Node.js-specific OpenTelemetry instrumentation
// Using STATIC imports so Next.js can trace dependencies for standalone output
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { logs } from '@opentelemetry/api-logs';
import { trace } from '@opentelemetry/api';

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

    // Create SDK with trace processor
    const sdk = new NodeSDK({
      resource,
      spanProcessor: new BatchSpanProcessor(traceExporter),
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
