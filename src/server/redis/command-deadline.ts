import { env } from '~/env/server';

/**
 * Bounded per-command wall-clock timeout for the CLUSTER (cache) redis client.
 *
 * WHY (civitai-dp-prod SSR pool): a small (~0.5%) minority of cluster commands NEVER
 * settle — the node-redis cluster `_execute` promise neither resolves nor rejects —
 * even though the cluster client's `socketTimeout` (REDIS_SOCKET_TIMEOUT_MS, ~10s)
 * should reject a stuck command. Each orphaned command (1) LEAKS the
 * redis_commands_inflight gauge (instrumentCommands inc's on entry; the matching dec
 * only fires when `_execute` settles) and (2) PARKS the request handler up to ~125s
 * until the client/CF tears the connection down → flat-125s 499s across normal SSR
 * routes. (Observed: SSR `client="cluster"` inflight climbed 104→32,331 over ~14h with
 * ~2,828 flat-125s 499s at peak; healthy pods show 0 hangs; it resets on pod restart.)
 *
 * INFERRED (not proven from node-redis source): cluster retry / topology-rediscovery
 * re-routes the command across reconnects so the outer `_execute` promise is orphaned.
 * This guard is mechanism-INDEPENDENT — whatever the internal cause, racing `_execute`
 * against a rejecting timer guarantees the wrapped promise settles within `ms`, which
 * makes instrumentCommands' `.finally(done)` fire (gauge dec'd) AND unparks the handler
 * with an error instead of a ~125s hang.
 *
 * SCOPE: cluster client ONLY. The SYSTEM (sysRedis) client is deliberately NOT wrapped
 * here — it is bounded separately by withSysReadDeadline / commandsQueueMaxLength, and a
 * blanket timeout on it caused the #2556/#2586 sys-client wedge. See client.ts.
 *
 * CONSUMER IMPACT: the reject is caught by the SAME fail-open paths that catch a cluster
 * read error — cache-helpers `fetchThroughCache` AND `createCachedArray`/`createCachedObject`
 * `.fetch` (the latter was made fail-open in the same change that added this consumer note;
 * before that its mGet/set/del had NO try/catch and a reject surfaced as a 500). Both now degrade
 * to an origin fetch → slow 200, NOT a hard 500. The cachedArray origin fetch is bounded
 * against a DB stampede by per-id single-flight (overlapping feed pages share per-id DB
 * results) — see cache-helpers.ts degradedIdInFlight. Strictly better than the 125s-then-499
 * it replaces.
 *
 * `ms` defaults to REDIS_CLUSTER_COMMAND_TIMEOUT_MS; pass an explicit value in tests.
 * `<= 0` disables the guard (returns the input unchanged — no wrapper, no timer).
 *
 * Mirrors withSysReadDeadline (sys-read-deadline.ts): the timer is always cleared in
 * finally() (within `ms`), and Promise.race reaps any late rejection from the orphaned
 * command so it never surfaces as an unhandledRejection.
 */
export function withCommandDeadline<T>(
  p: Promise<T>,
  ms: number = env.REDIS_CLUSTER_COMMAND_TIMEOUT_MS
): Promise<T> {
  if (!ms || ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`redis cluster command timed out after ${ms}ms`)),
      ms
    );
  });
  // Timer is always cleared in finally() (within `ms`), so no unref() is needed.
  return Promise.race([p, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
