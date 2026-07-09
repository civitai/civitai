import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  type Sampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-web';

/**
 * Browser-trace sampling for Faro RUM (the pre-widening volume gate).
 *
 * WHY THIS IS A SEPARATE, DECOUPLED LAYER (the crux):
 * Faro has TWO independent sampling layers:
 *   1. SESSION sampling (`sessionTracking.samplingRate`, from
 *      NEXT_PUBLIC_FARO_SESSION_SAMPLE_RATE=1.0) gates *whether a session emits signals
 *      at all* — errors, web-vitals, events, and sessions. It is NOT an OTel concept.
 *   2. OTel SPAN sampling (this module) gates *only the browser tracer's spans*
 *      (fetch/xhr HTTP spans), which are the sole thing exported to the traces backend.
 *
 * Stock `@grafana/faro-web-tracing@2.8.2` COUPLES the two: its `TracingInstrumentation`
 * hardcodes the WebTracerProvider's sampler to `getSamplingDecision(session)`, i.e. a span
 * is recorded iff the *session* is sampled. With session sampling at 1.0 that means ~100%
 * of browser traces — too much volume to widen RUM past the mod cohort.
 *
 * `SampledTracingInstrumentation` replaces that coupled sampler with the genuine OTel
 * sampler this module builds. Because it swaps ONLY the tracer-provider sampler, session
 * sampling stays 1.0 → errors + web-vitals + events + sessions remain 100%. Only spans are
 * sub-sampled. That decoupling is guaranteed by the SDK's two-layer architecture, not by a
 * heuristic.
 */

/** Parse an env string to a rate in [0, 1], falling back on non-finite / unset input. */
export function parseRate(value: string | undefined, fallback: number): number {
  const n = Number.parseFloat(value ?? '');
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/**
 * Build the genuine OTel sampler for the browser WebTracerProvider from a rate in [0, 1].
 *
 * Edge cases (per the pre-widening gate spec):
 *   - rate >= 1 → `AlwaysOnSampler` (record every browser trace; effectively no sampling).
 *   - rate <= 0 → `AlwaysOffSampler` (no browser traces — errors/web-vitals/events still
 *     flow at 100% via the session layer, which this does not touch).
 *   - otherwise → `ParentBasedSampler({ root: TraceIdRatioBasedSampler(rate) })`.
 *
 * Why `ParentBased(root=TraceIdRatio)` rather than a bare `TraceIdRatioBasedSampler`:
 * it is the OTel-idiomatic web choice. Root spans (the common case for browser fetch/xhr —
 * no active parent) get the ratio decision; any child spans within the same trace inherit
 * the root's sampled flag, so a trace is kept or dropped *coherently* instead of partially.
 * The decision is derived from the trace id, so it is deterministic and uniformly ~rate.
 */
export function createTraceSampler(rate: number): Sampler {
  const clamped = Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 0.1;
  if (clamped >= 1) return new AlwaysOnSampler();
  if (clamped <= 0) return new AlwaysOffSampler();
  return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(clamped) });
}

export interface FaroSampling {
  /** Feeds Faro `sessionTracking.samplingRate` — gates ALL signals (errors/vitals/events). */
  sessionSamplingRate: number;
  /** Feeds the browser WebTracerProvider — gates ONLY OTel spans. */
  traceSampler: Sampler;
}

/**
 * Resolve both sampling layers from their env vars. This function is the wiring boundary
 * that PROVES the decoupling: `sessionSamplingRate` is read from the SESSION env and
 * `traceSampler` from the TRACES env — neither is derived from the other, so changing the
 * trace ratio can never change how much of a session's errors/web-vitals are collected.
 */
export function resolveFaroSampling(
  sessionRateRaw: string | undefined,
  traceRateRaw: string | undefined
): FaroSampling {
  return {
    sessionSamplingRate: parseRate(sessionRateRaw, 1.0),
    traceSampler: createTraceSampler(parseRate(traceRateRaw, 0.1)),
  };
}
