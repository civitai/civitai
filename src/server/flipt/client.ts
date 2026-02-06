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
  IMAGE_TRAINING = 'image-training',
  VIDEO_TRAINING = 'video-training',
  AI_TOOLKIT_TRAINING = 'ai-toolkit-training',
  QWEN_TRAINING = 'qwen-training',
  FLUX2_TRAINING = 'flux2-training',
  ZIMAGE_TURBO_TRAINING = 'zimage-turbo-training',
  ZIMAGE_BASE_TRAINING = 'zimage-base-training',
  FLUX2_KLEIN_TRAINING = 'flux2-klein-training',
  LTX2_TRAINING = 'ltx2-training',
  IMAGE_TRAINING_RESULTS = 'image-training-results',
}

class FliptSingleton {
  private static instance: FliptClient | null = null;
  private static initializing: Promise<FliptClient | null> | null = null;

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

    if (this.initializing) {
      // If initialization is already in progress, wait for it
      return this.initializing;
    }

    this.initializing = (async () => {
      try {
        const internalAuthHeader = env.FLIPT_FETCHER_SECRET;

        const fliptClient = await FliptClient.init({
          environment: 'civitai-app',
          url: env.FLIPT_URL,
          authentication: {
            clientToken: internalAuthHeader,
          },
          updateInterval: 60, // Fetch feature flag updates (default: 120 seconds)
        });

        await fliptClient.refresh();
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
  const fliptClient = await FliptSingleton.getInstance();
  if (!fliptClient) return false;

  try {
    const evaluation = fliptClient.evaluateBoolean({
      flagKey: flag,
      entityId,
      context,
    });

    return evaluation.enabled;
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
  const fliptClient = await FliptSingleton.getInstance();
  if (!fliptClient) return null;

  try {
    const evaluation = fliptClient.evaluateVariant({
      flagKey: flag,
      entityId,
      context,
    });

    return evaluation.variantKey;
  } catch (e) {
    console.error('Flipt variant evaluation error:', e);
    return null;
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
  const fliptClient = FliptSingleton.getInstanceSync();
  if (!fliptClient) return null;

  try {
    const evaluation = fliptClient.evaluateBoolean({
      flagKey: flag,
      entityId,
      context,
    });

    return evaluation.enabled;
  } catch (e) {
    // Flag may not exist in Flipt — return null so caller falls back
    return null;
  }
}

export async function ensureFliptInitialized(): Promise<void> {
  await FliptSingleton.getInstance();
}

// Eagerly start Flipt initialization when this module is first imported
FliptSingleton.getInstance()
  .then((client) => {
    console.log(`[Flipt] Eager init complete — client ${client ? 'READY' : 'UNAVAILABLE'}`);
  })
  .catch(() => {
    console.log('[Flipt] Eager init failed');
  });

export default FliptSingleton;
