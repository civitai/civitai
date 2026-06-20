import { FliptClient } from '@flipt-io/flipt-client-js';
import { env } from '~/env/server';
import { logToAxiom } from '../logging/client';

export enum FLIPT_FEATURE_FLAGS {
  // Mirrors the `articleRatingDispute` fliptKey in feature-flags.service.ts so
  // background paths (no request context) can gate on the same Flipt flag the
  // tRPC `isFlagProtected('articleRatingDispute')` endpoints use.
  ARTICLE_RATING_DISPUTE = 'article-rating-dispute',
  FEED_IMAGE_EXISTENCE = 'feed-image-existence',
  ENTITY_METRIC_NO_CACHE_BUST = 'entity-metric-no-cache-bust',
  FEED_POST_FILTER = 'feed-fetch-filter-in-post',
  REDIS_CLUSTER_ENHANCED_FAILOVER = 'redis-cluster-enhanced-failover',

  GIFT_CARD_VENDOR_WAIFU_WAY = 'gift-card-vendor-waifu-way',
  GIFT_CARD_VENDOR_LEWT_DROP = 'gift-card-vendor-lewt-drop',
  GIFT_CARD_VENDOR_CRYPTO = 'gift-card-vendor-crypto',
  IMAGE_TRAINING = 'image-training',
  VIDEO_TRAINING = 'video-training',
  AI_TOOLKIT_SD15 = 'ai-toolkit-sd15',
  AI_TOOLKIT_SDXL = 'ai-toolkit-sdxl',
  AI_TOOLKIT_FLUX = 'ai-toolkit-flux',
  AI_TOOLKIT_SD35 = 'ai-toolkit-sd35',
  AI_TOOLKIT_HUNYUAN = 'ai-toolkit-hunyuan',
  AI_TOOLKIT_WAN = 'ai-toolkit-wan',
  AI_TOOLKIT_CHROMA = 'ai-toolkit-chroma',
  QWEN_TRAINING = 'qwen-training',
  FLUX2_TRAINING = 'flux2-training',
  ZIMAGE_TURBO_TRAINING = 'zimage-turbo-training',
  ZIMAGE_BASE_TRAINING = 'zimage-base-training',
  FLUX2_KLEIN_TRAINING = 'flux2-klein-training',
  LTX2_TRAINING = 'ltx2-training',
  LTX23_TRAINING = 'ltx23-training',
  WAN22_TRAINING = 'wan22-training',
  IMAGE_TRAINING_RESULTS = 'image-training-results',
  CHALLENGE_PLATFORM_ENABLED = 'challenge-platform-enabled',
  B2_UPLOAD_DEFAULT = 'b2-upload-default',
  COMIC_CREATOR = 'comic-creator',
  GENERATION_PRESETS = 'generation-presets',
  GENERATION_TESTING = 'generation-testing',
  AI_TOOLKIT_DEFAULT_SD = 'ai-toolkit-default-sd',
  WAN22_MULTI_STEP = 'wan22-multi-step',
  ENHANCED_COMPATIBILITY_SDCPP = 'enhanced-compatibility-sdcpp',
  IMAGE_INDEX_FEED = 'image-index-feed',
  BITDEX_IMAGE_SEARCH = 'bitdex-image-search',
  // Routes ImageResourceNew reads to the writer (primary) instead of the read
  // replica while the DataPacket replica is missing historical backfill rows
  // for imageId < ~110M. Flip off once backfill is complete.
  IMAGE_RESOURCE_USE_WRITE = 'image-resource-use-write',
  // Global kill-switch: when on, getDbWithoutLag routes every lag-aware read to
  // primary regardless of per-id Redis flags. Use during an elevated rep-lag
  // incident so RAW reads (e.g. reaction toggles) stay consistent without
  // paying the per-flag Redis write/read cost.
  HIGH_REPLICATION_LAG_MODE = 'high-replication-lag-mode',
  LICENSING_FEE = 'licensing-fee',
  WILDCARDS = 'wildcards',
}

const FLIPT_INIT_TIMEOUT_MS = 5000;
const FLIPT_FAILURE_COOLDOWN_MS = 30_000;

