import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-node';
import { redactCredentialsInString } from '@civitai/axiom/redact-credentials';

/**
 * Scrubs credential query params and Bearer values from span attributes before export.
 * Inbound HTTP spans (`http.target`, `http.url`, `url.query`, `url.full`) and Next's own request
 * span carry the raw query string; the HTTP instrumentation's `redactedQueryParams` applies to
 * outgoing requests only.
 */
export class CredentialRedactingSpanProcessor implements SpanProcessor {
  constructor(private readonly inner: SpanProcessor) {}

  onStart(span: Span, parentContext: Context) {
    this.inner.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan) {
    // The SDK span's attributes object is still the live record at onEnd; exporters read it after.
    const attributes = span.attributes as Record<string, unknown>;
    for (const [key, value] of Object.entries(attributes)) {
      if (typeof value === 'string') attributes[key] = redactCredentialsInString(value);
      else if (Array.isArray(value))
        attributes[key] = value.map((v) =>
          typeof v === 'string' ? redactCredentialsInString(v) : v
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
