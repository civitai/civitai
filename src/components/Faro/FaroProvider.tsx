import { useEffect } from 'react';
import {
  getWebInstrumentations,
  initializeFaro,
  type TransportItem,
} from '@grafana/faro-web-sdk';
import { TracingInstrumentation } from '@grafana/faro-web-tracing';
import { env } from '~/env/client';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { deepRedact, redactUrl } from '~/utils/faro/redact';
import { createRatioSampledSpanProcessor } from '~/components/Faro/faroTracing';

/**
 * Faro Real-User-Monitoring bootstrap (Phase 1 — SHIPPED DARK).
 *
 * Initialises the Grafana Faro Web SDK ONLY when all of the following hold:
 *   1. `NEXT_PUBLIC_FARO_ENABLED` build-arg is true, AND
 *   2. `NEXT_PUBLIC_FARO_COLLECTOR_URL` is set, AND
 *   3. the runtime `faro` feature flag is on (instant kill-switch, no rebuild).
 * If any is off it renders nothing and does nothing.
 *
 * Captures: errors + web-vitals (100%) and browser tracing (sampled). NO session
 * replay. Console capture is OFF (it serialises arbitrary logged objects). Every
 * outgoing beacon is run through the deterministic PII scrub (`beforeSend`).
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

/** Regex matching same-origin `/api` URLs, for trace-header propagation. */
function sameOriginApiMatcher(): RegExp {
  const origin = window.location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${origin}/api(/|$)`);
}

/**
 * Deterministic PII scrub applied to EVERY beacon before it leaves the browser.
 * Fail-open: never throws into the app (a scrub failure must not break the page),
 * but scrubs each surface independently so one failure can't skip the others.
 */
function scrubBeacon(item: TransportItem): TransportItem | null {
  try {
    const meta = item.meta;
    const page = meta?.page;
    const scrubbedMeta = page
      ? {
          ...meta,
          page: {
            ...page,
            ...(typeof page.url === 'string' ? { url: redactUrl(page.url) } : {}),
            ...(page.attributes ? { attributes: deepRedact(page.attributes) } : {}),
          },
        }
      : meta;
    return {
      ...item,
      meta: scrubbedMeta,
      payload: deepRedact(item.payload),
    } as TransportItem;
  } catch {
    return item;
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

  const tracesSampleRate = parseRate(env.NEXT_PUBLIC_FARO_TRACES_SAMPLE_RATE, 0.1);
  const sessionSampleRate = parseRate(env.NEXT_PUBLIC_FARO_SESSION_SAMPLE_RATE, 1.0);

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
    // stay at 100%. Browser-trace volume is controlled separately by the per-trace
    // ratio sampler below (see faroTracing.ts).
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
    instrumentations: [
      // errors + web-vitals + session (needed for sampling) + view. Console capture
      // OFF: it serialises arbitrary logged objects (PII risk) into logs.
      ...getWebInstrumentations({ captureConsole: false }),
      new TracingInstrumentation({
        instrumentationOptions: {
          // Attach `traceparent` ONLY to same-origin /api calls — never to third-party
          // fetches (Stripe/Paddle/Meili/signals/Turnstile/GA), which would trigger CORS
          // preflights / breakage.
          propagateTraceHeaderCorsUrls: [sameOriginApiMatcher()],
        },
        // Genuine per-trace ratio sampling on top of session sampling. Only installed
        // when < 1 so the default Faro pipeline is used at full sampling.
        ...(tracesSampleRate < 1
          ? { spanProcessor: createRatioSampledSpanProcessor(tracesSampleRate) }
          : {}),
      }),
    ],
    beforeSend: scrubBeacon,
  });
}

export function FaroProvider() {
  const features = useFeatureFlags();
  const enabled = env.NEXT_PUBLIC_FARO_ENABLED && !!features.faro;

  useEffect(() => {
    if (!enabled) return;
    try {
      initFaro();
    } catch {
      // Never let RUM bootstrap break the app.
    }
  }, [enabled]);

  return null;
}
