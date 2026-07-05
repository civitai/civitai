/**
 * Privacy-safe Resource Timing decomposition for the Faro RUM pipeline.
 *
 * WHY THIS EXISTS: browser↔backend trace stitching proved ~83% of the ~275ms median
 * user-perceived `/api` latency is browser↔Cloudflare↔origin NETWORK time, not backend
 * (the handler is ~3.5%). That ~259ms "network" figure is a black box. This module reads
 * the browser's `PerformanceResourceTiming` entries for same-origin `/api` requests and
 * decomposes each into the standard phase durations (DNS / TCP-connect / TLS / TTFB /
 * download) so the RUM dashboards can split the network cost.
 *
 * 🔴 PRIVACY (this is an adult-content + payments platform at 100% RUM):
 *   - The stock Faro `PerformanceInstrumentation` is DELIBERATELY EXCLUDED (see
 *     FaroProvider header) because it emits FULL resource URLs. This module must never
 *     re-introduce that. For each entry we normalize the URL to a COARSE route
 *     (`/api/trpc`, `/api/v1`, `/api/auth`, …) — first two path segments only, no query
 *     string, no ids, no slugs — and emit that route as a low-cardinality label. The raw
 *     `PerformanceResourceTiming.name` (a full URL with query) NEVER enters the payload.
 *   - Scope is SAME-ORIGIN `/api` ONLY. Third-party resources (Stripe/Paddle/Meili/
 *     Turnstile/GA/CDN/images) are ignored — both a privacy risk (third-party URLs) and
 *     pure volume.
 *   - This normalization is done HERE, before emit — it does NOT rely on the downstream
 *     `deepRedact` scrub. Even if deepRedact changed, no raw URL is ever produced.
 *
 * Same-origin `/api` timings are always fully populated (a same-origin resource is exempt
 * from the Timing-Allow-Origin gate), so DNS/connect/TLS are real numbers, not zeros
 * masked by cross-origin opacity.
 *
 * Every function here is PURE and unit-tested (`__tests__/resourceTiming.test.ts`).
 */

/**
 * The subset of `PerformanceResourceTiming` fields we read. Declared structurally (not as
 * the DOM lib type) so the phase math can be unit-tested in a node env with plain objects.
 * All time fields are `DOMHighResTimeStamp` (ms, relative to time-origin).
 */
export interface ResourceTimingLike {
  name: string;
  initiatorType: string;
  nextHopProtocol?: string;
  duration: number;
  domainLookupStart: number;
  domainLookupEnd: number;
  connectStart: number;
  connectEnd: number;
  secureConnectionStart: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
}

/** Measurement `type` — stable, used as the Loki/dashboard selector. */
export const RESOURCE_TIMING_MEASUREMENT_TYPE = 'resource_timing';

/** Numeric value keys — stable + prefixed so a dashboard can `unwrap` them. */
export interface ResourceTimingValues {
  rt_dns: number;
  rt_connect: number;
  rt_tls: number;
  rt_ttfb: number;
  rt_download: number;
  rt_total: number;
  /** 1 when the connection was reused (keep-alive) or served from cache (connect phase 0). */
  rt_reused: number;
  [label: string]: number;
}

/** Low-cardinality context labels. NEVER a URL. */
export interface ResourceTimingContext extends Record<string, string> {
  route: string;
  protocol: string;
}

export interface ResourceTimingMeasurement {
  type: typeof RESOURCE_TIMING_MEASUREMENT_TYPE;
  values: ResourceTimingValues;
  context: ResourceTimingContext;
}

/** Only fetch/XHR resources (the `/api` traffic we care about); skip img/script/css/etc. */
const API_INITIATOR_TYPES = new Set(['fetch', 'xmlhttprequest']);

/** ALPN next-hop protocols we allow through as a label; anything else → `other`. */
const KNOWN_PROTOCOLS = new Set(['h3', 'h2', 'http/1.1', 'http/1.0', 'http/0.9', 'spdy/3.1']);

/**
 * Normalize an `/api` pathname to a coarse, low-cardinality route: the first TWO path
 * segments only (`/api/trpc`, `/api/v1`, `/api/auth`, `/api/webhooks`, …). Everything after
 * the second segment — ids, slugs, trpc procedure names — is dropped. Matches the RUM
 * dashboards' existing route normalization. Assumes `pathname` starts with `/api`.
 */
