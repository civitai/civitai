import { useEffect } from 'react';
import {
  ErrorsInstrumentation,
  faro,
  initializeFaro,
  NavigationInstrumentation,
  SessionInstrumentation,
  type TransportItem,
  ViewInstrumentation,
  WebVitalsInstrumentation,
} from '@grafana/faro-web-sdk';
import { env } from '~/env/client';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { buildRumExperimentAttributes } from '~/utils/faro/experimentFlags';
import { deepRedact } from '~/utils/faro/redact';
import { resolveFaroSampling } from '~/utils/faro/traceSampler';
import { buildResourceTimingInstrumentations } from './ResourceTimingInstrumentation';
import { SampledTracingInstrumentation } from './SampledTracingInstrumentation';

/**
 * Faro Real-User-Monitoring bootstrap (Phase 1 — SHIPPED DARK).
 *
 * Initialises the Grafana Faro Web SDK ONLY when all of the following hold:
 *   1. `NEXT_PUBLIC_FARO_ENABLED` build-arg is true, AND
 *   2. `NEXT_PUBLIC_FARO_COLLECTOR_URL` is set, AND
 *   3. the runtime `faro` feature flag is on.
 * If any is off it renders nothing and does nothing.
 *
 * KILL-SWITCH SCOPE: flipping the `faro` flag off takes effect on the NEXT page
 * load/navigation. It best-effort `faro.pause()`s already-open tabs on a true→false
 * transition, but the flag is SSR-seeded + client-cached, so open sessions may not see
 * the change until reload. For an immediate cluster-wide stop, disable the
 * `faro.civitai.com` ingress (infra kill-switch).
 *
 * Instrumentations (EXPLICIT allow-list — NOT the getWebInstrumentations() default set):
 * errors, web-vitals, session (required for sampling), view, navigation, tracing, and —
 * behind its own build-arg + a cohort Flipt flag — a privacy-safe Resource Timing decomposition.
 * DELIBERATELY EXCLUDED for privacy on this adult/payments platform: the stock Performance
 * instrumentation (emits full resource URLs), UserAction (captures element datasets), CSP,
 * and Console (serialises arbitrary logged objects). NO session replay.
 *
 * The Resource Timing decomposition (`ResourceTimingInstrumentation`) is the ONE resource-timing
 * surface we allow: unlike stock Performance it normalizes every URL to a coarse route BEFORE
 * emit (no URL/query ever leaves the browser), scopes to same-origin `/api` only, and is
 * volume-gated independently of trace sampling. It is gated on BOTH (AND):
 *   - the `NEXT_PUBLIC_FARO_RESOURCE_TIMING_ENABLED` build-arg (default OFF) = compiled-in
 *     master enable/kill, AND
 *   - the `faro-resource-timing` Flipt flag (`features.faroResourceTiming`, base `enabled:false`)
 *     = which COHORT — so it ramps by % of users at RUNTIME, mirroring how the main `faro` flag
 *     ramped. Never flip it 100%-at-once; bump the Flipt % rollout and watch the faro-rum stream
 *     bytes stay under the 10 MB/s per-stream ceiling.
 * The cohort boolean is read once at first-init (threaded in via `initFaro`, same model as the
 * `features.faro` gate on the whole SDK) — a flag change applies on the next page load.
 * See ResourceTimingInstrumentation.
 *
 * SAMPLING (two decoupled layers):
 *   - SESSION sampling (`NEXT_PUBLIC_FARO_SESSION_SAMPLE_RATE`, 1.0) gates ALL signals →
 *     errors + web-vitals + events + sessions stay at 100%.
 *   - BROWSER-TRACE sampling (`NEXT_PUBLIC_FARO_TRACES_SAMPLE_RATE`, ~0.1) samples ONLY the
 *     OTel fetch/xhr spans, via a genuine `TraceIdRatioBasedSampler` on the browser tracer
 *     provider (see `SampledTracingInstrumentation`). Lowering it reduces trace volume
 *     WITHOUT reducing error/web-vitals coverage — the pre-widening gate. Because the two
 *     layers are independent, a non-sampled trace does NOT drop that session's errors/vitals.
 *
 * Every outgoing beacon is run through the deterministic PII scrub (`beforeSend`), which
 * FAILS CLOSED (drops the beacon on any scrub error).
 *
 * Must live inside `FeatureFlagsProvider` (for the flag) which is inside
 * `IsClientProvider` (client-only, high in the tree).
 */

// Module + window guards make init idempotent across React StrictMode double-mount
// and Next.js Fast-Refresh (HMR), where the module state can reset but the global
// Faro instance persists.
let faroInitStarted = false;
const WINDOW_GUARD_KEY = '__civitaiFaroInitialized__';

/**
 * Regex matching same-origin `/api` URLs. Note: `@opentelemetry/sdk-trace-web` attaches
 * `traceparent` to ALL same-origin requests regardless of this list; the list only gates
 * CROSS-origin propagation. A same-origin matcher can never match a cross-origin URL, so
 * its practical effect is: no third-party (cross-origin) request ever receives the header.
 */
