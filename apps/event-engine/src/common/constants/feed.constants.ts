/**
 * Feed constants for event-engine-common
 *
 * These constants are used by feed implementations and should match
 * the values used in the main Civitai application for consistency.
 */

/**
 * NSFW levels that are considered restricted (R, X, XXX)
 * Values: 16 (R), 32 (X), 64 (XXX)
 */
export const NSFW_RESTRICTED_LEVELS = [16, 32, 64] as const;

/**
 * Base models that have NSFW licensing restrictions
 * These models cannot be used with certain NSFW content levels
 */
export const NSFW_RESTRICTED_BASE_MODELS = [
  'SDXL Turbo',
  'SVD',
  'SVD XT',
  'Stable Cascade',
  'SD 3',
  'SD 3.5',
  'SD 3.5 Medium',
  'SD 3.5 Large',
  'SD 3.5 Large Turbo',
] as const;

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
