import {
  ensureFliptInitialized,
  FLIPT_FEATURE_FLAGS,
  getFliptClientSync,
  isFliptSync,
} from '~/server/flipt/client';
import { createCachedFlagGate } from '~/server/utils/otel-withspan-gate';

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

type FlagKey = (typeof FLIPT_FEATURE_FLAGS)[keyof typeof FLIPT_FEATURE_FLAGS];

function readFlag(flag: () => FlagKey) {
  return () => {
    const on = isFliptSync(flag());
    // `isFliptSync` answers null until the client is initialized; start it rather than wait for an
    // unrelated async flag read to do so.
    if (on === null && !getFliptClientSync()) void ensureFliptInitialized().catch(() => undefined);
    return on;
  };
}

const readBasicTagsLong = readFlag(() => FLIPT_FEATURE_FLAGS.BASIC_TAGS_L1_LONG_TTL);

let basicTagsLongGate = createCachedFlagGate(readBasicTagsLong);

/** Tests only: forget the cached flag reads so the next fetch re-reads Flipt. */
export function resetL1SwitchesForTests() {
  basicTagsLongGate = createCachedFlagGate(readBasicTagsLong);
}

/** `basic-tags` L1 TTL in seconds: 30 (as before), or 300 with BASIC_TAGS_L1_LONG_TTL on. */
export const BASIC_TAGS_L1_TTL = 30;
export const BASIC_TAGS_L1_TTL_LONG = 300;
export const basicTagsLocalTtl = () =>
  basicTagsLongGate() ? BASIC_TAGS_L1_TTL_LONG : BASIC_TAGS_L1_TTL;
