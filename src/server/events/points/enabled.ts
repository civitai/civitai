import {
  ensureFliptInitialized,
  FLIPT_FEATURE_FLAGS,
  isFlipt,
  isFliptSync,
} from '~/server/flipt/client';

// The event points engine's kill switch. Off unless the flag reads true: a missing flag, an
// unreachable Flipt and a client that has not initialised yet all read as off.
export async function isEventPointsEnabled() {
  return (await isFlipt(FLIPT_FEATURE_FLAGS.EVENT_POINTS_ENGINE)) === true;
}

// The same, synchronous for the impression hot path: an in-process evaluation, no network call.
export function isEventPointsEnabledSync() {
  const on = isFliptSync(FLIPT_FEATURE_FLAGS.EVENT_POINTS_ENGINE);
  if (on === null) void ensureFliptInitialized().catch(() => undefined);
  return on === true;
}
