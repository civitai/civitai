import { FLIPT_FEATURE_FLAGS, isFliptSync } from '~/server/flipt/client';

/**
 * Anti-hang fetch timeout, behind a default-OFF Flipt flag.
 * Returns AbortSignal.timeout(ms) ONLY when the hot-path-fetch-timeouts flag is
 * explicitly ON. isFliptSync returns null when Flipt is uninitialized or the flag
 * is absent -> treated as OFF (no timeout). The feature ships dormant; flip the
 * flag ON to activate the timeouts. Absent-or-off both mean off, so there is no
 * ordering dependency on the flag existing and no delete footgun.
 */
export function fetchTimeoutSignal(ms: number): AbortSignal | undefined {
  if (isFliptSync(FLIPT_FEATURE_FLAGS.HOT_PATH_FETCH_TIMEOUTS) === true) return AbortSignal.timeout(ms);
  return undefined;
}