function sameOriginApiMatcher(): RegExp {
  const origin = window.location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${origin}/api(/|$)`);
}

/**
 * Deterministic PII scrub applied to EVERY beacon before it leaves the browser.
 * FAILS CLOSED: on any scrub error it returns `null`, which the Faro transport treats as
 * "drop this beacon" (a PII gate must never emit an unredacted item). Returning null is
 * equally non-throwing for the app.
 *
 * BOTH `meta` and `payload` are run through `deepRedact`, so `meta.page.url` (url-key →
 * redactUrl + redactValue), `meta.page.attributes`, and `meta.session/view/browser/app`
 * attributes are all covered — only values matching email/token patterns are rewritten,
 * so session-id / user-agent / version pass through untouched. Structural OTLP ids in the
 * trace payload (traceId/spanId/parentSpanId) are passed through byte-identical (deepRedact
 * skips those keys) so the Alloy faro.receiver never 400-rejects a real trace beacon.
 *
 * Even so: do NOT populate identity meta without re-reviewing this scrub. `faro.api
 * .setUser()` (meta.user), or writing PII into `meta.session`/`meta.view` attributes,
 * would rely entirely on deepRedact's pattern match — set structured PII (raw userId,
 * username, email) only after adding explicit key-based redaction here.
 */
function scrubBeacon(item: TransportItem): TransportItem | null {
  try {
    return {
      ...item,
      meta: item.meta ? deepRedact(item.meta) : item.meta,
      payload: deepRedact(item.payload),
    } as TransportItem;
  } catch {
    // Fail CLOSED — drop the beacon rather than risk sending unredacted PII.
    return null;
  }
}

interface InitFaroOptions {
  /**
   * Whether THIS user is in the resource_timing cohort — the resolved value of the
   * `faro-resource-timing` Flipt flag (`features.faroResourceTiming`), threaded in from the
   * component so module-scope init never imports the hook. Combined (AND) with the build-arg
   * `NEXT_PUBLIC_FARO_RESOURCE_TIMING_ENABLED` to decide whether to attach
   * ResourceTimingInstrumentation. Read once at first-init (same model as the `features.faro`
   * gate on the whole SDK) — ramping the flag % takes effect on the next page load.
   */
  resourceTimingCohort: boolean;
  /**
   * Curated `exp_*` RUM-experiment session attributes (from `buildRumExperimentAttributes`),
   * resolved from the SSR-seeded feature flags in the component so module-scope init never
   * imports the flags hook. Set as `sessionTracking.session.attributes` so they ride on
   * `meta.session.attributes` of EVERY beacon (→ Loki `session_attr_exp_*`) from session
   * creation onward — before the first signal fires, so even LCP/CLS beacons carry them.
   * Values are boolean-coerced strings (`"true"`/`"false"`); no PII. See experimentFlags.ts.
   */
  experimentAttributes: Record<string, string>;
}

function initFaro({ resourceTimingCohort, experimentAttributes }: InitFaroOptions) {
  if (faroInitStarted) return;
  if (typeof window === 'undefined') return;
  if ((window as unknown as Record<string, unknown>)[WINDOW_GUARD_KEY]) return;
  const collectorUrl = env.NEXT_PUBLIC_FARO_COLLECTOR_URL;
  if (!collectorUrl) return;

  faroInitStarted = true;
  (window as unknown as Record<string, unknown>)[WINDOW_GUARD_KEY] = true;

  // Two independent sampling layers (see file header). Both are derived from
  // `resolveFaroSampling` — the SAME helper the decoupling unit test asserts on — so that
  // test is load-bearing on this production wiring, not a parallel path that can drift:
  //   - `sessionSamplingRate` (from NEXT_PUBLIC_FARO_SESSION_SAMPLE_RATE, default 1.0) gates
  //     ALL Faro signals — keep at 1.0 so errors + web-vitals + events + sessions stay 100%.
  //   - `traceSampler` (from NEXT_PUBLIC_FARO_TRACES_SAMPLE_RATE, default 0.1) gates ONLY OTel
  //     browser spans. It's the genuine per-trace sampler that replaces faro's default
  //     session-coupled one, so lowering trace volume never drops errors/web-vitals. Neither
  //     value is derived from the other.
  const { sessionSamplingRate, traceSampler } = resolveFaroSampling(
    env.NEXT_PUBLIC_FARO_SESSION_SAMPLE_RATE,
    env.NEXT_PUBLIC_FARO_TRACES_SAMPLE_RATE
  );

  const gitHash = env.NEXT_PUBLIC_GIT_HASH ? env.NEXT_PUBLIC_GIT_HASH.slice(0, 7) : undefined;
  const version = process.env.version ?? gitHash ?? 'unknown';

  initializeFaro({
    url: collectorUrl,
    app: {
      // Matches the existing dp-prod backend telemetry label (cluster label is
      // `service_name`), so browser RUM joins the backend series.
      name: 'civitai-dp-prod',
      version,
      ...(gitHash ? { environment: gitHash } : {}),
    },
    // Session sampling gates ALL signals in Faro; keep at 1.0 so errors + web-vitals +
    // events + sessions stay at 100%. Browser traces are sub-sampled SEPARATELY by the OTel
    // sampler on SampledTracingInstrumentation below — this rate does NOT gate them.
    //
    // `session.attributes` seeds the curated RUM-experiment flags (`exp_*`) onto the session
    // meta at session CREATION — the Faro session manager merges them with the generated
    // session id, so they ride on `meta.session.attributes` of every beacon (→ Loki
    // `session_attr_exp_*`) from the first signal onward. Only set when non-empty. See
    // experimentFlags.ts for the mechanism, the exact Loki field, the timing guarantee, and
    // the PII rationale (boolean values only).
    sessionTracking: {
      samplingRate: sessionSamplingRate,
      ...(Object.keys(experimentAttributes).length
        ? { session: { attributes: experimentAttributes } }
        : {}),
    },
    // Error-storm guard: drop known browser noise so a broken deploy can't turn every
    // session into a flood.
    ignoreErrors: [
      /^ResizeObserver loop (limit exceeded|completed with undelivered notifications)/,
      /^Script error\.?$/,
      /^Load failed$/,
      /chrome-extension:\/\//,
      /moz-extension:\/\//,
    ],
    // EXPLICIT allow-list — do NOT use getWebInstrumentations() (it always includes
    // UserAction + Performance + CSP + Console, which we exclude on privacy grounds —
    // see the file header). Session is required for sampling.
    instrumentations: [
      new ErrorsInstrumentation(),
      new WebVitalsInstrumentation(),
      new SessionInstrumentation(),
      new ViewInstrumentation(),
      new NavigationInstrumentation(),
      // Browser traces sampled at NEXT_PUBLIC_FARO_TRACES_SAMPLE_RATE via a genuine OTel
      // sampler on the tracer provider (NOT session-coupled) — see
      // SampledTracingInstrumentation. errors/web-vitals stay 100% (session sampling above).
      new SampledTracingInstrumentation({
        sampler: traceSampler,
        instrumentationOptions: {
          // `traceparent` is attached to all same-origin requests; this list ensures no
          // cross-origin (third-party) request — Stripe/Paddle/Meili/signals/Turnstile/GA
          // — ever receives it (which would trigger CORS preflights / breakage).
          propagateTraceHeaderCorsUrls: [sameOriginApiMatcher()],
        },
      }),
      // Resource Timing phase decomposition (DNS/TCP/TLS/TTFB/download) for same-origin
      // `/api` requests, emitted as custom measurements. This is NOT the stock
      // PerformanceInstrumentation (which stays excluded — it emits full URLs); it
      // normalizes every URL to a coarse route BEFORE emit and is volume-gated
      // independently of trace sampling. TWO gates (AND): the build-arg
      // NEXT_PUBLIC_FARO_RESOURCE_TIMING_ENABLED = compiled-in master enable/kill, and the
      // `faro-resource-timing` Flipt flag (resourceTimingCohort) = which % of users — so ops
      // ramps the cohort at runtime by bumping the flag %, no rebuild, mirroring how `faro`
      // ramped. The volume knobs (sample rate + per-client cap) are env-tunable, resolved here
      // with a safe fallback to the defaults (sample rate 0.05 keeps the shared faro-rum Loki
      // stream under its 10 MB/s ceiling at 100k concurrent). See ResourceTimingInstrumentation.
      ...buildResourceTimingInstrumentations({
        buildArgEnabled: env.NEXT_PUBLIC_FARO_RESOURCE_TIMING_ENABLED,
        cohortEnabled: resourceTimingCohort,
        sampleRateEnv: env.NEXT_PUBLIC_FARO_RESOURCE_TIMING_SAMPLE_RATE,
        maxPerWindowEnv: env.NEXT_PUBLIC_FARO_RESOURCE_TIMING_MAX_PER_WINDOW,
      }),
    ],
    // Defensive outer wrapper: scrubBeacon already fails closed, but guarantee that any
    // unexpected throw still drops the beacon (null) rather than emitting it unscrubbed.
    beforeSend: (item) => {
      try {
        return scrubBeacon(item);
      } catch {
        return null;
      }
    },
  });
}

export function FaroProvider() {
  const features = useFeatureFlags();
  const enabled = env.NEXT_PUBLIC_FARO_ENABLED && !!features.faro;

  useEffect(() => {
    try {
      if (enabled) {
        initFaro({
          resourceTimingCohort: !!features.faroResourceTiming,
          experimentAttributes: buildRumExperimentAttributes(features),
        });
        // If a prior transition paused an already-initialised instance, resume it.
        if (faroInitStarted) faro?.unpause?.();
      } else if (faroInitStarted) {
        // Best-effort kill-switch for an already-open tab. NOTE: the flag is SSR-seeded +
        // client-cached (React Query staleTime Infinity), so it rarely flips within an
        // open session — the real kill-switch is the next page load, or the
        // faro.civitai.com ingress (infra). This just stops beaconing sooner if it does.
        faro?.pause?.();
      }
    } catch {
      // Never let RUM bootstrap / teardown break the app.
    }
  }, [enabled]);

  return null;
}
