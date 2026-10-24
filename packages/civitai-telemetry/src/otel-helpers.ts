import { trace, context, propagation, ROOT_CONTEXT, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('civitai-app');

/**
 * Set attributes on the CURRENTLY ACTIVE span, if there is one. For values only known after the
 * work inside a `withSpan` callback has finished (a result count, an attempt count) — call it from
 * INSIDE the callback, where the active span is the one `withSpan` opened; called outside, the
 * active span is the caller's and the attribute lands on the wrong span. No-op when tracing is
 * disabled or no span is active, and never throws.
 */
export function setActiveSpanAttributes(attrs: Record<string, string | number | boolean>): void {
  try {
    trace.getActiveSpan()?.setAttributes(attrs);
  } catch {
    // Telemetry must never fail the work it describes.
  }
}

/**
 * W3C trace-context headers (`traceparent`, and `tracestate` when present) for the
 * CURRENTLY ACTIVE span, ready to merge into an outbound request's headers.
 *
 * WHY this exists as a manual helper rather than an auto-instrumentation: this app runs
 * `HttpInstrumentation({ ignoreOutgoingRequestHook: () => true })` (instrumentation.node.ts)
 * — outbound client spans, and with them traceparent injection, are deliberately suppressed
 * on Node core http/https for their per-request `async_hooks` cost. The orchestrator and
 * meilisearch clients use fetch/undici and were NEVER auto-instrumented at all, so no
 * outbound call anywhere in the app currently carries a traceparent and no trace crosses a
 * service boundary. Injecting per-call — only at the boundaries we care about — buys the
 * cross-service linkage without re-introducing the whole-app span cost that was removed.
 *
 * TOTAL and cheap: it reads the ambient context and writes strings. When OTEL is disabled
 * the global propagator is the API's no-op, so this returns `{}` and callers spread nothing.
 * Never throws — a telemetry fault must not fail the request it is describing.
 */
export function traceContextHeaders(): Record<string, string> {
  try {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    return carrier;
  } catch {
    return {};
  }
}

export function withSpan<T>(name: string, fn: () => T): T;
export function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: () => T
): T;
export function withSpan<T>(
  name: string,
  attrsOrFn: Record<string, string | number | boolean> | (() => T),
  maybeFn?: () => T
): T {
  const [attrs, fn] = typeof attrsOrFn === 'function' ? [{}, attrsOrFn] : [attrsOrFn, maybeFn!];

  return tracer.startActiveSpan(name, (span) => {
    try {
      if (attrs) span.setAttributes(attrs);
      const result = fn();
      if (result instanceof Promise) {
        return (result as Promise<unknown>)
          .catch((e) => {
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.recordException(e as Error);
            throw e;
          })
          .finally(() => span.end()) as T;
      }
      span.end();
      return result;
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(e as Error);
      span.end();
      throw e;
    }
  });
}

// Variant of withSpan for work that outlives the current active span — e.g.
// fire-and-forget shadow comparators that intentionally continue running after
// the user-facing request has returned. Starts a new root span (no parent) with
// a Link back to the current active span so trace search can still correlate
// them. Without this, the shadow span would close after its parent, producing
// child end-times past parent end-times in trace UIs.
export function withDetachedSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: () => Promise<T>
): Promise<T> {
  const parentSpanContext = trace.getActiveSpan()?.spanContext();
  const span = tracer.startSpan(
    name,
    {
      attributes: attrs,
      links: parentSpanContext ? [{ context: parentSpanContext }] : [],
    },
    ROOT_CONTEXT
  );
  return context.with(trace.setSpan(ROOT_CONTEXT, span), async () => {
    try {
      const result = await fn();
      span.end();
      return result;
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(e as Error);
      span.end();
      throw e;
    }
  });
}

// Strip credentials and query string from a URL before stamping it as an
// `http.url` span attribute. Trace storage is shared and not credential-aware;
// don't ship anything in URL components that you wouldn't want in a dashboard.
// Returns the original string verbatim if URL parsing fails (no surprises).
export function safeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.search = '';
    return u.toString();
  } catch {
    return raw;
  }
}
