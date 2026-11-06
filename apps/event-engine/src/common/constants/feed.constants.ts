/**
 * Feed constants for event-engine-common
 *
 * These constants are used by feed implementations and should match
 * the values used in the main Civitai application for consistency.
 */

import { NsfwLevel } from '../types/image-feed-types';

/**
 * NSFW levels that are considered restricted (R, X, XXX, Blocked).
 * Must match nsfwBrowsingLevelsArray in the main Civitai application.
 */
export const NSFW_RESTRICTED_LEVELS = [
  NsfwLevel.R,
  NsfwLevel.X,
  NsfwLevel.XXX,
  NsfwLevel.Blocked,
] as const;

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
  'Ideogram 4.0',
  'Ideogram 4.5',
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
