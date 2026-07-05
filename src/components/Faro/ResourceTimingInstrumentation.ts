import { BaseInstrumentation } from '@grafana/faro-web-sdk';
import {
  buildResourceMeasurement,
  createRateLimiter,
  type RateLimiter,
  RESOURCE_TIMING_DEFAULTS,
  type ResourceTimingLike,
} from '~/utils/faro/resourceTiming';

/**
 * Faro instrumentation that decomposes same-origin `/api` `PerformanceResourceTiming`
 * entries into phase durations (DNS / TCP-connect / TLS / TTFB / download) and emits them as
 * custom Faro measurements (`type: 'resource_timing'`). It un-black-boxes the ~259ms
 * "network" slice of user-perceived `/api` latency that trace stitching attributed to
 * browser↔Cloudflare↔origin rather than the backend handler.
 *
 * 🔴 PRIVACY: this is the ONLY resource-timing surface we allow — the stock Faro
 * `PerformanceInstrumentation` stays disabled because it emits full resource URLs. All URL
 * normalization + same-origin/`/api` filtering happens in `~/utils/faro/resourceTiming`
 * BEFORE emit; the payload carries only numeric phase values + a low-cardinality
 * `{ route, protocol }` context. No URL/query ever leaves the browser. See that module.
 *
 * VOLUME: Resource Timing fires for every subresource, so emissions are gated by a per-client
 * rate limiter (sampling fraction + hard cap per rolling window), INDEPENDENT of trace/session
 * sampling. Ships behind `NEXT_PUBLIC_FARO_RESOURCE_TIMING_ENABLED` (default OFF) so it can be
 * ramped separately from the main RUM flag.
 *
 * The default `sampleRate` is 0.05 (not 0.25) to keep the aggregate under Loki's 10 MB/s
 * per-stream ceiling on the shared `source="faro-rum"` stream at civitai's 100k-concurrent
 * target — see `RESOURCE_TIMING_DEFAULTS`. Both `sampleRate` and `maxPerWindow` are
 * DEPLOY-TUNABLE via env (`NEXT_PUBLIC_FARO_RESOURCE_TIMING_SAMPLE_RATE` /
 * `..._MAX_PER_WINDOW`, resolved in FaroProvider) so the ramp can be dialed without a rebuild;
 * the constructor options remain the override path that keeps this core unit-testable.
 */

export interface ResourceTimingInstrumentationOptions {
  /** Max emissions per rolling window (hard per-client cap). Default 8. */
  maxPerWindow?: number;
  /** Rolling window length in ms. Default 15000. */
  windowMs?: number;
  /** Per-candidate sampling fraction in [0, 1]. Default 0.05 (Loki per-stream ceiling). */
  sampleRate?: number;
  /** Injectable RNG — for tests. */
  random?: () => number;
  /** Injectable clock — for tests. */
  now?: () => number;
}

const DEFAULTS = RESOURCE_TIMING_DEFAULTS;

export class ResourceTimingInstrumentation extends BaseInstrumentation {
  readonly name = '@civitai/faro-instrumentation-resource-timing';
  readonly version = '1.0.0';

  private readonly options: ResourceTimingInstrumentationOptions;
  private observer: PerformanceObserver | undefined;
  private limiter: RateLimiter | undefined;
  private origin = '';

  constructor(options: ResourceTimingInstrumentationOptions = {}) {
    super();
    this.options = options;
  }

  initialize(): void {
    if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return;

    this.origin = window.location.origin;
    this.limiter = createRateLimiter({
      maxPerWindow: this.options.maxPerWindow ?? DEFAULTS.maxPerWindow,
      windowMs: this.options.windowMs ?? DEFAULTS.windowMs,
      sampleRate: this.options.sampleRate ?? DEFAULTS.sampleRate,
      random: this.options.random,
      now: this.options.now,
    });

    try {
      this.observer = new PerformanceObserver((list) => {
        this.handleEntries(list.getEntries() as unknown as ResourceTimingLike[]);
      });
      // `buffered: true` also drains resource entries recorded before the observer was wired
      // (the SDK boots after some initial `/api` calls have already fired).
      this.observer.observe({ type: 'resource', buffered: true });
    } catch {
      // PerformanceObserver unsupported / entryType rejected — degrade to no-op.
      this.observer = undefined;
    }
  }

  destroy(): void {
    try {
      this.observer?.disconnect();
    } catch {
      // ignore
    }
    this.observer = undefined;
  }

  private handleEntries(entries: ResourceTimingLike[]): void {
    if (!this.limiter) return;
    for (const entry of entries) {
      try {
        const measurement = buildResourceMeasurement(entry, this.origin);
        if (!measurement) continue; // not a same-origin /api fetch/xhr resource
        if (!this.limiter.allow()) continue; // volume gate
        this.api.pushMeasurement(
          { type: measurement.type, values: measurement.values },
          { context: measurement.context }
        );
      } catch {
        // Never let RUM instrumentation break the page.
      }
    }
  }
}
