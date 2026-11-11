import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import { L1_CACHE_BYTE_BUDGETS, L1_SWITCHED_BYTE_BUDGETS } from '~/server/redis/l1-cache-budget';
import { createCachedFlagGate, readFliptSwitch } from '~/server/utils/otel-withspan-gate';

/**
 * Runtime switches for per-pod (L1) cache settings, each a `localTtl` function for
 * `createCachedObject` (see `localTtl` in @civitai/redis cached-array). Every switch is OFF unless
 * its Flipt flag says otherwise, and OFF is the cache's setting before the switch existed.
 *
 * Each flag is a global boolean read at most once per 5s per process (`createCachedFlagGate`), so a
 * flip reaches a pod within that window; the cache then empties its L1 on its next fetch. Every
 * read happens inside a gate, never at module load, and a gate reads a throw as off, so a test that
 * mocks the Flipt client without these exports reads every switch as off.
 */

const readBasicTagsLong = readFliptSwitch(() => FLIPT_FEATURE_FLAGS.BASIC_TAGS_L1_LONG_TTL);
const readCosmetics = readFliptSwitch(() => FLIPT_FEATURE_FLAGS.COSMETICS_L1);
const readTagIdsLarge = readFliptSwitch(() => FLIPT_FEATURE_FLAGS.TAG_IDS_FOR_IMAGES_L1_LARGE);

let basicTagsLongGate = createCachedFlagGate(readBasicTagsLong);
let cosmeticsGate = createCachedFlagGate(readCosmetics);
let tagIdsLargeGate = createCachedFlagGate(readTagIdsLarge);

/** Tests only: forget the cached flag reads so the next fetch re-reads Flipt. */
export function resetL1SwitchesForTests() {
  basicTagsLongGate = createCachedFlagGate(readBasicTagsLong);
  cosmeticsGate = createCachedFlagGate(readCosmetics);
  tagIdsLargeGate = createCachedFlagGate(readTagIdsLarge);
}

/** `basic-tags` L1 TTL in seconds: 30 (as before), or 300 with BASIC_TAGS_L1_LONG_TTL on. */
export const BASIC_TAGS_L1_TTL = 30;
export const BASIC_TAGS_L1_TTL_LONG = 300;
export const basicTagsLocalTtl = () =>
  basicTagsLongGate() ? BASIC_TAGS_L1_TTL_LONG : BASIC_TAGS_L1_TTL;

/** `cosmetics2` L1 TTL in seconds: none (as before), or 60 with COSMETICS_L1 on. */
export const COSMETICS_L1_TTL = 60;
export const cosmeticsLocalTtl = () => (cosmeticsGate() ? COSMETICS_L1_TTL : undefined);

/**
 * `tag-ids-for-images` L1 tiers. Off (as before): 180s, 50k entries, its base byte budget. On
 * (TAG_IDS_FOR_IMAGES_L1_LARGE): 600s, 200k entries, its switched byte budget. The switch changes the
 * caps as well as the TTL because a feed process can insert more distinct image ids per TTL window
 * than the base tier's entry cap holds: such a tier is capacity-bound, not TTL-bound (entries are
 * evicted before they expire), and a longer TTL alone would change little. A flip rebuilds the L1
 * empty at the other tier's caps (`localLimits`), so the larger one only exists while on.
 */
export const TAG_IDS_FOR_IMAGES_L1 = {
  ttl: 180,
  max: 50_000,
  maxBytes: L1_CACHE_BYTE_BUDGETS.tagIdsForImages,
} as const;
export const TAG_IDS_FOR_IMAGES_L1_LARGE = {
  ttl: 600,
  max: 200_000,
  maxBytes: L1_SWITCHED_BYTE_BUDGETS.tagIdsForImages,
} as const;
export const tagIdsForImagesLocalTtl = () =>
  tagIdsLargeGate() ? TAG_IDS_FOR_IMAGES_L1_LARGE.ttl : TAG_IDS_FOR_IMAGES_L1.ttl;
export const tagIdsForImagesLocalLimits = (ttlSeconds: number) => {
  const tier =
    ttlSeconds === TAG_IDS_FOR_IMAGES_L1_LARGE.ttl
      ? TAG_IDS_FOR_IMAGES_L1_LARGE
      : TAG_IDS_FOR_IMAGES_L1;
  return { max: tier.max, maxBytes: tier.maxBytes };
};
