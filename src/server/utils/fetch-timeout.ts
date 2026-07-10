import { FLIPT_FEATURE_FLAGS, isFliptSync } from '~/server/flipt/client';

/**
 * Anti-hang fetch timeout, behind a default-ON kill-switch.
 * Returns AbortSignal.timeout(ms) UNLESS the hot-path-fetch-timeouts flag is
 * explicitly OFF. isFliptSync returns null when Flipt is uninitialized or the
 * flag is absent -> treat as ON (apply the timeout).
 */
export function fetchTimeoutSignal(ms: number): AbortSignal | undefined {
  if (isFliptSync(FLIPT_FEATURE_FLAGS.HOT_PATH_FETCH_TIMEOUTS) === false) return undefined;
  return AbortSignal.timeout(ms);
}
