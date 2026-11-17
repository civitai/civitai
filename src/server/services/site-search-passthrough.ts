import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import { createCachedFlagGate, readFliptSwitch } from '~/server/utils/otel-withspan-gate';

/**
 * The `site-search-passthrough` switch for `/api/search/*`: a global boolean read at most once per
 * 5s per process. Off unless Flipt says on; an unknown flag, an uninitialised client and a throw
 * all read as off, which is the proxy's behaviour before the switch existed.
 */
const readPassthrough = readFliptSwitch(() => FLIPT_FEATURE_FLAGS.SITE_SEARCH_PASSTHROUGH);
let passthroughGate = createCachedFlagGate(readPassthrough);

export const isSiteSearchPassthroughOn = () => passthroughGate();

/** Tests only: forget the cached read so the next call re-reads Flipt. */
export function resetSiteSearchPassthroughForTests() {
  passthroughGate = createCachedFlagGate(readPassthrough);
}
