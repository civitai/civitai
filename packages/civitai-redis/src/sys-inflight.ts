/**
 * In-process count of in-flight SYS (sysRedis / Sentinel) redis commands.
 *
 * The exact mirror of ./cluster-inflight for the OTHER node-redis client. instrumentCommands
 * inc/decs this in lockstep with the `redis_commands_inflight{client="sys"}` gauge — the same
 * signal the gauge exposes, read locally (the prom-client Gauge doesn't cheaply surface its
 * value) so the sys self-heal watchdog can sample it without a prom dependency.
 *
 * WHY this exists (incident 2026-07-03): a sentinel flap ORPHANED in-flight commands on the
 * node-redis v5 RedisSentinel client — inflight climbed to 7,000–253,000 per pod on ~11 pods,
 * every request touching sysRedis (e.g. session-verifier isRevoked) hung, and the client DID
 * NOT self-heal (total inflight climbed 256k→324k until the pods were manually deleted). The
 * cluster client already had a self-heal for this identical inflight-leak class; the sentinel
 * client did not. This counter is what the mirrored sys watchdog samples.
 *
 * There can be MORE than one 'sys' base connection per process (the serving client + the
 * dedicated Buffer-mode connection on the sentinel path — see getClient), so this counter is
 * the AGGREGATE across all sys connections. That's correct: the gauge is the same aggregate,
 * and the sys self-heal reconnects ALL of them, so the counter must reflect all of them.
 *
 * EVERY mutation goes through these helpers so the counter has ONE invariant:
 *   it can never go negative.
 *
 * WHY the floor matters (same as cluster FIX #2): a forced self-heal reconnect calls the
 * sentinel client's `destroy()`, which flushes/rejects every in-flight command IMMEDIATELY.
 * Each rejected command then runs its `done()` closure → decSysInflight(). The per-closure
 * `dec` guard only stops a single closure double-decrementing; it does NOT stop N distinct
 * closures decrementing past 0. Without a global floor a heal that rejected N commands would
 * leave the counter at ≈ −N, so the watchdog would need inflight > threshold + N to ever
 * re-trigger and a SECOND wedge would go unhealed. Flooring every decrement at 0 keeps the
 * counter an accurate reflection of reality after a heal, so the watchdog can re-arm.
 *
 * Pure (no redis/prom imports) so it is unit-testable in isolation against the REAL counter
 * logic client.ts uses (not a stubbed constant).
 */

let sysInflight = 0;

/** Increment on command start. */
export function incSysInflight(): void {
  sysInflight++;
}

/**
 * Decrement on command settle, FLOORED at 0 so a post-heal burst of rejected commands can't
 * drive the counter negative. Returns the new value.
 */
export function decSysInflight(): number {
  sysInflight = Math.max(0, sysInflight - 1);
  return sysInflight;
}

/** Read the current count (the value the sys self-heal watchdog samples). */
export function getSysInflight(): number {
  return sysInflight;
}

/**
 * Reset to 0. Called by forceSysReconnect before it tears the client(s) down. With `destroy()`
 * immediately rejecting the in-flight commands, this is belt-and-suspenders: the floored
 * decrements from those rejections settle the counter to ~0 regardless. Kept so the watchdog's
 * sampled value snaps clean at the trigger instead of decaying over the next few ticks.
 */
export function resetSysInflight(): void {
  sysInflight = 0;
}
