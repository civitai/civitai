import { ROOT_CONTEXT } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-web';
import {
  BatchSpanProcessor,
  SamplingDecision,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-web';
import { faro } from '@grafana/faro-web-sdk';
import { FaroMetaAttributesSpanProcessor, FaroTraceExporter } from '@grafana/faro-web-tracing';

/**
 * Per-trace ratio sampling for Faro browser tracing.
 *
 * WHY THIS EXISTS: Faro couples trace sampling to SESSION sampling — its built-in
 * `TracingInstrumentation` samples a trace iff the session's `isSampled` flag is set,
 * and a non-sampled session drops ALL signals (errors, web-vitals, traces). To keep
 * errors + web-vitals at 100% we must run session sampling at 1.0, which would then
 * record 100% of traces. The SDK exposes no per-trace sampler seam; the only supported
 * lever it hands us is the `spanProcessor` option. So we REPLACE the default trace
 * span-processor pipeline with a wrapper that reconstructs Faro's exact export chain
 * (`FaroMetaAttributesSpanProcessor` → `BatchSpanProcessor` → `FaroTraceExporter`) and
 * gates export through a `TraceIdRatioBasedSampler`.
 *
 * Because `TraceIdRatioBasedSampler` decides purely from the traceId, every span in a
 * trace gets the SAME keep/drop decision — whole traces are kept or dropped together,
 * so we never emit orphaned partial traces.
 *
 * ⚠️ Pinned to @grafana/faro-web-tracing 2.8.2: the inner batch config
 * (`scheduledDelayMillis` / `maxExportBatchSize`) mirrors that version's internal
 * defaults. A Faro bump should re-verify these against the SDK's `instrumentation.ts`.
 * `@opentelemetry/sdk-trace-web` is pinned to Faro's resolved 2.9.0 so both sides share
 * one otel singleton (no dual-copy `instanceof` mismatch).
 */

// Mirrors TracingInstrumentation.SCHEDULED_BATCH_DELAY_MS / maxExportBatchSize (2.8.2).
const SCHEDULED_BATCH_DELAY_MS = 1000;
const MAX_EXPORT_BATCH_SIZE = 30;

export function createRatioSampledSpanProcessor(sampleRate: number): SpanProcessor {
  const sampler = new TraceIdRatioBasedSampler(sampleRate);

  // Lazily built: the Faro export pipeline needs `faro.api` / `faro.metas`, which are
  // only populated after `initializeFaro()` returns. Spans only start after init, so
  // by the time `onStart`/`onEnd` fire the global `faro` instance is ready.
  let inner: SpanProcessor | null = null;
  const getInner = (): SpanProcessor | null => {
    if (inner) return inner;
    if (!faro?.api || !faro?.metas) return null;
    inner = new FaroMetaAttributesSpanProcessor(
      new BatchSpanProcessor(new FaroTraceExporter({ api: faro.api }), {
        scheduledDelayMillis: SCHEDULED_BATCH_DELAY_MS,
        maxExportBatchSize: MAX_EXPORT_BATCH_SIZE,
      }),
      faro.metas
    );
    return inner;
  };

  // otel 2.9's TraceIdRatioBasedSampler.shouldSample takes only (context, traceId) —
  // it decides purely from the traceId, so the decision is stable across every span in
  // the trace (whole traces are kept or dropped together, never partially).
  const isTraceSampled = (traceId: string): boolean =>
    sampler.shouldSample(ROOT_CONTEXT, traceId).decision !== SamplingDecision.NOT_RECORD;

  return {
    onStart(span: Span, parentContext) {
      getInner()?.onStart(span, parentContext);
    },
    onEnd(span: ReadableSpan) {
      if (!isTraceSampled(span.spanContext().traceId)) return;
      getInner()?.onEnd(span);
    },
    forceFlush() {
      return inner ? inner.forceFlush() : Promise.resolve();
    },
    shutdown() {
      return inner ? inner.shutdown() : Promise.resolve();
    },
  };
}
