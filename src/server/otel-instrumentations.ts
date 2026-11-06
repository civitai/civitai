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
  return raw === undefined || !HTTP_INSTRUMENTATION_OFF_VALUES.has(raw);
}

/**
 * Values of `OTEL_HTTP_OUTGOING` that stop HttpInstrumentation from patching Node's outbound
 * `http.request` / `http.get` (and the https ones). Anything else — including unset — keeps the
 * patch, so a deployment that never sets the variable behaves exactly as before it existed.
 */
const HTTP_OUTGOING_OFF_VALUES = new Set(['off', 'false', '0']);

/**
 * Whether HttpInstrumentation should patch OUTBOUND core-http calls at all.
 *
 * The outbound side already exports nothing: `ignoreOutgoingRequestHook` below returns true for
 * every request, so no client span is started and no `traceparent` is injected. But the patch
 * still runs on every outbound call: the wrapper parses the call's options into a fresh options
 * object (`getRequestInfo`) and calls the hook before handing that copy to the real
 * `http.request`. With this switch off the module is never patched, so outbound calls run Node's
 * own `http.request` with the caller's own arguments, and the exported telemetry is the same.
 *
 * Read once, at process start, like `OTEL_HTTP_INSTRUMENTATION`: a patch cannot be applied or
 * removed per request.
 */
export function isHttpOutgoingPatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OTEL_HTTP_OUTGOING?.trim().toLowerCase();
  return raw === undefined || !HTTP_OUTGOING_OFF_VALUES.has(raw);
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
 * while keeping incoming server-request spans. By default the outbound path stays PATCHED (the
 * hook only ignores each call), which keeps it ready for per-call allow-listing;
 * `OTEL_HTTP_OUTGOING=off` sets `disableOutgoingRequestInstrumentation` so it is never patched,
 * which exports the same telemetry for less work per outbound call. Tradeoff:
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
 * Also gone with it OFF:
 *   - The instrumentation's own HTTP server metric (`http.server.duration`), which the SDK
 *     exports through its default OTLP metric exporter. Anything built on that metric stops
 *     receiving data.
 *   - The trace ROOT for requests the middleware lets through: it becomes Next's short
 *     middleware-pass span (bare-verb name, no `http.route`, `next.bubble`), with the routed
 *     request span as its child. Queries keyed on the root span's name, duration or status
 *     read differently; span metrics that drop `next.bubble` spans do not.
 */
export function buildOtelInstrumentations(
  env: NodeJS.ProcessEnv = process.env
): NodeSDKConfiguration['instrumentations'] {
  if (!isHttpInstrumentationEnabled(env)) return [];
  return [
    new HttpInstrumentation({
      ignoreOutgoingRequestHook: () => true,
      // OTEL_HTTP_OUTGOING=off: do not patch outbound calls at all (see isHttpOutgoingPatchEnabled).
      // Unset keeps the option unset, exactly the config every deployment ran before the switch.
      ...(isHttpOutgoingPatchEnabled(env) ? {} : { disableOutgoingRequestInstrumentation: true }),
    }),
  ];
}
