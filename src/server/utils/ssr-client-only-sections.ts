import {
  ensureFliptInitialized,
  FLIPT_FEATURE_FLAGS,
  getFliptClientSync,
  isFliptSync,
} from '~/server/flipt/client';
import { createCachedFlagGate } from '~/server/utils/otel-withspan-gate';

/**
 * The `ssr-client-only-sections` switch: whether a page's `getServerSideProps` asks its render to
 * leave the sections wrapped in `ClientOnlySection` to the client. One global boolean, read at most
 * once per 5s per process; unknown, uninitialised or throwing reads as off.
 */
const readSwitch = () => {
  const on = isFliptSync(FLIPT_FEATURE_FLAGS.SSR_CLIENT_ONLY_SECTIONS);
  // `isFliptSync` answers null until the client is initialized; start it rather than wait for an
  // unrelated async flag read to do so.
  if (on === null && !getFliptClientSync()) void ensureFliptInitialized().catch(() => undefined);
  return on;
};

let gate = createCachedFlagGate(readSwitch);

export const ssrClientOnlySectionsOn = () => gate();

/** Tests only: forget the cached read so the next call re-reads Flipt. */
export function resetSsrClientOnlySectionsGateForTests() {
  gate = createCachedFlagGate(readSwitch);
}
