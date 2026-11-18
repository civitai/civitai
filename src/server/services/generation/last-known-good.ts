/**
 * The last value one config read returned, kept per process, for reads that must not fail OPEN.
 *
 * The generation kill switch and the gate rules live in sysRedis. When a read fails, answering
 * with schema defaults ("enabled", "no rules") turns an operator's "generation disabled" or "model
 * hidden" back on for as long as the outage lasts. With this, a failed read answers with what the
 * last successful read in this process returned, and with `known: false` when there has been none,
 * so the caller can fail closed.
 *
 * No age bound, and that is a trade-off: a process cut off from sysRedis keeps answering with its
 * last value for as long as it stays cut off, and does not see a change an operator makes
 * meanwhile (the store may still be reachable from other processes, or come back with a new value).
 * The choice is between that stale value and fail-open defaults; the stale value is the safer one.
 */
export type LastKnownRead<T> =
  | { known: true; value: T; source: 'live' | 'last-known'; ageMs: number }
  | { known: false };

export function lastKnownGood<T>() {
  let last: { value: T; at: number } | undefined;
  return {
    /** Run `read`; on failure call `onError` and return the last good value, if any. */
    async read(
      read: () => Promise<T>,
      onError: (err: unknown, last: { ageMs: number } | undefined) => void
    ): Promise<LastKnownRead<T>> {
      try {
        const value = await read();
        last = { value, at: Date.now() };
        return { known: true, value, source: 'live', ageMs: 0 };
      } catch (err) {
        const ageMs = last ? Date.now() - last.at : undefined;
        onError(err, ageMs === undefined ? undefined : { ageMs });
        return last && ageMs !== undefined
          ? { known: true, value: last.value, source: 'last-known', ageMs }
          : { known: false };
      }
    },
    /** For tests: forget the last value. */
    reset() {
      last = undefined;
    },
  };
}