// Per-request wasm `evaluateBoolean`/`evaluateVariant` calls showed up as a
// top-10 CPU frame under load (~1500 req/s on a single JS thread). The wasm
// engine result for a given (flag, entityId, context) is stable between config
// refreshes, and the client only pulls new config every `updateInterval` (60s).
// A short in-process TTL cache collapses the wasm call rate.
//
// Staleness note: the TTL is ADDITIVE to the 60s config poll, not absorbed by
// it — worst-case propagation of a flipped flag is ~(60s + TTL) per pod, and
// pods converge independently. That's fine for gradual rollout flags; incident
// kill-switches that must take effect ASAP are listed in BYPASS below. Tune via
// FLIPT_EVAL_CACHE_TTL_MS (set to 0 to disable).
const FLIPT_EVAL_CACHE_TTL_MS = (() => {
  // parseInt is intentional (integer ms). Note a non-integer env like "0.5"
  // parses to 0 → cache disabled, and "1e4" parses to 1 — both surprising, so
  // the resolved value is logged below for operator visibility.
  const parsed = parseInt(process.env.FLIPT_EVAL_CACHE_TTL_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10_000;
})();
console.log(`[flipt] eval cache TTL: ${FLIPT_EVAL_CACHE_TTL_MS}ms (0 = disabled)`);
// Per-generation entry cap. entityId/context are per-user for some flags, so the
// keyspace is unbounded; we rotate generations at this size (see TtlCache).
// Steady-state live entries are bounded to ~2x this; a burst of distinct
// promoting reads with no intervening insert can transiently reach ~4x before
// the next insert rotates — still bounded, and entries are tiny.
const FLIPT_EVAL_CACHE_MAX = 10_000;

// Flags exempt from caching: incident kill-switches where an operator expects a
// flip to take effect ASAP and the eval is either rare (cold path) or the extra
// staleness is not worth the CPU saved.
// - REDIS_CLUSTER_ENHANCED_FAILOVER: evaluated only from Redis node-error/
//   disconnect handlers (near-zero call volume → no CPU benefit) but gates
//   failover during an incident, so caching it is all downside.
// - HIGH_REPLICATION_LAG_MODE: an operator flips this ON during an active
//   rep-lag incident to force RAW reads to primary; a ~70s (10s TTL + 60s poll)
//   propagation delay prolongs the stale-read window the flag exists to close.
//   It's only evaluated on the no-arg fallback path of getDbWithoutLag (RAW
//   reads without per-id flagging — db-lag-helpers.ts:42,94), not the hot
//   per-id path, so the CPU saved by caching it is modest. Correctness wins.
//
// NOT bypassed (deliberate): IMAGE_RESOURCE_USE_WRITE is also a global
// replica/primary read-routing switch, but its intended flip is OFF-once-
// backfill-complete — non-urgent and in the safe direction. It's evaluated on
// hot image read paths (image.service.ts) with a single global key, so caching
// gives the largest CPU win of any flag here; bypassing would re-add a
// per-request wasm eval on the hot path. If its propagation latency ever
// matters during an incident, lower FLIPT_EVAL_CACHE_TTL_MS globally rather
// than bypassing this one flag.
const FLIPT_EVAL_CACHE_BYPASS = new Set<string>([
  FLIPT_FEATURE_FLAGS.REDIS_CLUSTER_ENHANCED_FAILOVER,
  FLIPT_FEATURE_FLAGS.HIGH_REPLICATION_LAG_MODE,
]);

type FliptCacheEntry<T> = { value: T; expiresAt: number };

// TTL cache with generational rotation instead of full-clear eviction. On
// overflow the current generation becomes the "previous" one (the old previous
// is dropped) and a fresh generation starts, so hot keys survive at least one
// rotation and we never thrash to worse-than-no-cache under high key
// cardinality. Single-threaded, so Map ops need no locking.
class TtlCache<T> {
  private current = new Map<string, FliptCacheEntry<T>>();
  private previous = new Map<string, FliptCacheEntry<T>>();

  get(key: string, now: number): { hit: boolean; value?: T } {
    const cur = this.current.get(key);
    if (cur) {
      if (cur.expiresAt > now) return { hit: true, value: cur.value };
      this.current.delete(key);
    }
    const prev = this.previous.get(key);
    if (prev) {
      if (prev.expiresAt > now) {
        // Promote into the current generation so hot keys aren't lost on rotate.
        this.previous.delete(key);
        this.current.set(key, prev);
        return { hit: true, value: prev.value };
      }
      this.previous.delete(key);
    }
    return { hit: false };
  }

  set(key: string, value: T, now: number): void {
    if (FLIPT_EVAL_CACHE_TTL_MS === 0) return;
    if (this.current.size >= FLIPT_EVAL_CACHE_MAX) {
      this.previous = this.current;
      this.current = new Map();
    }
    this.current.set(key, { value, expiresAt: now + FLIPT_EVAL_CACHE_TTL_MS });
  }
}

const boolEvalCache = new TtlCache<boolean>();
const variantEvalCache = new TtlCache<string | null>();

// Build a collision-proof cache key. Components are URI-encoded so that a `|`,
// `&`, or `=` inside an entityId or context value can't alias another key (the
// context signature today is operator-controlled, but encoding makes the cache
// safe for any future caller passing free-form values).
function fliptCacheKey(flag: string, entityId: string, context: Record<string, string>): string {
  const keys = Object.keys(context);
  if (keys.length === 0) return `${flag}|${encodeURIComponent(entityId)}`;
  const ctx = keys
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(context[k])}`)
    .join('&');
  return `${flag}|${encodeURIComponent(entityId)}|${ctx}`;
}

// Evaluate a boolean flag against the wasm engine, memoized. Throws on engine
// error so callers keep their existing try/catch fallback; only successful
// evaluations are cached.
function evalBooleanCached(
  fliptClient: FliptClient,
  flag: string,
  entityId: string,
  context: Record<string, string>
): boolean {
  if (FLIPT_EVAL_CACHE_BYPASS.has(flag)) {
    return fliptClient.evaluateBoolean({ flagKey: flag, entityId, context }).enabled;
  }
  const now = Date.now();
  const key = fliptCacheKey(flag, entityId, context);
  const cached = boolEvalCache.get(key, now);
  if (cached.hit) return cached.value as boolean;
  const evaluation = fliptClient.evaluateBoolean({ flagKey: flag, entityId, context });
  boolEvalCache.set(key, evaluation.enabled, now);
  return evaluation.enabled;
}

// Evaluate a variant flag against the wasm engine, memoized. Caches the
// post-processed result (variantKey, or null when no match).
function evalVariantCached(
  fliptClient: FliptClient,
  flag: string,
  entityId: string,
  context: Record<string, string>
): string | null {
  if (FLIPT_EVAL_CACHE_BYPASS.has(flag)) {
    const evaluation = fliptClient.evaluateVariant({ flagKey: flag, entityId, context });
    return evaluation.match ? evaluation.variantKey : null;
  }
  const now = Date.now();
  const key = fliptCacheKey(flag, entityId, context);
  const cached = variantEvalCache.get(key, now);
  if (cached.hit) return cached.value as string | null;
  const evaluation = fliptClient.evaluateVariant({ flagKey: flag, entityId, context });
  const result = evaluation.match ? evaluation.variantKey : null;
  variantEvalCache.set(key, result, now);
  return result;
}

// Dev-only local overrides. Set FLIPT_LOCAL_OVERRIDES in .env to short-circuit
// flag evaluation without touching shared Flipt state (GitOps overwrites it).
// Format: comma-separated `flagKey=variantKey` pairs. Use `on`/`off` for booleans.
// Example: FLIPT_LOCAL_OVERRIDES=bitdex-image-search=primary,my-bool-flag=on
function parseLocalOverrides(): Record<string, string> {
  if (process.env.NODE_ENV === 'production') return {};
  const raw = process.env.FLIPT_LOCAL_OVERRIDES;
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split('=').map((s) => s.trim());
    if (k && v) out[k] = v;
  }
  return out;
}
const localOverrides = parseLocalOverrides();

class FliptSingleton {
  private static instance: FliptClient | null = null;
  private static initializing: Promise<FliptClient | null> | null = null;
  private static lastFailureTime = 0;

  private constructor() {
    // Prevent direct construction
  }

  static getInstanceSync(): FliptClient | null {
    return this.instance;
  }

  static async getInstance(): Promise<FliptClient | null> {
    if (this.instance) {
      return this.instance;
    }

    // Circuit breaker: skip re-init during cooldown after a failure
    if (Date.now() - this.lastFailureTime < FLIPT_FAILURE_COOLDOWN_MS) {
      return null;
    }

    if (this.initializing) {
      // If initialization is already in progress, wait for it
      return this.initializing;
    }

    this.initializing = (async () => {
      try {
        const internalAuthHeader = env.FLIPT_FETCHER_SECRET;

        const initPromise = (async () => {
          const fliptClient = await FliptClient.init({
            environment: 'civitai-app',
            url: env.FLIPT_URL,
            authentication: {
              clientToken: internalAuthHeader,
            },
            updateInterval: 60, // Fetch feature flag updates (default: 120 seconds)
          });
          await fliptClient.refresh();
          return fliptClient;
        })();

        // Attach a no-op catch to prevent unhandled rejection if timeout wins
        // but initPromise later rejects
        initPromise.catch(() => null);

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Flipt init timeout')), FLIPT_INIT_TIMEOUT_MS)
        );

        const fliptClient = await Promise.race([initPromise, timeoutPromise]);
        this.instance = fliptClient;
        return this.instance;
      } catch (e) {
        const err = e as Error;

        logToAxiom(
          {
            type: 'init-flipt-error',
            error: err.message,
            cause: err.cause,
            stack: err.stack,
          },
          'temp-search'
        ).catch();

        this.instance = null;
        this.lastFailureTime = Date.now();
        return null;
      } finally {
        this.initializing = null;
      }
    })();

    return this.initializing;
  }
}

export async function isFlipt(
  flag: string,
  entityId = 'global',
  context: Record<string, string> = {}
) {
  if (localOverrides[flag] !== undefined) return localOverrides[flag] === 'on';
  const fliptClient = await FliptSingleton.getInstance();
  if (!fliptClient) return false;

  try {
    return evalBooleanCached(fliptClient, flag, entityId, context);
  } catch (e) {
    console.error('Flipt evaluation error:', e);
    return false;
  }
}

export async function getFliptVariant(
  flag: string,
  entityId = 'global',
  context: Record<string, string> = {}
): Promise<string | null> {
  if (localOverrides[flag] !== undefined) return localOverrides[flag];
  const fliptClient = await FliptSingleton.getInstance();
  if (!fliptClient) return null;

  try {
    return evalVariantCached(fliptClient, flag, entityId, context);
  } catch (e) {
    console.error('Flipt variant evaluation error:', e);
    return null;
  }
}

export async function getFliptBoolean(
  flag: string,
  entityId = 'global',
  context: Record<string, string> = {}
): Promise<boolean> {
  const fliptClient = await FliptSingleton.getInstance();
  if (!fliptClient) return false;

  try {
    return evalBooleanCached(fliptClient, flag, entityId, context);
  } catch (e) {
    return false;
  }
}

/**
 * Synchronous Flipt evaluation. Returns `boolean` if Flipt is ready,
 * or `null` if the client hasn't initialized yet (caller should fall back).
 */
export function isFliptSync(
  flag: string,
  entityId = 'global',
  context: Record<string, string> = {}
): boolean | null {
  if (localOverrides[flag] !== undefined) return localOverrides[flag] === 'on';
  const fliptClient = FliptSingleton.getInstanceSync();
  if (!fliptClient) return null;

  try {
    return evalBooleanCached(fliptClient, flag, entityId, context);
  } catch (e) {
    // Swallow eval errors (incl. "flag not found"); caller falls back to null
    return null;
  }
}

export async function ensureFliptInitialized(): Promise<void> {
  await FliptSingleton.getInstance();
}

// Build the inner `(entityId, metricType, day, total)` subquery the direct CH
// read sites (search-index / comic populate / metric-helpers) sum over. `where`
// is the caller's full WHERE clause (e.g. "WHERE entityType = 'Image' AND ...").
// Reads the already-FINAL view `entityMetricDailyAgg_v2`, so we select total
// directly (no argMax dedup). Selecting metricType is harmless even for callers
// that only group by day (it's just carried through the subquery).
//
// (Historically this was flag-switchable via METRICS_AGG_V2_READ between the
// ReplacingMergeTree `entityMetricDailyAgg_new` — which needed argMax — and the
// v2 view; the v2 cutover is now permanent so the source is hardcoded.)
export function buildEntityMetricPerDaySource(where: string): string {
  return `(
      SELECT entityId, metricType, day, total
      FROM entityMetricDailyAgg_v2
      ${where}
    )`;
}

export default FliptSingleton;
