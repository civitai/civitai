/**
 * Bounded per-command wall-clock timeout for the CLUSTER (cache) redis client.
 *
 * A ~0.5% minority of node-redis cluster `_execute` promises NEVER settle — neither resolve
 * nor reject — even though the client's socketTimeout should reject a stuck command (inferred:
 * cluster retry / topology-rediscovery orphans the outer promise across reconnects). Each
 * orphaned command (1) LEAKS the redis_commands_inflight gauge (the matching dec only fires
 * when `_execute` settles) and (2) PARKS the request handler ~125s. Racing `_execute` against a
 * rejecting timer guarantees the wrapped promise settles within `ms`, so instrumentCommands'
 * `.finally(done)` fires (gauge dec'd) AND the handler unparks with an error the fail-open cache
 * readers degrade through.
 *
 * SCOPE: cluster client ONLY. The system (sysRedis) client is bounded separately (the app's
 * withSysReadDeadline + commandsQueueMaxLength); a blanket timeout on it caused the #2556/#2586
 * sys-client wedge.
 *
 * `ms <= 0` (or falsy) disables the guard — returns the input promise unchanged, no timer. The
 * timer is always cleared in finally() (within `ms`), and Promise.race reaps any late rejection
 * from the orphaned command so it never surfaces as an unhandledRejection.
 *
 * `onTimeout` (optional) is invoked exactly once iff the deadline fires (the command did NOT
 * settle in time). This is the SELF-HEAL TRIGGER SIGNAL: a healthy cluster client never hits the
 * deadline, a half-open one hits it constantly, and — unlike the inflight gauge — the
 * deadline-drain cannot erase this count (the drains ARE the hits). instrumentCommands wires it to
 * recordClusterDeadlineHit; tests inject a spy. It must never throw into the hot path, so it is
 * isolated in a try/catch.
 */
export function withCommandDeadline<T>(
  p: Promise<T>,
  ms: number,
  onTimeout?: () => void
): Promise<T> {
  if (!ms || ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) {
        try {
          onTimeout();
        } catch {
          // A broken hook (e.g. a throwing recorder) must never break the deadline guard.
        }
      }
      reject(new Error(`redis cluster command timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([p, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
