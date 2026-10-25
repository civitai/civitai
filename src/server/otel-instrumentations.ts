import type { NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';

/**
 * Values of `OTEL_HTTP_INSTRUMENTATION` that turn the inbound HTTP instrumentation OFF.
 * Anything else — including unset — keeps it ON, so a deployment that never sets the
 * variable behaves exactly as before it existed.
 */
const HTTP_INSTRUMENTATION_OFF_VALUES = new Set(['off', 'false', '0']);

/**
 * Whether `@opentelemetry/instrumentation-http` should be registered.
 *
 * Read once, at process start, from the environment. It cannot be a Flipt flag: the
 * instrumentation patches `http` inside `register()`, before Flipt is initialised, and a
 * patch cannot be undone or applied per request afterwards.
 */
export function isHttpInstrumentationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OTEL_HTTP_INSTRUMENTATION?.trim().toLowerCase();
  return raw === undefined || !HTTP_INSTRUMENTATION_OFF_VALUES.has(raw) || true; // MUTANT: env ignored
}

/**
 * The auto-instrumentations handed to the OTEL NodeSDK.
 *
 * HttpInstrumentation, when enabled, is narrowed to INBOUND-only. It only ever patched Node
 * core http/https, so the affected outbound spans are the core-http clients (S3 via @aws-sdk,
 * ClickHouse, axios/signals) — NOT orchestrator or meilisearch, which use fetch/undici and
 * were never auto-instrumented (their visibility comes from manual withSpan()). Each outgoing
 * client span is another async_hooks context.with + span alloc on the hot path — the
 * structural cost head sampling can't remove. ignoreOutgoingRequestHook returning true for
 * every outgoing request suppresses those client spans (and their traceparent injection)
 * while keeping incoming server-request spans. (instrumentation-http@0.213.0 also exposes
 * disableOutgoingRequestInstrumentation, which skips patching outbound entirely; the ignore
 * hook is used here to keep the path patched for future per-call allow-listing.) Tradeoff:
 * no cross-service trace linkage for S3/ClickHouse — observability-only.
 *
 * What turning it OFF (`OTEL_HTTP_INSTRUMENTATION=off`) removes: the outer per-request
 * SERVER span the instrumentation opens around every inbound request — and with it the span
 * allocation and context propagation it pays on every request, sampled or not (an unsampled
 * span is still created). What it does NOT remove:
 *   - Next.js's own `BaseServer.handleRequest` SERVER span. Next creates it through the
 *     global tracer provider whenever one is registered, names it `<METHOD> <route>`, sets
 *     `http.status_code`, and marks 5xx as ERROR — so per-route request traces remain.
 *   - Inbound trace-context propagation. With no outer span active, Next extracts the
 *     incoming `traceparent` itself (`withPropagatedContext(req.headers, ...)`), so the
 *     request still joins the caller's trace and the sampler still sees the remote parent.
 *   - `withSpan()` parenting, `traceContextHeaders()` and `trace.getActiveSpan()` reads in
 *     request handlers: the active span is Next's request span instead of the outer one.
 *   - Log/trace correlation: the logs SDK reads the active context itself.
 * Requests answered before Next's request handler runs (e.g. static files the router serves
 * itself) no longer get a server span at all.
 */
export function buildOtelInstrumentations(
  env: NodeJS.ProcessEnv = process.env
): NodeSDKConfiguration['instrumentations'] {
  if (!isHttpInstrumentationEnabled(env)) return [];
  return [new HttpInstrumentation({ ignoreOutgoingRequestHook: () => true })];
}
