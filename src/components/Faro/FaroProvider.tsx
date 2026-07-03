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
import { TracingInstrumentation } from '@grafana/faro-web-tracing';
import { env } from '~/env/client';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { deepRedact } from '~/utils/faro/redact';

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
 * errors, web-vitals, session (required for sampling), view, navigation, tracing.
 * DELIBERATELY EXCLUDED for privacy on this adult/payments platform: Performance
 * (emits full resource URLs), UserAction (captures element datasets), CSP, and Console
 * (serialises arbitrary logged objects). NO session replay.
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

function parseRate(value: string | undefined, fallback: number): number {
  const n = Number.parseFloat(value ?? '');
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

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
 * redactUrl+redactText), `meta.page.attributes`, and `meta.session/view/browser/app`
 * attributes are all covered — only values matching email/token patterns are rewritten,
 * so session-id / user-agent / version pass through untouched.
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

function initFaro() {
  if (faroInitStarted) return;
  if (typeof window === 'undefined') return;
  if ((window as unknown as Record<string, unknown>)[WINDOW_GUARD_KEY]) return;
  const collectorUrl = env.NEXT_PUBLIC_FARO_COLLECTOR_URL;
  if (!collectorUrl) return;

  faroInitStarted = true;
  (window as unknown as Record<string, unknown>)[WINDOW_GUARD_KEY] = true;

  const sessionSampleRate = parseRate(env.NEXT_PUBLIC_FARO_SESSION_SAMPLE_RATE, 1.0);
  // RESERVED: NEXT_PUBLIC_FARO_TRACES_SAMPLE_RATE is not wired in Phase 1 — browser
  // traces follow session sampling. Genuine per-trace sampling MUST be wired before
  // widening past the mod cohort (Faro couples per-trace sampling to session sampling,
  // and a non-sampled session drops ALL signals, so session sampling can't sub-sample
  // traces without also dropping errors/web-vitals). See PR #2929.

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
    // Session sampling gates ALL signals in Faro; keep at 1.0 so errors + web-vitals
    // stay at 100%. In Phase 1 browser traces follow this session sampling (no separate
    // per-trace sampler — see the RESERVED note above).
    sessionTracking: { samplingRate: sessionSampleRate },
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
      // Default TracingInstrumentation — traces follow session sampling in Phase 1.
      new TracingInstrumentation({
        instrumentationOptions: {
          // `traceparent` is attached to all same-origin requests; this list ensures no
          // cross-origin (third-party) request — Stripe/Paddle/Meili/signals/Turnstile/GA
          // — ever receives it (which would trigger CORS preflights / breakage).
          propagateTraceHeaderCorsUrls: [sameOriginApiMatcher()],
        },
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
        initFaro();
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
