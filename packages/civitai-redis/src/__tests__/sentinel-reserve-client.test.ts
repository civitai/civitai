import { createSentinel } from 'redis';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createSysRedis } from '../client';

/**
 * Regression guard for the node-redis Sentinel `reserveClient` sidestep.
 *
 * node-redis's Sentinel `_execute` (sentinel/index.js, ~L242-267) reference-counts a SHARED
 * master lease:
 *
 *     this.#masterClientInfo ??= await this.#internal.getClientLease();  // NOT atomic
 *     clientInfo = this.#masterClientInfo; this.#masterClientCount++;
 *     // finally: release iff clientInfo === this.#masterClientInfo && --count === 0
 *
 * `x ??= await f()` evaluates the nullish check BEFORE awaiting, so a COLD concurrent burst (when
 * `#masterClientInfo` is undefined — no master command in flight) lets multiple callers all pass
 * the check and each call `getClientLease()`. The extra leases get orphaned (the release guard's
 * `===` only ever matches the LAST writer's lease) and pin pool slots → with `masterPoolSize: 2`
 * the pool exhausts and any code needing a fresh master lease hangs (deadlock). This bug is present
 * and UNFIXED upstream through at least node-redis 6.1.0 (verified byte-identical in 5.8.3 /
 * 5.12.1 / 6.1.0) — it is version-independent.
 *
 * The sidestep: `reserveClient: true` pins ONE master lease at `connect()` (`#reservedClientInfo`)
 * and routes every master command through it, fully bypassing the racy `??=` block (sentinel
 * `_execute` short-circuits to the reserved client and never enters the shared-lease path). The
 * reserved lease is just an integer index into the master pool, which `transform()` rebuilds
 * IN PLACE (same ids) on a `switch-master`, so it repoints to the new master on failover — no
 * failover regression — and it adds ZERO connections (the pool opens `masterPoolSize` master
 * connections either way; the reserved client is one of them, pinned rather than acquired/released
 * per burst).
 *
 * These tests guard the `client.ts` config so a future edit that flips `reserveClient` back to
 * `false` (re-arming the cold-burst lease-leak) is caught in CI, without a live Sentinel.
 */

// Wrap the real `redis` module so `createSentinel` is captured (to inspect the options the factory
// passes) AND neutralized (no `.connect()` → no TCP sockets / reconnect timers → no open handles).
// Everything else stays REAL so `getClient`'s downstream wiring (event listeners, withTypeMapping,
// instrumentation) runs exactly as in prod.
const sentinelOptsCapture: Array<Record<string, unknown>> = [];

vi.mock('redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('redis')>();
  const noConnect = <T>(client: T): T => {
    (client as { connect: () => Promise<T> }).connect = () => Promise.resolve(client);
    return client;
  };
  return {
    ...actual,
    createSentinel: (opts: Parameters<typeof actual.createSentinel>[0]) => {
      sentinelOptsCapture.push(opts as unknown as Record<string, unknown>);
      return noConnect(actual.createSentinel(opts));
    },
    createClient: (opts: Parameters<typeof actual.createClient>[0]) =>
      noConnect(actual.createClient(opts)),
  };
});

describe('sysRedis Sentinel — reserveClient lease-leak sidestep', () => {
  beforeAll(() => {
    // loadRedisEnv() validates process.env (REDIS_URL / REDIS_SYS_URL are required z.url()).
    process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
    process.env.REDIS_SYS_URL ??= 'redis://127.0.0.1:6379';
  });

  it('constructs the Sentinel client(s) with reserveClient: true (bypasses the ??= cold-burst leak)', () => {
    sentinelOptsCapture.length = 0;

    createSysRedis({
      sysSentinels: '127.0.0.1:26379',
      sysSentinelName: 'sysmaster',
      log: () => undefined,
    });

    // The Sentinel path builds TWO base clients: the serving client and the dedicated `.packed`
    // buffer base (the withTypeMapping-poisoning fix). BOTH go through the same createSentinel
    // block, so EVERY Sentinel client must carry the reserveClient sidestep.
    expect(sentinelOptsCapture.length).toBeGreaterThanOrEqual(1);
    for (const opts of sentinelOptsCapture) {
      expect(opts.reserveClient).toBe(true);
      // Guard the pool geometry the deadlock analysis depends on: masterPoolSize 2 (heartbeat on a
      // separate TCP from in-flight writes), no replica pool. reserveClient pins one of these two
      // master connections — it does NOT add a third.
      expect(opts.masterPoolSize).toBe(2);
      expect(opts.replicaPoolSize).toBe(0);
    }
  });

  it('does NOT set reserveClient on the single-node (dev, no-Sentinel) path', () => {
    // No sysSentinels → getBaseClient uses createClient (single-node), which has no lease pool and
    // no reserveClient concept. Documents that the sidestep is scoped to the Sentinel path.
    sentinelOptsCapture.length = 0;

    const sysRedis = createSysRedis({ log: () => undefined });
    expect(sysRedis).toBeDefined();
    expect(sentinelOptsCapture.length).toBe(0);
  });
});
