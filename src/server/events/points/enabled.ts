import { ensureFliptInitialized, FLIPT_FEATURE_FLAGS, isFliptSync } from '~/server/flipt/client';

// How long one reading of the switch is reused. The Flipt client caches only evaluations that
// succeed, so with the flag missing every check would otherwise be an uncached evaluation that
// throws, on every impression entity and every action.
export const SWITCH_READ_MS = 5_000;

let reading: { on: boolean; at: number } | undefined;

// The event points engine's kill switch, synchronous for the impression hot path: an in-process
// evaluation at most every SWITCH_READ_MS. Off unless the flag reads true: a missing flag and a
// client that has not initialised yet read as off. A client that loses Flipt after initialising keeps
// answering from the last config it fetched.
export function isEventPointsEnabledSync() {
  const now = Date.now();
  if (reading && now - reading.at < SWITCH_READ_MS) return reading.on;
  const on = isFliptSync(FLIPT_FEATURE_FLAGS.EVENT_POINTS_ENGINE);
  if (on === null) void ensureFliptInitialized().catch(() => undefined);
  reading = { on: on === true, at: now };
  return reading.on;
}

// The same for callers that can wait for the client's first initialisation.
export async function isEventPointsEnabled() {
  if (!reading || Date.now() - reading.at >= SWITCH_READ_MS)
    await ensureFliptInitialized().catch(() => undefined);
  return isEventPointsEnabledSync();
}