export function normalizeApiRoute(pathname: string): string {
  // Split, drop empty segments (leading slash / trailing slash / dup slashes).
  const segments = pathname.split('/').filter(Boolean);
  // segments[0] === 'api'. Keep at most the first two segments.
  return '/' + segments.slice(0, 2).join('/');
}

/** Constrain the next-hop protocol to a tiny known set so it stays low-cardinality. */
export function sanitizeProtocol(nextHopProtocol: string | undefined): string {
  if (!nextHopProtocol) return 'unknown';
  const lower = nextHopProtocol.toLowerCase();
  return KNOWN_PROTOCOLS.has(lower) ? lower : 'other';
}

/**
 * If `entry` is a same-origin `/api` fetch/XHR resource, return its coarse route; else null.
 * `origin` is `window.location.origin` (passed in so this is pure/testable).
 *
 * PRIVACY: the URL is parsed only to extract the origin (for the same-origin check) and the
 * pathname (for `normalizeApiRoute`). The full URL / query string is never returned.
 */
export function classifyApiEntry(entry: ResourceTimingLike, origin: string): string | null {
  if (!API_INITIATOR_TYPES.has(entry.initiatorType)) return null;
  let url: URL;
  try {
    // `entry.name` is an absolute URL for network resources; `origin` base is a no-op then,
    // and a safety net for any relative form.
    url = new URL(entry.name, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return null;
  return normalizeApiRoute(url.pathname);
}

/** Clamp a phase to a non-negative integer millisecond value (drops sub-ms jitter/noise). */
function phase(ms: number): number {
  return ms > 0 ? Math.round(ms) : 0;
}

/**
 * Decompose one resource entry into the standard timing phases. Each phase is guarded on its
 * own start marker being > 0 — a zero start marker means the phase did not occur / was not
 * measured (cache hit, keep-alive reuse, no-TLS), which must read as 0, not a bogus delta.
 *
 *   DNS       = domainLookupEnd  - domainLookupStart
 *   TCP conn  = connectEnd       - connectStart          (includes TLS)
 *   TLS       = connectEnd       - secureConnectionStart  (only when secureConnectionStart > 0)
 *   TTFB      = responseStart    - requestStart
 *   Download  = responseEnd      - responseStart
 *   Total     = duration
 *   Reused    = 1 when connectStart === 0 (connection reused / served from cache)
 */
export function computeResourcePhases(entry: ResourceTimingLike): ResourceTimingValues {
  const dns =
    entry.domainLookupStart > 0 && entry.domainLookupEnd > 0
      ? phase(entry.domainLookupEnd - entry.domainLookupStart)
      : 0;
  const connect =
    entry.connectStart > 0 && entry.connectEnd > 0
      ? phase(entry.connectEnd - entry.connectStart)
      : 0;
  const tls =
    entry.secureConnectionStart > 0 && entry.connectEnd > 0
      ? phase(entry.connectEnd - entry.secureConnectionStart)
      : 0;
  const ttfb =
    entry.requestStart > 0 && entry.responseStart > 0
      ? phase(entry.responseStart - entry.requestStart)
      : 0;
  const download =
    entry.responseStart > 0 && entry.responseEnd > 0
      ? phase(entry.responseEnd - entry.responseStart)
      : 0;
  const total = phase(entry.duration);
  // A reused connection (keep-alive) or cache hit skips DNS+connect: connectStart is 0.
  const reused = entry.connectStart > 0 ? 0 : 1;

  return {
    rt_dns: dns,
    rt_connect: connect,
    rt_tls: tls,
    rt_ttfb: ttfb,
    rt_download: download,
    rt_total: total,
    rt_reused: reused,
  };
}

/**
 * Build the privacy-safe measurement for one resource entry, or null if the entry is not a
 * same-origin `/api` fetch/XHR resource. The returned object is exactly what gets pushed:
 * numeric phase VALUES + a `{ route, protocol }` CONTEXT (both low-cardinality) — and NEVER
 * the URL or query string.
 */
export function buildResourceMeasurement(
  entry: ResourceTimingLike,
  origin: string
): ResourceTimingMeasurement | null {
  const route = classifyApiEntry(entry, origin);
  if (route === null) return null;
  return {
    type: RESOURCE_TIMING_MEASUREMENT_TYPE,
    values: computeResourcePhases(entry),
    context: { route, protocol: sanitizeProtocol(entry.nextHopProtocol) },
  };
}

export interface RateLimiterOptions {
  /** Max emissions allowed within one rolling window. */
  maxPerWindow: number;
  /** Rolling window length in ms. */
  windowMs: number;
  /** Per-candidate sampling fraction in [0, 1] applied BEFORE the window cap. */
  sampleRate: number;
  /** Injectable RNG (defaults to Math.random) — for deterministic tests. */
  random?: () => number;
  /** Injectable clock (defaults to Date.now) — for deterministic tests. */
  now?: () => number;
}

export interface RateLimiter {
  /** True if this candidate may be emitted (consumes a slot); false to drop it. */
  allow: () => boolean;
}

/**
 * Volume gate for resource-timing emissions. Resource Timing fires for EVERY subresource, so
 * emitting one beacon per `/api` resource unbounded would flood Loki/Tempo. This bounds the
 * per-client rate two ways: a sampling fraction (drops most candidates) AND a hard cap of
 * `maxPerWindow` emissions per rolling `windowMs` (bounds the worst case regardless of how
 * many `/api` calls a page fires). This is INDEPENDENT of trace/session sampling (the
 * decoupled-sampling design) — it gates only this measurement signal.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  let windowStart = now();
  let count = 0;

  return {
    allow(): boolean {
      // Sample first (cheap short-circuit that drops the majority of candidates).
      if (options.sampleRate < 1 && random() >= options.sampleRate) return false;
      const t = now();
      if (t - windowStart >= options.windowMs) {
        windowStart = t;
        count = 0;
      }
      if (count >= options.maxPerWindow) return false;
      count += 1;
      return true;
    },
  };
}

/**
 * Numeric defaults for the volume gate.
 *
 * WHY `sampleRate` IS 0.05 (NOT 0.25) — the 10 MB/s Loki per-stream ceiling:
 * All RUM signals land on a SINGLE Loki stream (`source="faro-rum"`) which is capped at
 * `per_stream_rate_limit` = 10 MB/s. At civitai's 100k-concurrent target a 0.25 sample rate
 * would push the aggregate resource-timing volume so the shared stream breaches ~10 MB/s near
 * ~84.5k sessions — and Loki sheds WHOLE BATCHES, dropping errors + web-vitals with it, not just
 * these measurements. At 0.05 the aggregate is ~1,000 beacons/s (~0.74 MB/s), keeping the
 * faro-rum stream ~8.9 MB/s — under the limit with headroom. It is deliberately conservative for
 * the ramp; dial it UP via env once the observed stream rate at a cohort confirms headroom.
 * `maxPerWindow`/`windowMs` are the pathological-single-client belt, not the aggregate control.
 */
export const RESOURCE_TIMING_DEFAULTS = {
  maxPerWindow: 8,
  windowMs: 15000,
  sampleRate: 0.05,
} as const;

/** Parse a sampling fraction env string to [0, 1], falling back on NaN/unset/invalid. */
export function parseSampleRate(raw: string | undefined, fallback: number): number {
  const n = Number.parseFloat(raw ?? '');
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** Parse a positive-integer cap env string, falling back on NaN/unset/invalid/`< 1`. */
export function parseMaxPerWindow(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

export interface ResourceTimingConfig {
  sampleRate: number;
  maxPerWindow: number;
}

/**
 * Resolve the deploy-tunable volume knobs from their env strings, each with a safe fallback to
 * `RESOURCE_TIMING_DEFAULTS` (mirroring how `resolveFaroSampling` guards the trace/session
 * rates). This makes the ramp dial-able (sample rate + per-client cap) WITHOUT a rebuild — an
 * invalid/NaN env can never zero the gate or crash init; it degrades to the default.
 */
export function resolveResourceTimingConfig(
  sampleRateRaw: string | undefined,
  maxPerWindowRaw: string | undefined
): ResourceTimingConfig {
  return {
    sampleRate: parseSampleRate(sampleRateRaw, RESOURCE_TIMING_DEFAULTS.sampleRate),
    maxPerWindow: parseMaxPerWindow(maxPerWindowRaw, RESOURCE_TIMING_DEFAULTS.maxPerWindow),
  };
}
