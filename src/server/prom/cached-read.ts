/**
 * A value a scrape exports without waiting on the read behind it. `current()` returns the last value
 * `read` resolved to (null before the first), and starts at most one background refresh once that is
 * `ttlMs` old, so a saturated database pool cannot stall the scrape. A failed read keeps the
 * previous value. `refresh()` returns the in-flight read, for tests and callers that must wait.
 */
export function cachedRead<T>(
  read: () => Promise<T>,
  ttlMs = 60_000,
  now: () => number = Date.now
): { current: () => T | null; refresh: () => Promise<void> } {
  let value: T | null = null;
  let readAt = -Infinity;
  let inflight: Promise<void> | null = null;
  const refresh = () =>
    (inflight ??= read()
      .then(
        (v) => {
          value = v;
        },
        () => undefined
      )
      .finally(() => {
        readAt = now();
        inflight = null;
      }));
  return {
    refresh,
    current: () => {
      if (now() - readAt >= ttlMs) void refresh();
      return value;
    },
  };
}
