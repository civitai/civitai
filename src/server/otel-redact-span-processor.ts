import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-node';
import { redactCredentialsInString } from '@civitai/axiom/redact-credentials';

/**
 * Scrubs credential query params and Bearer values from span attributes before export.
 * Inbound HTTP spans (`http.target`, `http.url`, `url.query`, `url.full`) and Next's own request
 * span carry the raw query string; the HTTP instrumentation's `redactedQueryParams` applies to
 * outgoing requests only.
 */
function scrubAttributes(attrs: object) {
  const attributes = attrs as Record<string, unknown>;
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string') attributes[key] = redactCredentialsInString(value);
    else if (Array.isArray(value))
      attributes[key] = value.map((v) =>
        typeof v === 'string' ? redactCredentialsInString(v) : v
      );
  }
}

export class CredentialRedactingSpanProcessor implements SpanProcessor {
  constructor(private readonly inner: SpanProcessor) {}

  onStart(span: Span, parentContext: Context) {
    this.inner.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan) {
    // The SDK span's attributes, events and status are still the live record at onEnd; exporters
    // read them after. Events carry recordException's message and stack.
    scrubAttributes(span.attributes);
    for (const event of span.events) if (event.attributes) scrubAttributes(event.attributes);
    if (span.status.message) {
      (span.status as { message?: string }).message = redactCredentialsInString(
        span.status.message
      );
    }
    this.inner.onEnd(span);
  }

  forceFlush() {
    return this.inner.forceFlush();
  }

  shutdown() {
    return this.inner.shutdown();
  }
}
