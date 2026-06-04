import { FliptClient } from '@flipt-io/flipt-client-js';
import { env } from '~/env/server';
import { logToAxiom } from '../logging/client';

export enum FLIPT_FEATURE_FLAGS {
  FEED_IMAGE_EXISTENCE = 'feed-image-existence',
  ENTITY_METRIC_NO_CACHE_BUST = 'entity-metric-no-cache-bust',
  FEED_POST_FILTER = 'feed-fetch-filter-in-post',
  REDIS_CLUSTER_ENHANCED_FAILOVER = 'redis-cluster-enhanced-failover',

  GIFT_CARD_VENDOR_WAIFU_WAY = 'gift-card-vendor-waifu-way',
  GIFT_CARD_VENDOR_LEWT_DROP = 'gift-card-vendor-lewt-drop',
  GIFT_CARD_VENDOR_ROYAL_CD_KEYS = 'gift-card-vendor-royal-cd-keys',
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
  B2_IMAGE_UPLOAD = 'b2-image-upload',
  B2_TRAINING_UPLOAD = 'b2-training-upload',
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
  MEILI_CACHE_OPS = 'meili-cache-ops',
  MEILI_USER_OWN_PASS = 'meili-user-own-pass',
}

const FLIPT_INIT_TIMEOUT_MS = 5000;
const FLIPT_FAILURE_COOLDOWN_MS = 30_000;

// Per-request wasm `evaluateBoolean`/`evaluateVariant` calls showed up as a
// top-10 CPU frame under load (~1500 req/s on a single JS thread). The wasm
// engine result for a given (flag, entityId, context) is stable between config
// refreshes, and the client only pulls new config every `updateInterval` (60s).
// So a short in-process TTL cache cuts the wasm call rate hard while staying
// *fresher* than the underlying config cadence. Tune via FLIPT_EVAL_CACHE_TTL_MS
// (set to 0 to disable). Staleness is bounded by this TTL on top of the 60s
// config pull — acceptable even for incident kill-switch flags.
const FLIPT_EVAL_CACHE_TTL_MS = (() => {
  const parsed = parseInt(process.env.FLIPT_EVAL_CACHE_TTL_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10_000;
})();
// Bound memory: entityId can be per-user for some flags, so cap entries and
// drop the whole map on overflow (cheap; hot flags re-warm in one eval).
const FLIPT_EVAL_CACHE_MAX = 10_000;

type FliptCacheEntry<T> = { value: T; expiresAt: number };
const boolEvalCache = new Map<string, FliptCacheEntry<boolean>>();
const variantEvalCache = new Map<string, FliptCacheEntry<string | null>>();

function fliptCacheKey(flag: string, entityId: string, context: Record<string, string>): string {
  const keys = Object.keys(context);
  if (keys.length === 0) return `${flag}|${entityId}`;
  const ctx = keys
    .sort()
    .map((k) => `${k}=${context[k]}`)
    .join('&');
  return `${flag}|${entityId}|${ctx}`;
}

function fliptCacheGet<T>(
  cache: Map<string, FliptCacheEntry<T>>,
  key: string,
  now: number
): { hit: boolean; value?: T } {
  const entry = cache.get(key);
  if (entry) {
    if (entry.expiresAt > now) return { hit: true, value: entry.value };
    cache.delete(key);
  }
  return { hit: false };
}

function fliptCacheSet<T>(
  cache: Map<string, FliptCacheEntry<T>>,
  key: string,
  value: T,
  now: number
): void {
  if (FLIPT_EVAL_CACHE_TTL_MS === 0) return;
  if (cache.size >= FLIPT_EVAL_CACHE_MAX) cache.clear();
  cache.set(key, { value, expiresAt: now + FLIPT_EVAL_CACHE_TTL_MS });
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
  const now = Date.now();
  const key = fliptCacheKey(flag, entityId, context);
  const cached = fliptCacheGet(boolEvalCache, key, now);
  if (cached.hit) return cached.value as boolean;
  const evaluation = fliptClient.evaluateBoolean({ flagKey: flag, entityId, context });
  fliptCacheSet(boolEvalCache, key, evaluation.enabled, now);
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
  const now = Date.now();
  const key = fliptCacheKey(flag, entityId, context);
  const cached = fliptCacheGet(variantEvalCache, key, now);
  if (cached.hit) return cached.value as string | null;
  const evaluation = fliptClient.evaluateVariant({ flagKey: flag, entityId, context });
  const result = evaluation.match ? evaluation.variantKey : null;
  fliptCacheSet(variantEvalCache, key, result, now);
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

export default FliptSingleton;
