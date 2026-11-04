/**
 * Per-process log throttle for a condition that repeats on every run until a human acts (a
 * manual migration not applied yet): `shouldLog(key)` is true the first time for `key`, then at
 * most once per `everyMs`.
 */
export function createLogThrottle(everyMs: number) {
  const loggedAt = new Map<string, number>();
  return function shouldLog(key: string, now = Date.now()): boolean {
    const last = loggedAt.get(key);
    if (last !== undefined && now - last < everyMs) return false;
    loggedAt.set(key, now);
    return true;
  };
}
