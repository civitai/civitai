/**
 * Feed constants for event-engine-common
 *
 * These constants are used by feed implementations and should match
 * the values used in the main Civitai application for consistency.
 */

/**
 * Redis key prefixes for feed operations
 * Must match REDIS_SYS_KEYS from src/server/redis/client.ts
 */
export const FEED_REDIS_KEYS = {
  CACHES: {
    IMAGE_EXISTS: 'system:image-exists',
  },
  QUEUES: {
    SEEN_IMAGES: 'queues:seen-images',
  },
} as const;
