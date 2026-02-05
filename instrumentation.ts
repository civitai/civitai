export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Only enable OTEL if explicitly set AND endpoint is configured
    const OTEL_ENABLED = process.env.OTEL_ENABLED === 'true';
    const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

    console.log('[instrumentation] OTEL config:', {
      OTEL_ENABLED: process.env.OTEL_ENABLED,
      OTEL_EXPORTER_OTLP_ENDPOINT: OTEL_ENDPOINT,
      NODE_ENV: process.env.NODE_ENV,
      NEXT_RUNTIME: process.env.NEXT_RUNTIME,
      OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME,
    });

    // Skip OTEL if not explicitly enabled or no endpoint configured
    if (!OTEL_ENABLED) {
      console.log('[instrumentation] OTEL disabled (OTEL_ENABLED != true)');
      return;
    }

    if (!OTEL_ENDPOINT) {
      console.log('[instrumentation] OTEL disabled (no OTEL_EXPORTER_OTLP_ENDPOINT)');
      return;
    }

    if (process.env.NODE_ENV === 'test') {
      console.log('[instrumentation] OTEL disabled (test environment)');
      return;
    }

    try {
      const { NodeSDK } = await import('@opentelemetry/sdk-node');
      const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-proto');
      const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-proto');
      const { resourceFromAttributes } = await import('@opentelemetry/resources');
      const { ATTR_SERVICE_NAME } = await import('@opentelemetry/semantic-conventions');
      const { BatchSpanProcessor } = await import('@opentelemetry/sdk-trace-node');
      const { LoggerProvider, BatchLogRecordProcessor } = await import('@opentelemetry/sdk-logs');
      const { logs } = await import('@opentelemetry/api-logs');

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
      console.log(`[instrumentation] OTEL SDK started - traces and logs -> ${OTEL_ENDPOINT}`);

      // Test span
      const { trace } = await import('@opentelemetry/api');
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
      console.error('[instrumentation] Failed to initialize OTEL:', error);
    }
  }
}
