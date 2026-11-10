import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import { createCachedFlagGate, readFliptSwitch } from '~/server/utils/otel-withspan-gate';

/**
 * The `ssr-client-only-sections` switch: whether a page's `getServerSideProps` asks its render to
 * leave the sections wrapped in `ClientOnlySection` to the client. One global boolean, read at most
 * once per 5s per process; unknown, uninitialised or throwing reads as off.
 */
const readSwitch = readFliptSwitch(() => FLIPT_FEATURE_FLAGS.SSR_CLIENT_ONLY_SECTIONS);

let gate = createCachedFlagGate(readSwitch);

export const ssrClientOnlySectionsOn = () => gate();

/** Tests only: forget the cached read so the next call re-reads Flipt. */
export function resetSsrClientOnlySectionsGateForTests() {
  gate = createCachedFlagGate(readSwitch);
}
