import { trace, context, ROOT_CONTEXT, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('civitai-app');

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
  const [attrs, fn] =
    typeof attrsOrFn === 'function' ? [{}, attrsOrFn] : [attrsOrFn, maybeFn!];

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
