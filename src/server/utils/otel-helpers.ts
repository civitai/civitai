import { trace, SpanStatusCode } from '@opentelemetry/api';

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
