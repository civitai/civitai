/**
 * In-process count of in-flight CLUSTER (cache) redis commands (FIX #1/#2 support).
 *
 * instrumentCommands inc/decs this in lockstep with the
 * `redis_commands_inflight{client="cluster"}` gauge — it is the same signal the gauge
 * exposes, read locally (the prom-client Gauge doesn't cheaply surface its value) so the
 * self-heal watchdog can sample it without a prom dependency. There is one cluster client
 * per process, so a module-scoped counter is correct.
 *
 * EVERY mutation goes through these helpers so the counter has ONE invariant:
 *   it can never go negative.
 *
 * WHY the floor matters (FIX #2): a forced self-heal reconnect calls the cluster client's
 * `destroy()`, which `flushAll(DisconnectsClientError)` — IMMEDIATELY rejecting every
 * in-flight command. Each of those rejected commands then runs its `done()` closure, which
 * decrements this counter. The per-closure `dec` guard only prevents a single closure from
 * decrementing twice; it does NOT stop N distinct closures from decrementing past 0. Without
 * a global floor, a heal that rejected N commands would leave the counter at ≈ −N, so the
 * watchdog would then need inflight > threshold + N to ever re-trigger and a SECOND wedge
 * would go unhealed. Flooring every decrement at 0 keeps the counter an accurate reflection
 * of reality after a heal, so the watchdog can re-arm. (This is why `reset()` is a
 * convenience, not a correctness requirement — the floored decrements settle to ~0 on their
 * own as the rejected commands drain.)
 *
 * Pure (no redis/prom imports) so it is unit-testable in isolation, and so the FIX #2
 * reset→decrement interaction can be exercised against the REAL counter logic client.ts uses
 * (not a stubbed constant).
 */

let clusterInflight = 0;

/** Increment on command start. */
export function incClusterInflight(): void {
  clusterInflight++;
}

/**
 * Decrement on command settle, FLOORED at 0 so a post-heal burst of rejected commands can't
 * drive the counter negative (FIX #2). Returns the new value.
 */
export function decClusterInflight(): number {
  clusterInflight = Math.max(0, clusterInflight - 1);
  return clusterInflight;
}

/** Read the current count (the value the self-heal watchdog samples). */
export function getClusterInflight(): number {
  return clusterInflight;
}

/**
 * Reset to 0. Called by forceClusterReconnect before it tears the client down. With
 * `destroy()` immediately rejecting the in-flight commands, this is belt-and-suspenders:
 * the floored decrements from those rejections settle the counter to ~0 regardless. Kept so
 * the watchdog's sampled value snaps clean at the trigger instead of decaying over the next
 * few ticks.
 */
export function resetClusterInflight(): void {
  clusterInflight = 0;
}
