import { chunk } from 'lodash-es';
import { pack, unpack } from 'msgpackr';
import type { RedisClientType, SetOptions } from 'redis';
import { createClient, createCluster, createSentinel } from 'redis';
import { RESP_TYPES } from 'redis';
import slugify from 'slugify';
import { loadRedisEnv, type RedisConfig } from './env';
import { withCommandDeadline } from './deadline';
import { withClusterRoutingRetry } from './cluster-routing-retry';
import { ClusterSelfHealWatchdog } from './cluster-selfheal';
import type { ClusterSelfHealTrigger } from './cluster-selfheal';
import {
  decClusterInflight,
  getClusterInflight,
  incClusterInflight,
  resetClusterInflight,
} from './cluster-inflight';
import { decSysInflight, getSysInflight, incSysInflight, resetSysInflight } from './sys-inflight';
import {
  countClusterDeadlineHits,
  recordClusterCommandSettle,
  resetClusterDeadlineHits,
} from './cluster-deadline-hits';
import { compressPacked, decompressPacked } from './packed-compression';

export type { RedisConfig } from './env';
export type RedisLogFn = (message: string, ...args: unknown[]) => void;
/** Resolves whether enhanced cluster failover is enabled — injected app policy (Flipt). */
export type RedisFailoverResolver = (context: Record<string, string>) => Promise<boolean>;

// inlined — was slugit from ~/utils/string-helpers
const slugit = (value: string) => slugify(value, { lower: true, strict: true });

// Local definition so the package is self-contained (was relying on a global `Values` type from
// the main app's tsconfig, which broke when typechecked from another app). Recursive: extracts
// the leaf string values from the nested REDIS_KEYS / REDIS_SYS_KEYS objects.
type Values<T> = T extends string | number | boolean
  ? T
  : T extends object
  ? { [K in keyof T]: Values<T[K]> }[keyof T]
  : never;

export type RedisKeyStringsCache = Values<typeof REDIS_KEYS>;
export type RedisKeyStringsSys = Values<typeof REDIS_SYS_KEYS>;

export type RedisKeyTemplateCache = `${RedisKeyStringsCache}${'' | `:${string}`}`;
export type RedisKeyTemplateSys = `${RedisKeyStringsSys}${'' | `:${string}`}`;
export type RedisKeyTemplates = RedisKeyTemplateCache | RedisKeyTemplateSys;

// @redis/client/dist/lib
type RedisCommandArgument = string | Buffer;
interface QueueCommandOptions {
  asap?: boolean;
  chainId?: symbol;
  signal?: AbortSignal;
  returnBuffers?: boolean;
}
interface ClientCommandOptions extends QueueCommandOptions {
  isolated?: boolean;
}
// declare const symbol: unique symbol;
// type CommandOptions<T> = T & {
//   readonly [symbol]: true;
// };
// type CommandType = CommandOptions<ClientCommandOptions>;
type CommandType = ClientCommandOptions;

interface CustomRedisClient<K extends RedisKeyTemplates>
  extends Omit<
    RedisClientType,
    | 'set'
    | 'get'
    | 'mGet'
    | 'mSet'
    | 'setNX'
    | 'sAdd'
    | 'sRem'
    | 'sPop'
    | 'sMembers'
    | 'hGet'
    | 'hGetAll'
    | 'hSet'
    | 'hmGet'
    | 'del'
    | 'unlink'
    | 'exists'
    | 'expire'
    | 'expireAt'
    | 'hDel'
    | 'hExists'
    | 'hExpire'
    | 'hIncrBy'
    | 'hSetNX'
    | 'incrBy'
    | 'lLen'
    | 'lPopCount'
    | 'lPush'
    | 'lRange'
    | 'memoryUsage'
    | 'ttl'
    | 'type'
    | 'sCard'
  > {
  // Cluster doesn't have scanIterator natively, we implement it manually
  scanIterator(options?: {
    TYPE?: string;
    MATCH?: string;
    COUNT?: number;
    cursor?: string;
  }): AsyncGenerator<string[], void, unknown>;
  packed: {
    // `packedOptions.compress` opts the READ into the compress-aware decode path
    // (sentinel-detect + brotli-decompress), SYMMETRIC with set's compress. Only enable
    // for keys written with compress — see the SENTINEL SCOPE note in packed-compression.
    get<T>(key: K, packedOptions?: { compress?: boolean }): Promise<T | null>;
    // Wrapped to avoid CROSSSLOT errors - fetches keys individually with Promise.all
    mGet<T>(keys: K[]): Promise<(T | null)[]>;
    // `packedOptions.compress` opts the value into brotli compression at rest (sentinel-
    // tagged; reads decode both compressed and legacy-uncompressed values transparently).
    // Only safe for callers that store wrapper objects, never bare scalars — see the
    // SENTINEL SAFETY note in the packed implementation.
    set<T>(
      key: K,
      value: T,
      setOptions?: SetOptions,
      packedOptions?: { compress?: boolean }
    ): Promise<void>;
    // mSet still disabled - sets are more complex with different argument formats
    // mSet(records: Record<K, unknown>, setOptions?: SetOptions): Promise<void>;
    setNX<T>(key: K, value: T): Promise<void>;
    sAdd<T>(key: K, values: T[]): Promise<void>;
    sRemove<T>(key: K, value: T): Promise<void>;
    sPop<T>(key: K, count: number): Promise<T[]>;
    sMembers<T>(key: K): Promise<T[]>;
    hGet<T>(key: K, hashKey: string): Promise<T | null>;
    hGetAll<T>(key: K): Promise<{ [x: string]: T }>;
    hSet<T>(key: K, hashKey: string, value: T): Promise<void>;
    hmSet<T>(key: K, records: Record<string, T>): Promise<void>;
    hmGet<T>(key: K, hashKeys: string[]): Promise<(T | null)[]>;
  };
  // nb - some of these take various argument option types (like CommandType) that may need to be adjusted if we need them
  set<T = string>(
    ...args:
      | [key: K, value: T, setOptions?: SetOptions]
      | [options: CommandType, key: K, value: T, setOptions?: SetOptions]
  ): Promise<T | null>;
  get<T = string>(...args: [key: K] | [options: CommandType, key: K]): Promise<T | null>;
  // Wrapped to avoid CROSSSLOT errors - fetches keys individually with Promise.all
  mGet<T = string>(...args: [keys: K[]] | [options: CommandType, keys: K[]]): Promise<(T | null)[]>;
  // mSet<T = string>(
  //   ...args:
  //     | [records: [K, RedisCommandArgument][] | K[] | Record<K, RedisCommandArgument>]
  //     | [
  //         options: CommandType,
  //         records: [K, RedisCommandArgument][] | K[] | Record<K, RedisCommandArgument>
  //       ]
  // ): Promise<T>;
  setNX<T>(key: K, value: T): Promise<boolean>;
  sAdd<T>(key: K, values: T | T[]): Promise<number>;
  sRem<T>(key: K, values: T | T[]): Promise<number>;
  sPop<T = string>(
    ...args: [key: K, count: number] | [options: CommandType, key: K, count: number]
  ): Promise<T[]>;
  sMembers<T = string>(...args: [key: K] | [options: CommandType, key: K]): Promise<T[]>;
  hGet<T = string>(
    ...args:
      | [key: K, hashKey: RedisCommandArgument]
      | [options: CommandType, key: K, hashKey: RedisCommandArgument]
  ): Promise<T | null>;
  hGetAll<T = string>(
    ...args: [key: K] | [options: CommandType, key: K]
  ): Promise<{ [x: string]: T }>;
  hSet<T>(
    ...args:
      | [key: K, hashKey: RedisCommandArgument, value: T]
      | [key: K, value: T]
      | [options: CommandType, key: K, hashKey: RedisCommandArgument, value: T]
      | [options: CommandType, key: K, value: T]
  ): Promise<number>;
  hmGet<T = string>(
    ...args:
      | [key: K, hashKeys: RedisCommandArgument | RedisCommandArgument[]]
      | [options: CommandType, key: K, hashKeys: RedisCommandArgument | RedisCommandArgument[]]
  ): Promise<T[]>;
  // Wrapped to avoid CROSSSLOT errors - deletes keys individually with Promise.all when array
  del(key: K | K[]): Promise<number>;
  // Wrapped to avoid CROSSSLOT errors - unlinks keys individually with Promise.all when array.
  // Prefer over del for large keys (sets/hashes) — UNLINK frees memory in a background thread.
  unlink(key: K | K[]): Promise<number>;
  exists(key: K | K[]): Promise<number>;
  expire(key: K, seconds: number, mode?: 'NX' | 'XX' | 'GT' | 'LT'): Promise<boolean>;
  expireAt(key: K, timestamp: number | Date, mode?: 'NX' | 'XX' | 'GT' | 'LT'): Promise<boolean>;
  hDel(key: K, hashKey: RedisCommandArgument | RedisCommandArgument[]): Promise<number>;
  hExists(key: K, hashKey: RedisCommandArgument): Promise<boolean>;
  hExpire(
    key: K,
    fields: RedisCommandArgument | RedisCommandArgument[],
    seconds: number,
    mode?: 'NX' | 'XX' | 'GT' | 'LT'
  ): ReturnType<RedisClientType['hExpire']>;
  hIncrBy(key: K, hashKey: RedisCommandArgument, increment: number): Promise<number>;
  hSetNX(key: K, hashKey: RedisCommandArgument, value: RedisCommandArgument): Promise<boolean>;
  incrBy(key: K, increment: number): Promise<number>;
  lLen(key: K): Promise<number>;
  lPopCount<T = string>(key: K, count: number): Promise<T[] | null>;
  lPush(key: K, values: RedisCommandArgument | RedisCommandArgument[]): Promise<number>;
  lRange<T = string>(key: K, start: number, stop: number): Promise<T[]>;
  memoryUsage(key: K, options?: { SAMPLES?: number }): Promise<number | null>;
  sCard(key: K): Promise<number>;
  ttl(key: K): Promise<number>;
  type(key: K): Promise<string>;
  setNxKeepTtlWithEx(key: K, value: string, ttl: number): Promise<boolean>;
  /**
   * ATOMICALLY set one-or-more hash fields AND (re)apply a whole-key TTL in a single round-trip
   * Lua EVAL — so a process death between the HSET and the EXPIRE can never leave a TTL-less key
   * (the `HSET` + `EXPIRE` either both run or neither does). `fields` is an even-length
   * [field, value, field, value, …] array (the order HSET takes). No-op (returns 0) if `fields`
   * is empty. Returns the number of fields HSET reports as NEWLY added (HSET's own return). */
  hSetMultiWithExpire(key: K, fields: string[], ttlSeconds: number): Promise<number>;
  withTypeMapping(mapping: Record<number, any>): any;
}

interface CustomRedisClientCache extends CustomRedisClient<RedisKeyTemplateCache> {
  purgeTags: (tag: string | string[]) => Promise<void>;
}
// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface CustomRedisClientSys extends CustomRedisClient<RedisKeyTemplateSys> {}

// Configured by createRedisClients() before any client is built. The internal helpers
// (getBaseClient/getClient/getCacheClient/getSysClient) are not exported, so they only
// ever run *after* the factory has assigned `config` — the placeholder is never read.
// Env is loaded lazily inside the factory (loadRedisEnv()), so importing this module
// never touches process.env. (HMR/global caching lives in the app shim.)
let config: RedisConfig = undefined as unknown as RedisConfig;
let log: RedisLogFn = () => {};
let isEnhancedFailoverEnabled: RedisFailoverResolver = async () => false;

// Track topology refresh intervals for cleanup
const clusterRefreshIntervals = new Map<string, ReturnType<typeof setInterval>>();

// In-process counts of in-flight commands live in `./cluster-inflight` (CLUSTER) and
// `./sys-inflight` (SYS) so EVERY mutation goes through a single floored helper (the counter
// can never go negative). instrumentCommands inc/decs each in lockstep with the matching
// redis_commands_inflight{client=...} gauge — the same signal the gauge exposes, read locally
// (the prom-client Gauge doesn't cheaply surface its value) so each client's self-heal watchdog
// can sample it without a prom dependency. Both the cluster client AND the sysRedis Sentinel
// client now have a self-heal watchdog (the latter added after the 2026-07-03 sentinel-flap
// inflight-leak incident).

/**
 * Trigger topology rediscovery on a cluster client.
 * Uses internal _slots.rediscover() method - this is undocumented but stable.
 * See: https://github.com/redis/node-redis/issues/2806
 *
 * FIRE-AND-FORGET: this kicks off `_slots.rediscover(...).catch(...)` but RETURNS `undefined` (it
 * does NOT return/await the rediscover promise). So a caller that `await`s it (the routing-retry
 * guard's `rediscover` hook) resolves immediately — the rediscover runs in the background and the
 * guard's BACKOFF is what gives the in-flight, single-flighted slot-map refresh time to settle
 * before the retry. Intentional: node-redis single-flights rediscover, so a best-effort nudge +
 * backoff is the right shape; returning the promise here would change the retry timing/blast radius.
 */
function triggerTopologyRediscovery(clusterClient: any, reason: string) {
  try {
    if (!clusterClient._slots?.rediscover) {
      return;
    }

    log(`Triggering topology rediscovery: ${reason}`);

    // rediscover() requires a client instance with .options property
    // Try to get a master client from the cluster to pass to rediscover
    const masters = clusterClient._slots.masters;
    if (masters && masters.length > 0) {
      // Use the first available master client
      const masterClient = masters[0]?.client;
      if (masterClient) {
        clusterClient._slots.rediscover(masterClient).catch((err: Error) => {
          log(`Topology rediscovery failed: ${err.message}`);
        });
        return;
      }
    }

    // Fallback: try calling without argument (may fail but worth trying)
    clusterClient._slots.rediscover().catch((err: Error) => {
      log(`Topology rediscovery failed (no master client): ${err.message}`);
    });
  } catch (err) {
    // Silently ignore if rediscover is not available
    log(`Topology rediscovery error: ${err instanceof Error ? err.message : err}`);
  }
}

// Hold the watchdog interval so it can be cleared on client close (mirrors
// clusterRefreshIntervals). Module-scoped: one cluster client per process.
let clusterSelfHealInterval: ReturnType<typeof setInterval> | undefined;

// Same, for the sys (sysRedis / Sentinel) self-heal watchdog. Module-scoped + guarded so the
// watchdog interval is started exactly once per process regardless of how many sys base
// connections getClient builds (serving + Buffer-mode on the sentinel path).
let sysSelfHealInterval: ReturnType<typeof setInterval> | undefined;

/**
 * FIX #2: decide whether the periodic `_slots.rediscover()` should be scheduled, from the
 * REDIS_CLUSTER_REFRESH_INTERVAL value. Pure (no side effects) so it can be unit-tested
 * without booting the cluster client.
 *
 * Contract:
 *   - value  > 0 → { enabled: true,  intervalMs: value }  (a LARGER value lengthens it)
 *   - value <= 0 → { enabled: false, intervalMs: 0 }      (0 is the DISABLE SENTINEL)
 *   - NaN / non-finite (mis-set env) → treated as the default 30000 so a typo can't silently
 *     disable the refresh (the schema coerces, but be defensive).
 *
 * Default behavior is unchanged when the env is unset: server-schema defaults
 * REDIS_CLUSTER_REFRESH_INTERVAL to 30000, so this returns { enabled: true, intervalMs: 30000 }.
 */
export function resolvePeriodicRefresh(refreshIntervalMs: number): {
  enabled: boolean;
  intervalMs: number;
} {
  if (!Number.isFinite(refreshIntervalMs)) return { enabled: true, intervalMs: 30000 };
  if (refreshIntervalMs > 0) return { enabled: true, intervalMs: refreshIntervalMs };
  return { enabled: false, intervalMs: 0 }; // 0 (or negative) = disable sentinel
}

/**
 * Force a FULL reconnect of a node-redis cluster client (FIX #1). The teardown must REJECT
 * the in-flight commands IMMEDIATELY (not drain them) and connect() rebuilds the node
 * connections + re-runs slot discovery — which is the ONLY way (short of a process restart)
 * to clear the orphaned `_execute` promises that the inflight-leak wedge accumulates.
 *
 * WHY `destroy()`, NOT `close()` (FIX #1 — verified against @redis/client@5.8.3):
 *   - cluster `close()` → `#destroy(c => c.close())` → `Promise.allSettled(perNodeClose)`, and
 *     per-node `RedisClient.close()` "waits for pending commands": it only resolves once the
 *     node's reply `#queue.isEmpty()`. The whole reason we're reconnecting is that commands
 *     are ORPHANED and never get a reply → the queue never empties → `close()` can HANG.
 *     Because the watchdog single-flights on `reconnecting=true` until reconnect settles, a
 *     hung `close()` pins `reconnecting=true` forever — the watchdog would be permanently dead
 *     after its first trigger, failing in exactly the scenario it exists for.
 *   - cluster `destroy()` → per-node `RedisClient.destroy()` =
 *     `#queue.flushAll(new DisconnectsClientError())` + `socket.destroy()`: it REJECTS every
 *     in-flight command immediately and tears the sockets down synchronously. That's what we
 *     want. (`disconnect()` is the legacy alias and also rejects immediately, but `destroy()`
 *     is the documented v5 method.)
 *
 * Each rejected in-flight command then runs its done() closure → decClusterInflight() (floored
 * at 0, FIX #2), so the counter drains back to ~0 and the watchdog can re-arm. We also reset
 * it up front so the watchdog's sampled value snaps clean at the trigger instant.
 *
 * Because `destroy()` is SYNCHRONOUS and does NOT go through the wrapped `close()` that clears
 * the topology-refresh interval, this function explicitly clears that interval before tearing
 * down (FIX #3) so it isn't leaked, then re-establishes failover after reconnect so the new
 * connection gets exactly one fresh periodic-rediscover interval.
 *
 * Any teardown error is non-fatal: connect() is still attempted, and the watchdog re-arms
 * after the cooldown regardless.
 *
 * @param reSetupFailover re-runs setupEnhancedFailover() after connect() resolves, so the
 *   periodic `_slots.rediscover()` interval (and node-error/disconnect rediscovery) is
 *   re-established post-heal exactly once (FIX #3). Injected by getBaseClient (the closure
 *   lives there); optional so unit tests can drive the function without it.
 */
async function forceClusterReconnect(
  clusterClient: any,
  reSetupFailover?: () => Promise<void>
): Promise<void> {
  // FIX #3: clear the existing topology-refresh interval BEFORE the destroy(). destroy()
  // bypasses the wrapped close() that would otherwise clear it, so without this the old
  // interval leaks and reSetupFailover() below would schedule a SECOND one (net: two
  // intervals firing rediscover on one client). Clearing here + re-creating in
  // reSetupFailover keeps it at exactly one.
  clearClusterRefreshInterval('cache');

  try {
    if (typeof clusterClient.destroy === 'function') {
      // destroy() rejects in-flight commands immediately (flushAll(DisconnectsClientError))
      // and tears sockets down synchronously — does NOT wait for the wedged queue to drain.
      clusterClient.destroy();
    } else if (typeof clusterClient.disconnect === 'function') {
      // Legacy alias for destroy() — also rejects in-flight immediately.
      await clusterClient.disconnect();
    } else if (typeof clusterClient.close === 'function') {
      // Last resort only: close() can HANG on the wedged queue (see WHY above). Bound it so
      // a hang can't pin reconnecting=true forever; fall through to connect() regardless.
      await Promise.race([
        clusterClient.close(),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
  } catch (err) {
    log(
      `Cluster self-heal: teardown threw (continuing to reconnect): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  // Reset the local inflight counter up front — destroy() rejected every in-flight command,
  // so their done() closures fire as the rejections settle and EACH floored-decrements toward
  // 0 (FIX #2 — the floor is what stops a post-heal burst of rejects driving it negative). The
  // reset just snaps the watchdog's sampled value clean at the trigger instant rather than
  // letting it decay over the next few ticks.
  resetClusterInflight();

  await clusterClient.connect();

  // FIX #3: re-establish enhanced failover (incl. the periodic-rediscover interval) on the
  // freshly-connected client. setupEnhancedFailover clears any prior interval for this client
  // kind first, so combined with the clear above this yields exactly ONE interval (honoring
  // the REDIS_CLUSTER_REFRESH_INTERVAL disable sentinel). Non-fatal if it throws.
  if (reSetupFailover) {
    try {
      await reSetupFailover();
    } catch (err) {
      log(
        `Cluster self-heal: re-setup failover after reconnect failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}

/** Clear (and forget) the topology-refresh interval for a client kind, if scheduled. */
function clearClusterRefreshInterval(type: 'cache' | 'system'): void {
  const interval = clusterRefreshIntervals.get(type);
  if (interval) {
    clearInterval(interval);
    clusterRefreshIntervals.delete(type);
  }
}

/**
 * Start the cluster-client self-heal watchdog (FIX #1). Samples the local cluster inflight
 * counter on REDIS_CLUSTER_SELFHEAL_CHECK_INTERVAL_MS and forces a full reconnect when it
 * stays pinned above the threshold for the sustained window (subject to the cooldown). All
 * thresholds are env-tunable; REDIS_CLUSTER_SELFHEAL_ENABLED=false disables it entirely.
 * Cluster client ONLY. Exposed (returns the watchdog) so a unit test can construct one with
 * injected deps without booting the module-level interval here.
 */
function startClusterSelfHeal(
  clusterClient: any,
  reSetupFailover?: () => Promise<void>
): ClusterSelfHealWatchdog {
  const watchdog = new ClusterSelfHealWatchdog(
    {
      enabled: config.clusterSelfHealEnabled,
      inflightThreshold: config.clusterSelfHealInflightThreshold,
      sustainedMs: config.clusterSelfHealSustainedMs,
      cooldownMs: config.clusterSelfHealCooldownMs,
      deadlineHitThreshold: config.clusterSelfHealDeadlineHitThreshold,
      deadlineHitWindowMs: config.clusterSelfHealDeadlineHitWindowMs,
      reconnectJitterMs: config.clusterSelfHealReconnectJitterMs,
    },
    {
      getInflight: () => getClusterInflight(),
      getDeadlineHits: (windowMs: number) => countClusterDeadlineHits(windowMs),
      resetDeadlineHits: () => resetClusterDeadlineHits(),
      reconnect: () => forceClusterReconnect(clusterClient, reSetupFailover),
      log,
      onReconnect: (inflightAtTrigger: number, trigger: ClusterSelfHealTrigger) => {
        // Labeled by trigger so a rising `trigger="deadline"` series at the next prod wave is the
        // direct confirmation that the fix's new path fired (the one the inflight path could
        // never reach). See cluster-selfheal.ts and prom/client.ts.
        getRedisMetrics()?.redisSelfHealReconnectCounter?.inc({ trigger, client: 'cluster' });
        log(
          `Cluster self-heal RECONNECT fired [trigger=${trigger}, inflight=${inflightAtTrigger}, inflightThreshold=${config.clusterSelfHealInflightThreshold}, sustainedMs=${config.clusterSelfHealSustainedMs}, deadlineHitThreshold=${config.clusterSelfHealDeadlineHitThreshold}, deadlineHitWindowMs=${config.clusterSelfHealDeadlineHitWindowMs}]`
        );
      },
    }
  );

  if (!config.clusterSelfHealEnabled) {
    log('Cluster self-heal watchdog DISABLED (REDIS_CLUSTER_SELFHEAL_ENABLED=false)');
    return watchdog;
  }

  const interval = Math.max(250, config.clusterSelfHealCheckIntervalMs);
  clusterSelfHealInterval = setInterval(() => {
    try {
      // Publish what the watchdog SEES (its own in-process slow-settle window) BEFORE ticking, so
      // the gauge reflects the same value the trigger evaluates. Distinct from the duration
      // histogram — this is the watchdog's own observation, the signal that was invisible during
      // the 2026-07-06 wedge. Cheap: an O(ring) windowed count. No-op until the prom bridge loads.
      getRedisMetrics()?.redisSelfHealDeadlineHitsWindow?.set(
        { client: 'cluster' },
        countClusterDeadlineHits(config.clusterSelfHealDeadlineHitWindowMs)
      );
      watchdog.tick();
    } catch (err) {
      log(`Cluster self-heal tick error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, interval);
  // Don't keep the event loop alive for the watchdog on a graceful process exit.
  clusterSelfHealInterval.unref?.();
  log(
    `Cluster self-heal watchdog ENABLED [inflightThreshold=${config.clusterSelfHealInflightThreshold}, sustainedMs=${config.clusterSelfHealSustainedMs}, deadlineHitThreshold=${config.clusterSelfHealDeadlineHitThreshold}, deadlineHitWindowMs=${config.clusterSelfHealDeadlineHitWindowMs}, reconnectJitterMs=${config.clusterSelfHealReconnectJitterMs}, cooldownMs=${config.clusterSelfHealCooldownMs}, checkMs=${interval}]`
  );
  return watchdog;
}

/**
 * Force a FULL reconnect of the sysRedis client(s) — the mirror of forceClusterReconnect for
 * the OTHER node-redis client (incident 2026-07-03). A sentinel flap orphaned in-flight commands
 * on the RedisSentinel client and the client never self-healed; a full destroy → connect is the
 * only thing (short of a pod restart) that clears the orphaned in-flight promises.
 *
 * WHY `destroy()`, NOT `close()` (verified against @redis/client@5.8.3 sentinel/index.js):
 *   - RedisSentinel `close()` → `#internal.close()` waits for the per-node reply queues to drain;
 *     the whole reason we're reconnecting is that commands are ORPHANED and never get a reply, so
 *     the queue never empties → `close()` can HANG. Because the watchdog single-flights on
 *     `reconnecting=true` until reconnect settles, a hung close pins it forever — the watchdog
 *     would be permanently dead after its first trigger, failing exactly when it's needed.
 *   - RedisSentinel `destroy()` → `#internal.destroy()` (async) destroys the sentinel client +
 *     master-pool clients + replica-pool clients; each per-node `RedisClient.destroy()` =
 *     `flushAll(new DisconnectsClientError())` + `socket.destroy()`, REJECTING every in-flight
 *     command immediately, and resets its internal `#destroy` flag so the client is reconnectable.
 *     `connect()` then re-runs sentinel discovery (re-resolving the master via the sentinels) and,
 *     with reserveClient:true, re-acquires the reserved master lease — so this is the client's
 *     PROPER reconnect, never a raw socket poke, and the Buffer-mode quirk is untouched (the
 *     derived buffer client shares the same reconnected base).
 *
 * ALL sys base connections are reconnected: on the sentinel path getClient builds TWO 'sys' base
 * clients (serving + the dedicated Buffer-mode one), BOTH feed the aggregate sys inflight counter,
 * so healing only one could leave the counter pinned by the other and the watchdog would never
 * clear the wedge. Each rejected in-flight command runs its done() → decSysInflight() (floored at
 * 0), so the counter drains to ~0; we also reset it up front so the sampled value snaps clean.
 *
 * Any teardown/connect error on one client is non-fatal — the others are still attempted and the
 * watchdog re-arms after the cooldown regardless.
 *
 * Exported (like resolvePeriodicRefresh) so the sentinel destroy→connect correctness can be
 * unit-tested directly without booting a real client.
 */
export async function forceSysReconnect(sysClients: any[]): Promise<void> {
  // Reset the local inflight counter up front — destroy() rejects every in-flight command, so
  // their done() closures fire as the rejections settle and EACH floored-decrements toward 0.
  // The reset just snaps the watchdog's sampled value clean at the trigger instant.
  resetSysInflight();

  for (const client of sysClients) {
    if (!client) continue;
    try {
      if (typeof client.destroy === 'function') {
        // RedisSentinel.destroy() returns the async #internal.destroy() promise (rejects in-flight
        // commands + tears sockets down); await it so connect() runs on a fully-destroyed client.
        await client.destroy();
      } else if (typeof client.disconnect === 'function') {
        await client.disconnect();
      } else if (typeof client.close === 'function') {
        // Last resort only: close() can HANG on the wedged queue (see WHY above). Bound it so a
        // hang can't pin reconnecting=true forever; fall through to connect() regardless.
        await Promise.race([
          client.close(),
          new Promise<void>((resolve) => setTimeout(resolve, 2000)),
        ]);
      }
    } catch (err) {
      log(
        `Sys self-heal: teardown threw (continuing to reconnect): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    try {
      await client.connect();
    } catch (err) {
      // Non-fatal: node-redis keeps retrying the connection in the background via its
      // reconnectStrategy, and the watchdog re-arms after the cooldown.
      log(
        `Sys self-heal: reconnect() threw (background retry continues): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}

/**
 * Start the sys (sysRedis / Sentinel) self-heal watchdog — the mirror of startClusterSelfHeal for
 * the OTHER node-redis client. REUSES the generic ClusterSelfHealWatchdog (it's client-agnostic:
 * a config + injected getInflight/reconnect/onReconnect). The DEADLINE-hit trigger is left OFF
 * (deadlineHitThreshold 0, no getDeadlineHits dep) because the sys client has no per-command
 * deadline — the incident wedge climbs inflight monotonically (no sawtooth), so the sustained-
 * inflight path is exactly the right and only trigger. REDIS_SYS_SELFHEAL_ENABLED=false disables
 * it entirely. Started once per process (guarded by sysSelfHealInterval).
 */
function startSysSelfHeal(sysClients: any[]): ClusterSelfHealWatchdog {
  const watchdog = new ClusterSelfHealWatchdog(
    {
      enabled: config.sysSelfHealEnabled,
      inflightThreshold: config.sysSelfHealInflightThreshold,
      sustainedMs: config.sysSelfHealSustainedMs,
      cooldownMs: config.sysSelfHealCooldownMs,
      // Sys has no command deadline → no sawtooth/deadline-hit path. Disable that trigger.
      deadlineHitThreshold: 0,
      deadlineHitWindowMs: 0,
      reconnectJitterMs: config.sysSelfHealReconnectJitterMs,
    },
    {
      getInflight: () => getSysInflight(),
      // getDeadlineHits intentionally omitted (deadline trigger inert for the sys client).
      reconnect: () => forceSysReconnect(sysClients),
      log,
      onReconnect: (inflightAtTrigger: number, trigger: ClusterSelfHealTrigger) => {
        // client="sys" label so a rising series confirms the SENTINEL client healed (vs cluster).
        getRedisMetrics()?.redisSelfHealReconnectCounter?.inc({ trigger, client: 'sys' });
        log(
          `Sys self-heal RECONNECT fired [trigger=${trigger}, inflight=${inflightAtTrigger}, inflightThreshold=${config.sysSelfHealInflightThreshold}, sustainedMs=${config.sysSelfHealSustainedMs}, clients=${sysClients.length}]`
        );
      },
    }
  );

  if (!config.sysSelfHealEnabled) {
    log('Sys self-heal watchdog DISABLED (REDIS_SYS_SELFHEAL_ENABLED=false)');
    return watchdog;
  }

  const interval = Math.max(250, config.sysSelfHealCheckIntervalMs);
  sysSelfHealInterval = setInterval(() => {
    try {
      watchdog.tick();
    } catch (err) {
      log(`Sys self-heal tick error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, interval);
  // Don't keep the event loop alive for the watchdog on a graceful process exit.
  sysSelfHealInterval.unref?.();
  log(
    `Sys self-heal watchdog ENABLED [inflightThreshold=${config.sysSelfHealInflightThreshold}, sustainedMs=${config.sysSelfHealSustainedMs}, reconnectJitterMs=${config.sysSelfHealReconnectJitterMs}, cooldownMs=${config.sysSelfHealCooldownMs}, checkMs=${interval}, clients=${sysClients.length}]`
  );
  return watchdog;
}

/**
 * Parse cluster node URLs from environment variable.
 * Falls back to single URL if REDIS_CLUSTER_NODES is not set.
 */
function parseClusterNodes(fallbackUrl: string): { url: string }[] {
  if (config.clusterNodes) {
    const nodes = config.clusterNodes
      .split(',')
      .map((nodeUrl) => nodeUrl.trim())
      .filter(Boolean)
      .map((nodeUrl) => {
        const url = new URL(nodeUrl);
        return { url: `${url.protocol}//${url.host}` };
      });

    if (nodes.length > 0) {
      log(`Using ${nodes.length} cluster root nodes from REDIS_CLUSTER_NODES`);
      return nodes;
    }
  }

  log('Using single cluster root node from REDIS_URL');
  return [{ url: fallbackUrl }];
}

// Shape of the prom metric handles the app publishes on globalThis (see '~/server/prom/client').
// Read at runtime WITHOUT a static prom-client import so this (client-bundle-reachable) module
// never drags prom-client's fs/cluster requires into the client bundle. Undefined until the
// app's prom module has loaded server-side (always true by the time real commands run);
// instrumentation simply no-ops until then (leak-free).
type RedisMetricsBridge = {
  redisCommandsInflight: {
    inc: (labels: { client: string }) => void;
    dec: (labels: { client: string }) => void;
  };
  redisCommandDuration: { observe: (labels: { client: string }, value: number) => void };
  sysredisSentinelTopologyChangesCounter: {
    labels: (labels: Record<string, string>) => { inc: () => void };
  };
  sysredisSentinelClientErrorsCounter: {
    labels: (labels: Record<string, string>) => { inc: () => void };
  };
  // FIX #1 self-heal reconnect counter (labeled by `trigger`: 'deadline' | 'inflight'). Read via the
  // globalThis bridge so this client-bundle-reachable module avoids a static prom-client import (which
  // drags in fs/cluster). May be undefined until prom/client loads server-side; callers null-check.
  redisSelfHealReconnectCounter?: { inc: (labels: { trigger: string; client: string }) => void };
  // The watchdog's OWN observation: the in-process slow-settle count it samples each tick (the
  // deadline-hit window). Exposed so we can SEE what the watchdog sees, distinct from the
  // redis_command_duration histogram — diagnosing the 2026-07-06 wedge was hard precisely because
  // this was invisible. Set each watchdog tick (client="cluster").
  redisSelfHealDeadlineHitsWindow?: { set: (labels: { client: string }, value: number) => void };
  // Cluster routing retry-after-rediscover counter (the topology-churn 500 wave). Read via the
  // same globalThis bridge so this client-bundle-reachable module avoids a static prom import.
  redisRoutingRetryCounter?: { inc: (labels: { result: 'recovered' | 'exhausted' }) => void };
};

function getRedisMetrics(): RedisMetricsBridge | undefined {
  return (globalThis as unknown as { __civitaiRedisMetrics?: RedisMetricsBridge })
    .__civitaiRedisMetrics;
}

/**
 * Attach observability listeners to a Sentinel client: log + count topology changes and
 * sub-client errors, labeled {type, host, deployment}. Counters come from the injected prom
 * bridge (noop fallback), so the package stays free of a static prom import.
 */
export function attachSysSentinelListeners(
  client: { on: (event: string, listener: (e: any) => void) => unknown },
  ctx: {
    deployment: string;
    log: (msg: string, ...rest: unknown[]) => void;
    topologyCounter: { labels: (labels: Record<string, string>) => { inc: () => void } };
    errorCounter: { labels: (labels: Record<string, string>) => { inc: () => void } };
  }
) {
  client.on('topology-change', (event: any) => {
    const { type: eventType, node } = event ?? {};
    const host = node?.host ?? '?';
    const port = node?.port ?? '?';
    ctx.log(
      `Redis sentinel topology change [type=${eventType ?? 'unknown'}, host=${host}, port=${port}]`,
      event
    );
    ctx.topologyCounter
      .labels({
        type: String(eventType ?? 'unknown'),
        host: String(host),
        deployment: ctx.deployment,
      })
      .inc();
  });
  client.on('client-error', (event: any) => {
    const { type: eventType, node, error } = event ?? {};
    const host = node?.host ?? '?';
    const port = node?.port ?? '?';
    ctx.log(
      `Redis sentinel sub-client error [type=${
        eventType ?? 'unknown'
      }, host=${host}, port=${port}]`,
      error ?? event
    );
    ctx.errorCounter
      .labels({
        type: String(eventType ?? 'unknown'),
        host: String(host),
        deployment: ctx.deployment,
      })
      .inc();
  });
}

/**
 * Per-command chokepoint knobs. Default to the module `config` in production; a test can inject
 * them so `instrumentCommands` is exercisable against a fake client WITHOUT booting the factory
 * (which eagerly connects). All optional — omitted values fall back to `config` (then a safe 0).
 */
export interface InstrumentCommandsOptions {
  deadlineMs?: number;
  slowCommandMs?: number;
  routingRetryEnabled?: boolean;
  routingRetryMax?: number;
  routingRetryBackoffMs?: number;
  routingRetryBackoffMaxMs?: number;
}

/**
 * Wrap the per-client command chokepoint so EVERY command is counted in the inflight gauge
 * and timed. The chokepoint differs by kind: SINGLE client -> `sendCommand`; CLUSTER client
 * -> `_execute` (typed methods route through it, not the top-level sendCommand). The cluster
 * command is additionally raced against `withCommandDeadline` so a never-settling `_execute`
 * still reaches done() (gauge dec'd, handler unparked) AND records a self-heal slow-settle hit
 * from done() when its observed duration crosses the slow threshold.
 *
 * Exported (with injectable `opts`) so the self-heal SLOW-SETTLE recording path can be unit-tested
 * end-to-end against a fake `_execute` — the 2026-07-06 regression driver.
 */
export function instrumentCommands(
  client: any,
  clientLabel: 'cluster' | 'sys',
  opts: InstrumentCommandsOptions = {}
) {
  const self = client?._self ?? client;
  if (!self) return;
  const labels = { client: clientLabel } as const;
  // Detect the real chokepoint by capability: a 'cache' client is a CLUSTER (wrap `_execute`)
  // only when REDIS_CLUSTER is on; otherwise it's a plain single client (wrap `sendCommand`).
  const isClusterClient = typeof self._execute === 'function';
  const methodName = isClusterClient ? '_execute' : 'sendCommand';
  const original = self[methodName];
  if (typeof original !== 'function') {
    log(`Redis instrumentation: ${methodName} not found on ${clientLabel} client`);
    return;
  }
  const wrapWithDeadline = isClusterClient && clientLabel === 'cluster';
  const deadlineMs = opts.deadlineMs ?? config?.clusterCommandTimeoutMs ?? 0;
  // Self-heal SLOW-SETTLE threshold (cluster only): a command whose observed settle duration
  // reaches this counts as a wedge hit for the deadline-hit trigger. Sourced at SETTLE time (done)
  // so it can't diverge from redis_command_duration_seconds the way the old onTimeout-only path did.
  const slowCommandMs = opts.slowCommandMs ?? config?.clusterSelfHealSlowCommandMs ?? 0;
  const routingRetryEnabled =
    opts.routingRetryEnabled ?? config?.clusterRoutingRetryEnabled ?? false;
  const routingRetryMax = opts.routingRetryMax ?? config?.clusterRoutingRetryMax ?? 0;
  const routingRetryBackoffMs =
    opts.routingRetryBackoffMs ?? config?.clusterRoutingRetryBackoffMs ?? 0;
  const routingRetryBackoffMaxMs =
    opts.routingRetryBackoffMaxMs ?? config?.clusterRoutingRetryBackoffMaxMs ?? 0;
  self[methodName] = function (this: any, ...args: any[]) {
    // Capture the metric handles ONCE per command so inc/dec stay balanced even if the app's
    // prom module loads mid-flight (a dec without its inc would drive the gauge negative).
    const metrics = getRedisMetrics();
    metrics?.redisCommandsInflight.inc(labels);
    // Mirror the gauge into the local counter the self-heal watchdog samples. Each client kind
    // has its OWN floored counter (cluster / sys) so its watchdog can sample it without a prom dep.
    if (clientLabel === 'cluster') incClusterInflight();
    else incSysInflight();
    const start = Date.now();
    let dec = false; // per-closure guard so a double-settle (shouldn't happen) can't double-dec
    const done = () => {
      const durationMs = Date.now() - start;
      if (!dec) {
        // FLOORED decrement (dec{Cluster,Sys}Inflight clamp at 0). The per-closure `dec` guard
        // above only stops THIS closure decrementing twice — it does NOT stop N distinct rejected
        // closures (e.g. the burst destroy() rejects after a heal) decrementing past 0. The floor
        // is what keeps the counter accurate post-heal so the watchdog can re-arm.
        if (clientLabel === 'cluster') decClusterInflight();
        else decSysInflight();
        dec = true;
      }
      metrics?.redisCommandsInflight.dec(labels);
      metrics?.redisCommandDuration.observe(labels, durationMs / 1000);
      // SELF-HEAL SIGNAL (cluster client only): record a wedge "hit" whenever a cluster command's
      // OBSERVED settle duration reaches the slow threshold — the SAME settle-time observation as
      // the duration histogram above. This is the 2026-07-06 fix: it REPLACES the old
      // withCommandDeadline.onTimeout recorder, which fired only when the 15s deadline REAPED a
      // still-hanging command. During that fleet wedge the slow cluster commands settled on their
      // own past the deadline (~29s), so onTimeout never fired and the deadline-hit trigger stayed
      // silent while the histogram plainly showed ~4/s > 15s commands. Recording at settle time is
      // sawtooth-immune (a rate of slow settles, not an inflight level) and covers BOTH wedge
      // shapes: a deadline-reaped orphan settles at ~deadlineMs, a self-settling command at ~29s —
      // both >= the slow threshold. sysRedis (single-node) is deliberately untouched (#2556/#2586).
      if (clientLabel === 'cluster') recordClusterCommandSettle(durationMs, slowCommandMs);
    };

    // Run the underlying command, capturing a SYNCHRONOUS routing throw (the getSlotRandomNode
    // TypeError fires synchronously during node selection BEFORE dispatch) as a rejection so the
    // retry guard below sees it uniformly with an async reject. Defined as a thunk so the routing
    // guard can re-invoke it for a retry — safe because a transient routing error means the
    // command NEVER reached a node (no double-execution).
    const runOnce = () =>
      new Promise<any>((resolve, reject) => {
        try {
          resolve(original.apply(this, args));
        } catch (err) {
          reject(err);
        }
      });

    // Retry-after-rediscover for the TRANSIENT cluster-routing throw — CLUSTER client ONLY (the
    // topology-churn 500 wave #2665 doesn't cover; see cluster-routing-retry.ts). Sits AROUND
    // node selection, INSIDE the single inflight inc/dec + deadline accounting: the retried
    // attempts are SEQUENTIAL (await), never overlapping, so this is ONE inflight unit regardless
    // of retries (no double-count, done() fires exactly once). The sys client (wrapWithDeadline=
    // false) is left exactly as before — no routing guard, no deadline. Default-on; the
    // REDIS_CLUSTER_ROUTING_RETRY_ENABLED=false kill-switch passes runOnce() straight through.
    // The `rediscover` hook is a FIRE-AND-FORGET nudge: triggerTopologyRediscovery returns
    // undefined (it does not await the rediscover promise), so the guard's backoff — not this call —
    // is what gives the in-flight slot-map refresh time to settle before the retry.
    const executed: Promise<any> = wrapWithDeadline
      ? withClusterRoutingRetry(runOnce, {
          // Env-driven knobs (a pure module can't read env itself; client.ts injects config here,
          // resolved once above so instrumentCommands stays testable with injected opts).
          enabled: routingRetryEnabled,
          maxRetries: routingRetryMax,
          backoffMs: [routingRetryBackoffMs, routingRetryBackoffMaxMs],
          rediscover: () => triggerTopologyRediscovery(self, 'routing-retry'),
          onResult: (result) => getRedisMetrics()?.redisRoutingRetryCounter?.inc({ result }),
        })
      : runOnce();

    // Bound the cluster command so a never-settling `_execute` still reaches done()
    // (gauge dec'd, handler unparked). No-op when the deadline env is 0/disabled or for
    // the sys client (wrapWithDeadline=false). withCommandDeadline reaps the late
    // rejection of the orphaned command so it can't surface as an unhandledRejection.
    // Layered OUTSIDE the routing retry so the 15s deadline bounds the WHOLE retried sequence
    // (the bounded ~50ms+150ms backoff is well inside it). The self-heal wedge signal is NO
    // LONGER sourced from this deadline's reap (onTimeout) — done() records it from the observed
    // settle duration instead (see the recordClusterCommandSettle call above), so the trigger
    // fires whether or not the deadline actually reaps the command (2026-07-06 fix).
    const settled = wrapWithDeadline ? withCommandDeadline(executed, deadlineMs) : executed;
    return settled.finally(done);
  };
}

function getBaseClient(type: 'cache' | 'system') {
  log(`Creating Redis client (${type})`);

  const REDIS_URL = type === 'system' ? config.sysUrl : config.url;
  const url = new URL(REDIS_URL);
  const connectionUrl = `${url.protocol}//${url.host}`;

  // socketTimeout is scoped PER client kind. The CLUSTER (cache) client carries the 504-cascade
  // structural fix; the SYSTEM client is single-node + mostly idle and the same aggressive
  // teardown against the flaky sysRedis backend converted a transient half-open into a reconnect
  // storm (#2556/#2586) — so it defaults to 0 (disabled) and relies on the two guards below.
  const isSystem = type === 'system';
  const socketTimeoutMs = isSystem ? config.sysSocketTimeoutMs : config.socketTimeoutMs;

  // System-only guards (the cache client keeps node-redis defaults):
  // 1. commandsQueueMaxLength — with socketTimeout disabled a silent half-open is only cleared
  //    by OS TCP keepalive (minutes); the cap fast-fails new commands so the reply queue can't
  //    grow unbounded toward OOM (fail-open callers catch the rejection).
  // 2. disableOfflineQueue — while RECONNECTING, node-redis would buffer commands; under load
  //    that buffer fills before the reconnect handshake (which uses the SAME queue) can enqueue,
  //    starving recovery into a permanent wedge. Rejecting offline commands keeps room for it.
  const commandsQueueMaxLength =
    isSystem && config.sysCommandsQueueMaxLength > 0 ? config.sysCommandsQueueMaxLength : undefined;

  // Shared configuration
  const socketConfig = {
    reconnectStrategy(retries: number) {
      log(`Redis reconnecting, retry ${retries}`);
      return Math.min(retries * 100, 3000);
    },
    connectTimeout: config.timeout,
    // Socket-level inactivity guard (node-redis -> net.Socket.setTimeout): an IDLE timer reset
    // by any read/write. On a SILENT half-open the in-flight command is parked and blocks every
    // write incl. the keepalive PING, so the timer runs to completion and tears the dead socket
    // down in ~socketTimeoutMs instead of ~30s OS keepalive (= the 504 ceiling). 0/unset disables.
    ...(socketTimeoutMs > 0 ? { socketTimeout: socketTimeoutMs } : {}),
  };

  const authConfig = {
    username: url.username === '' ? undefined : url.username,
    password: url.password,
  };

  // Keepalive PING interval. node-redis PINGs every interval only when the socket is idle (a
  // parked command blocks it), and each PING resets the socketTimeout idle timer — keeping a
  // HEALTHY idle socket alive while a genuinely half-open one still trips socketTimeout. The
  // INVARIANT pingInterval < socketTimeout prevents a healthy socket spuriously firing it, so we
  // CLAMP to min(env, socketTimeout/2). When socketTimeout is disabled there is no idle timer to
  // keep reset, so just honor the configured interval.
  const pingInterval =
    socketTimeoutMs > 0
      ? Math.min(config.pingIntervalMs, Math.floor(socketTimeoutMs / 2))
      : config.pingIntervalMs;
  log(
    `Redis ping interval (${type}) = ${pingInterval}ms (REDIS_PING_INTERVAL_MS=${config.pingIntervalMs}, socketTimeout=${socketTimeoutMs}ms)`
  );

  // System redis is single-node, OR — when REDIS_SYS_SENTINELS is set — a Sentinel-discovered
  // HA topology. Cache redis is cluster or single-node based on REDIS_CLUSTER.
  const isCluster = type === 'cache' && config.cluster;
  const isSysSentinel = type === 'system' && !!config.sysSentinels;

  const baseClient = isSysSentinel
    ? createSentinel({
        // superRefine guarantees the name is set when sentinels are configured.
        name: config.sysSentinelName!,
        sentinelRootNodes: config.sysSentinels!.split(',').map((hp) => {
          const [host, port] = hp.trim().split(':');
          return { host, port: parseInt(port ?? '26379', 10) };
        }),
        nodeClientOptions: {
          // Reuse the password already extracted from REDIS_SYS_URL.
          password: authConfig.password,
          socket: socketConfig,
          pingInterval,
        },
        sentinelClientOptions: config.sysSentinelPassword
          ? { password: config.sysSentinelPassword, socket: socketConfig }
          : { socket: socketConfig },
        // Pool size 2 so the periodic PING heartbeat runs on a separate TCP connection from
        // in-flight writes (a slow EVAL on pool size 1 head-of-line blocks the heartbeat).
        masterPoolSize: 2,
        replicaPoolSize: 0,
        scanInterval: 10_000,
        // Keep sub-client errors local; we surface them via the client-error listener instead.
        passthroughClientErrorEvents: false,
        // reserveClient: true pins ONE master lease at connect() (#reservedClientInfo) and routes
        // every master command through it, fully bypassing node-redis's racy shared-lease path:
        //   this.#masterClientInfo ??= await this.#internal.getClientLease();
        // The `??=` checks nullish BEFORE awaiting, so a COLD concurrent burst (no master command
        // in flight → #masterClientInfo undefined) lets multiple callers all pass the check and each
        // call getClientLease(). Extra leases orphan (release guard uses `===`, so only the last
        // writer's lease is ever returned) and pin pool slots → with masterPoolSize:2 the pool
        // exhausts and any code needing a fresh master lease hangs (deadlock). This bug is present
        // and UNFIXED upstream through at least node-redis 6.1.0 (verified byte-identical in
        // 5.8.3 / 5.12.1 / 6.1.0) — it is version-independent, so pinning the reserved client is the
        // durable sidestep. The reserved lease is just an integer index into the master pool, which
        // transform() rebuilds IN PLACE (same ids) on a switch-master, so it repoints to the new
        // master on failover — no failover regression, and zero net connection delta (the pool still
        // opens masterPoolSize connections either way).
        reserveClient: true,
      })
    : isCluster
    ? createCluster({
        // Use multiple root nodes for redundant topology discovery
        rootNodes: parseClusterNodes(connectionUrl),
        defaults: {
          ...authConfig,
          socket: socketConfig,
          pingInterval,
        },
        // Increase max redirections for stability during failover
        // Default is 16, we increase to handle longer failover scenarios
        maxCommandRedirections: 32,
      })
    : createClient({
        url: connectionUrl,
        ...authConfig,
        socket: socketConfig,
        pingInterval,
        ...(commandsQueueMaxLength ? { commandsQueueMaxLength } : {}),
        ...(isSystem ? { disableOfflineQueue: true } : {}),
      });

  // Sentinel observability — count topology changes + sub-client errors (PR #2331). Counters
  // come from the app's prom bridge (noop until it loads); deployment = pod HOSTNAME.
  if (isSysSentinel) {
    const metrics = getRedisMetrics();
    const noopCounter = { labels: () => ({ inc: () => undefined }) };
    attachSysSentinelListeners(
      baseClient as unknown as { on: (e: string, l: (e: any) => void) => unknown },
      {
        deployment: process.env.HOSTNAME ?? 'unknown',
        log,
        topologyCounter: metrics?.sysredisSentinelTopologyChangesCounter ?? noopCounter,
        errorCounter: metrics?.sysredisSentinelClientErrorsCounter ?? noopCounter,
      }
    );
  }

  // Common event handlers (note: cluster clients don't emit connect/ready events in node-redis v4.x)
  baseClient.on('error', (err: Error) => log(`Redis Error (${type})`, err));
  baseClient.on('connect', () => log(`Redis connected (${type})`));
  baseClient.on('reconnecting', () => log(`Redis reconnecting (${type})`));
  baseClient.on('ready', () => log(`Redis ready! (${type})`));

  // Cluster-specific event handlers for failover detection
  // Enhanced failover handling is gated behind FLIPT_FEATURE_FLAGS.REDIS_CLUSTER_ENHANCED_FAILOVER
  // The flag uses the "is-next" segment (hostname == next.civitai.com) to enable by default on next
  if (isCluster) {
    // Extract hostname for Flipt context (used for segment matching)
    const getFliptHostname = (): string => {
      try {
        // NEXTAUTH_URL contains the full URL like https://next.civitai.com
        const nextAuthUrl = config.nextAuthUrl;
        if (nextAuthUrl) {
          return new URL(nextAuthUrl).hostname;
        }
      } catch {
        // Ignore URL parsing errors
      }
      return 'unknown';
    };
    const fliptHostname = getFliptHostname();
    const fliptContext: Record<string, string> = { hostname: fliptHostname };
    if (config.fliptDeploymentId) fliptContext.deploymentId = config.fliptDeploymentId;
    log(
      `Flipt context for enhanced failover flag: hostname=${fliptHostname}, deploymentId=${
        config.fliptDeploymentId ?? 'unset'
      }`
    );

    // Helper to check the injected app policy before triggering rediscovery
    const maybeRediscover = async (reason: string) => {
      if (await isEnhancedFailoverEnabled(fliptContext)) {
        triggerTopologyRediscovery(baseClient, reason);
      }
    };

    // Triggered when a specific node encounters an error
    baseClient.on('node-error', (err: Error, node: any) => {
      const nodeAddr = node?.address || node?.url || 'unknown';
      log(`Redis node error [${nodeAddr}]: ${err.message}`);
      // Trigger topology rediscovery when a node fails (if feature enabled)
      maybeRediscover(`node-error on ${nodeAddr}`);
    });

    // Triggered when a node disconnects
    // This is critical for detecting failovers where the old master goes down
    baseClient.on('node-disconnect', (node: any) => {
      const nodeAddr = node?.address || node?.url || 'unknown';
      log(`Redis node disconnected: ${nodeAddr}`);
      // Trigger topology rediscovery to find the new master (if feature enabled)
      maybeRediscover(`node-disconnect on ${nodeAddr}`);
    });

    // Triggered when a node reconnects
    baseClient.on('node-connect', (node: any) => {
      const nodeAddr = node?.address || node?.url || 'unknown';
      log(`Redis node connected: ${nodeAddr}`);
    });

    // Triggered when a node is ready
    baseClient.on('node-ready', (node: any) => {
      const nodeAddr = node?.address || node?.url || 'unknown';
      log(`Redis node ready: ${nodeAddr}`);
    });

    // Set up periodic topology refresh after client is ready and feature flag is checked
    // This ensures we don't rely solely on MOVED/ASK errors for discovery
    // See: https://github.com/redis/node-redis/issues/2806
    // Helper function to set up enhanced failover after connection
    const setupEnhancedFailover = async () => {
      try {
        log('Checking enhanced failover feature flag...');
        const enhancedFailoverEnabled = await isEnhancedFailoverEnabled(fliptContext);

        if (!enhancedFailoverEnabled) {
          log('Enhanced cluster failover handling is DISABLED (feature flag off)');
          return;
        }

        log('Enhanced cluster failover handling is ENABLED');

        // FIX #2: the periodic `_slots.rediscover()` is env-tunable AND disable-able via
        // REDIS_CLUSTER_REFRESH_INTERVAL (the standing 30s default is unchanged when unset):
        //   * a LARGER value lengthens the interval;
        //   * 0 (or any value <= 0) is the DISABLE SENTINEL — no periodic rediscover is
        //     scheduled at all (event-driven rediscovery on node-error/node-disconnect still
        //     runs). This lets the infra side run the "lengthen / disable the periodic
        //     rediscover" experiment (it is the most plausible SEED of the inflight-leak wedge:
        //     a periodic rediscover racing an in-flight write) as a pure env change, no deploy.
        const { enabled: refreshEnabled, intervalMs: refreshInterval } = resolvePeriodicRefresh(
          config.clusterRefreshInterval
        );
        // Guard against re-entry. setupEnhancedFailover runs on the INITIAL connect() AND is
        // re-invoked by forceClusterReconnect (FIX #3) after a self-heal forced reconnect (it's
        // passed in as reSetupFailover). Without clearing first, a re-setup would stack a second
        // interval + re-wrap close. forceClusterReconnect already clears the interval before its
        // destroy(); clearing again here is idempotent and also covers any future re-entry path.
        // Net: after any connect()/reconnect there is exactly ONE refresh interval.
        clearClusterRefreshInterval(type);
        if (refreshEnabled) {
          const intervalId = setInterval(() => {
            triggerTopologyRediscovery(baseClient, 'periodic refresh');
          }, refreshInterval);

          // Store interval for cleanup
          clusterRefreshIntervals.set(type, intervalId);

          // Wrap close to clean up interval (only wrap once — re-wrapping on each reconnect
          // would nest the wrappers).
          if (!(baseClient as any).__refreshCloseWrapped) {
            const originalClose = baseClient.close?.bind(baseClient);
            if (originalClose) {
              (baseClient as any).__refreshCloseWrapped = true;
              (baseClient as any).close = async () => {
                const interval = clusterRefreshIntervals.get(type);
                if (interval) {
                  clearInterval(interval);
                  clusterRefreshIntervals.delete(type);
                  log(`Cleared topology refresh interval for ${type}`);
                }
                return originalClose();
              };
            }
          }

          log(`Topology refresh scheduled every ${refreshInterval}ms`);
        } else {
          // Disable sentinel hit.
          log(
            `Periodic topology refresh DISABLED (REDIS_CLUSTER_REFRESH_INTERVAL=${refreshInterval} <= 0); event-driven rediscovery still active`
          );
        }
      } catch (err) {
        log(`Enhanced failover setup failed: ${err instanceof Error ? err.message : err}`);
      }
    };

    // Note: node-redis v4.x cluster clients don't emit 'ready' event (known bug)
    // So we set up enhanced failover in the connect() promise callback instead
    // See: https://github.com/redis/node-redis/issues/1855

    // Don't await here - let connection happen in background
    // The client will queue commands until connected
    log(`Calling connect() for ${type} (cluster) client...`);
    baseClient
      .connect()
      .then(async () => {
        log(`${type} cluster client connected`);
        await setupEnhancedFailover();
        // FIX #1: start the inflight-leak self-heal watchdog ONCE per process for the cache
        // cluster client. Guarded so a self-heal forced reconnect doesn't stack a second
        // watchdog interval. Pass setupEnhancedFailover so forceClusterReconnect re-establishes
        // the periodic-rediscover interval after a heal (FIX #3). The forced reconnect does NOT
        // re-run this connect() .then callback (it calls baseClient.connect() directly), so the
        // re-setup must be threaded through the watchdog, not relied on here.
        if (type === 'cache' && !clusterSelfHealInterval) {
          startClusterSelfHeal(baseClient, setupEnhancedFailover);
        }
      })
      .catch((err) => {
        log(`Redis connection failed (${type})`, err);
      });

    return baseClient;
  }

  // Non-cluster client - use the normal flow
  // Don't await here - let connection happen in background
  // The client will queue commands until connected
  log(`Calling connect() for ${type} (single) client...`);
  baseClient
    .connect()
    .then(() => {
      log(`${type} single client connected`);
    })
    .catch((err) => {
      log(`Redis connection failed (${type})`, err);
    });

  return baseClient;
}

function getClient<K extends RedisKeyTemplates>(type: 'cache' | 'system') {
  const client = getBaseClient(type) as unknown as CustomRedisClient<K>;

  // Wire in-flight + duration instrumentation at the per-command chokepoint. 'cache' is the
  // cluster client (wrap `_execute`), 'system' is the single sysRedis client (wrap `sendCommand`).
  instrumentCommands(client, type === 'cache' ? 'cluster' : 'sys');

  // Create a Buffer-typed client for the packed operations (get<Buffer>/sMembers<Buffer>/…).
  //
  // `withTypeMapping` is *supposed* to return a NEW client that returns Buffers while the
  // original keeps returning strings. That holds for the single-node (RedisClient) and cluster
  // (RedisCluster) paths — both `_commandOptionsProxy` implementations set a proxy-LOCAL
  // `_commandOptions` and never touch the base client (verified in @redis/client
  // client/index.js:445 and cluster/index.js:144).
  //
  // But node-redis v5.8.3 has a Sentinel-specific defect: `RedisSentinel._commandOptionsProxy`
  // (sentinel/index.js:220-228) writes `proxy._self.#commandOptions = { …, [key]: value }`, and
  // `_self` IS the shared base sentinel client. So on the Sentinel path (prod sysRedis) a SINGLE
  // `withTypeMapping(...)` call permanently rewrites the base client's DEFAULT command options —
  // every subsequent plain `sMembers`/`get`/`hGet`/… on `client` returns Buffers instead of
  // strings, 100% deterministically from process start. That silently broke session revocation
  // (session-verifier's `Buffer === 'invalid'` is always false → fail-open), feature-flag string
  // compares, and crashed New Order (`.split` on a Buffer). See the 14-site `decodeRedisString`
  // band-aid that shipped earlier — this is the structural fix that retires the whole class.
  //
  // Fix: on the Sentinel path, derive the buffer client from its OWN dedicated base connection
  // (same `getBaseClient` path → identical Sentinel discovery/failover/auth/socket config) so the
  // poisoning mutation lands on a PRIVATE base that is only ever used in Buffer mode (harmless),
  // leaving the shared serving `client` completely untouched. Cluster + single-node keep the
  // cheap shared derivation — their `withTypeMapping` is side-effect-free, and a cluster client is
  // many sockets, so a second one would double them for no benefit.
  //
  // TODO(upstream): file the RedisSentinel._commandOptionsProxy shared-`_self` mutation bug with
  // node-redis — the correct behavior mirrors RedisClient (proxy-local `_commandOptions`).
  const isSysSentinel = type === 'system' && !!config.sysSentinels;
  let bufferClient: CustomRedisClient<K>;
  // Hoisted so the sys self-heal watchdog below can reconnect this dedicated Buffer-mode base
  // connection alongside the serving one (both feed the aggregate sys inflight counter).
  let sysBufferBaseClient: CustomRedisClient<K> | undefined;
  if (isSysSentinel) {
    const bufferBaseClient = getBaseClient(type) as unknown as CustomRedisClient<K>;
    sysBufferBaseClient = bufferBaseClient;
    // This dedicated connection issues real reads (GET/SMEMBERS/HGET/…) to the SAME sysRedis
    // backend, so instrument it under the same 'sys' label — its in-flight + duration metrics
    // belong alongside `client`'s (dropping them would under-count sysRedis load). Note: this
    // adds one extra sysRedis connection (+ a Sentinel master-pool lease); acceptable per the
    // investigation, and the pool stays small (masterPoolSize 2 in getBaseClient).
    instrumentCommands(bufferBaseClient, 'sys');
    bufferClient = bufferBaseClient.withTypeMapping({
      [RESP_TYPES.BLOB_STRING]: Buffer,
    }) as CustomRedisClient<K>;
  } else {
    bufferClient = client.withTypeMapping({
      [RESP_TYPES.BLOB_STRING]: Buffer,
    }) as CustomRedisClient<K>;
  }

  // Decode a packed Buffer, evicting the bad entry if msgpack fails so the next
  // read falls through to source. Returns null on decode failure, treated as cache miss.
  //
  // This is the GENERAL decode path for EVERY packed read (get/mGet/sMembers/sPop/
  // hGet/hGetAll/hmGet) across ~30 cache writers. It does plain `unpack(value)` only —
  // it deliberately does NOT brotli-decompress, so the 0x01 brotli sentinel is NOT a
  // global invariant on all packed values (a bare msgpack `1` packs to <01> and must
  // decode as the integer 1, not be mistaken for a compressed payload). Brotli
  // decompression is confined to the opt-in compress-aware read path below
  // (`get(key, { compress: true })`) — see ./packed-compression for why the
  // sentinel is provably collision-free THERE (wrapper objects only).
  const safeUnpack = <T>(value: Buffer, evict: () => Promise<unknown>): T | null => {
    try {
      return unpack(value) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Packed unpack failed, evicting bad cache entry: ${msg}`);
      evict().catch((e) =>
        log(`Eviction after unpack failure failed: ${e instanceof Error ? e.message : e}`)
      );
      return null;
    }
  };

  // Compress-aware decode — the SYMMETRIC counterpart of `set(..., { compress: true })`,
  // used ONLY by the opt-in `get(key, { compress: true })` read path (currently just
  // fetchThroughCache's compressed callers, e.g. tensor-metadata full). It awaits the
  // async brotli codec and discriminates on the sentinel byte so a legacy uncompressed
  // value (written before compression was enabled) still decodes: first byte === sentinel
  // → strip + brotli-decompress + unpack; else → unpack as legacy raw. Provably safe HERE
  // (and only here) because every value on this path is the `{ data, cachedAt }` wrapper
  // object whose msgpack first byte is always a MAP marker (0x80–0x8f / 0xde / 0xdf),
  // never 0x01. Preserves safeUnpack's evict-on-failure / fail-open semantics: a
  // decompress/unpack throw is treated as a cache miss (null) and evicts the bad entry.
  const safeUnpackCompressed = async <T>(
    value: Buffer,
    evict: () => Promise<unknown>
  ): Promise<T | null> => {
    try {
      return unpack(await decompressPacked(value)) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Packed (compressed) unpack failed, evicting bad cache entry: ${msg}`);
      evict().catch((e) =>
        log(`Eviction after unpack failure failed: ${e instanceof Error ? e.message : e}`)
      );
      return null;
    }
  };

  client.packed = {
    async get<T>(key: K, packedOptions?: { compress?: boolean }): Promise<T | null> {
      const result = await bufferClient.get<Buffer>(key);
      if (!result) return null;
      // Only the opt-in compress-aware read attempts sentinel-detect + brotli-decompress
      // (symmetric with `set(..., { compress: true })`). Non-compress callers use the
      // general decode path verbatim, so no decompression ever runs for them.
      if (packedOptions?.compress) {
        return safeUnpackCompressed<T>(result, () => client.unlink(key));
      }
      return safeUnpack<T>(result, () => client.unlink(key));
    },

    // Wrapped to avoid CROSSSLOT errors - fetches keys individually with Promise.all
    async mGet<T>(keys: K[]): Promise<(T | null)[]> {
      const results = await Promise.all(keys.map((key) => bufferClient.get<Buffer>(key)));
      return results.map((result, i) =>
        result ? safeUnpack<T>(result, () => client.unlink(keys[i])) : null
      );
    },

    async set<T>(
      key: K,
      value: T,
      options?: SetOptions,
      packedOptions?: { compress?: boolean }
    ): Promise<void> {
      const packed = pack(value);
      // Opt-in brotli (sentinel-tagged), async so the codec runs on the libuv threadpool
      // and never blocks the event loop. The symmetric read is get(key, { compress: true }).
      const payload = packedOptions?.compress ? await compressPacked(packed) : packed;
      await client.set(key, payload, options);
    },

    async setNX<T>(key: K, value: T): Promise<void> {
      await client.setNX(key, pack(value));
    },

    async sAdd<T>(key: K, values: T[]): Promise<void> {
      await client.sAdd(key, values.map(pack));
    },

    async sPop<T>(key: K, count: number): Promise<T[]> {
      const packedValues = await bufferClient.sPop<Buffer>(key, count);
      // sPop already removed each value from the set, so on decode failure we just drop it.
      return packedValues
        .map((value) => safeUnpack<T>(value, () => Promise.resolve()))
        .filter((v): v is T => v !== null);
    },

    async sRemove<T>(key: K, value: T): Promise<void> {
      await client.sRem(key, pack(value));
    },

    async sMembers<T>(key: K): Promise<T[]> {
      const packedValues = await bufferClient.sMembers<Buffer>(key);
      return packedValues
        .map((value) =>
          // node-redis accepts Buffer for sRem; cast through unknown to satisfy the
          // typed wrapper without re-encoding the raw stored bytes.
          safeUnpack<T>(value, () => client.sRem(key, value as unknown as Buffer))
        )
        .filter((v): v is T => v !== null);
    },

    async hGet<T>(key: K, hashKey: string): Promise<T | null> {
      const result = await bufferClient.hGet<Buffer>(key, hashKey);
      if (!result) return null;
      return safeUnpack<T>(result, () => client.hDel(key, hashKey));
    },

    async hGetAll<T>(key: K): Promise<{ [x: string]: T }> {
      const results = await bufferClient.hGetAll<Buffer>(key);
      const out: { [x: string]: T } = {};
      for (const [k, v] of Object.entries(results)) {
        if (!v) continue;
        const decoded = safeUnpack<T>(v, () => client.hDel(key, k));
        if (decoded !== null) out[k] = decoded;
      }
      return out;
    },

    async hSet<T>(key: K, hashKey: string, value: T): Promise<void> {
      await client.hSet(key, hashKey, pack(value));
    },

    async hmSet<T>(key: K, records: Record<string, T>): Promise<void> {
      const packedRecords: Record<string, Buffer> = {};
      for (const [hashKey, value] of Object.entries(records)) {
        packedRecords[hashKey] = pack(value);
      }
      await client.hSet(key, packedRecords);
    },

    async hmGet<T>(key: K, hashKeys: string[]): Promise<(T | null)[]> {
      const results = await bufferClient.hmGet<Buffer>(key, hashKeys);
      return results.map((result, i) =>
        result ? safeUnpack<T>(result, () => client.hDel(key, hashKeys[i])) : null
      );
    },
  };

  client.setNxKeepTtlWithEx = async (key, value, ttl) => {
    const script = `
      if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'KEEPTTL') then
        return redis.call('EXPIRE', KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    const result = await client.eval(script, {
      keys: [key],
      arguments: [value, ttl.toString()],
    });
    return result === 1; // 1 if set, 0 if not set
  };

  client.hSetMultiWithExpire = async (key, fields, ttlSeconds) => {
    // No fields ⇒ nothing to write (and an HSET with no field/value pairs is a Redis error). Skip the
    // round-trip entirely rather than materialize a key with no fields.
    if (fields.length === 0) return 0;
    // HSET (one or more field/value pairs) then EXPIRE, atomically in one EVAL — the key is never
    // observable with fields but no TTL (and never with a TTL but no fields). ARGV[1] is the TTL;
    // ARGV[2..] are the flat [field, value, …] pairs unpacked into HSET. Returns HSET's reply
    // (count of NEWLY-added fields).
    const script = `
      local added = redis.call('HSET', KEYS[1], unpack(ARGV, 2))
      redis.call('EXPIRE', KEYS[1], ARGV[1])
      return added
    `;
    const result = await client.eval(script, {
      keys: [key],
      arguments: [ttlSeconds.toString(), ...fields],
    });
    return Number(result) || 0;
  };

  // Implement scanIterator for cluster - it doesn't exist natively on RedisCluster
  // We need to scan each master node and yield results from all of them
  const baseClient = client as any;

  // Save reference to the original scanIterator (exists on single client, not on cluster)
  const originalScanIterator = baseClient.scanIterator?.bind(baseClient);

  client.scanIterator = async function* (options) {
    // Check if this is a cluster client (has masters property)
    if (baseClient.masters) {
      // Cluster mode: iterate through all master nodes
      const masters = await baseClient.masters;
      for (const master of masters) {
        const nodeClient = await baseClient.nodeClient(master);
        yield* nodeClient.scanIterator(options);
      }
    } else {
      // Single node mode: use original native scanIterator
      yield* originalScanIterator(options);
    }
  };

  // Wrap mGet to avoid CROSSSLOT errors - fetch keys individually
  const originalMGet = baseClient.mGet?.bind(baseClient);
  client.mGet = async function (...args: any[]): Promise<any> {
    const keys = args[0] as K[];
    if (!Array.isArray(keys)) return originalMGet(...args);

    const results = await Promise.all(keys.map((key) => client.get(key)));
    return results;
  };

  // Wrap del to avoid CROSSSLOT errors - delete keys individually when array
  const originalDel = baseClient.del?.bind(baseClient);
  client.del = async function (key: K | K[]): Promise<number> {
    if (!Array.isArray(key)) key = [key];

    const results = await Promise.all(key.map((k) => originalDel(k)));
    return results.reduce((sum, count) => sum + count, 0);
  };

  // Wrap unlink to avoid CROSSSLOT errors - unlink keys individually when array
  const originalUnlink = baseClient.unlink?.bind(baseClient);
  client.unlink = async function (key: K | K[]): Promise<number> {
    if (!Array.isArray(key)) key = [key];

    const results = await Promise.all(key.map((k) => originalUnlink(k)));
    return results.reduce((sum, count) => sum + count, 0);
  };

  // Start the sys (sysRedis / Sentinel) self-heal watchdog ONCE per process (incident 2026-07-03),
  // mirroring the cluster watchdog started in getBaseClient's cluster connect() callback. It
  // reconnects ALL sys base connections when the aggregate sys inflight counter stays wedged: the
  // serving `client` always, plus the dedicated Buffer-mode base on the sentinel path (both feed
  // the counter). The watchdog only samples a counter + reconnects on a wedge, so starting it here
  // (before the background connect() settles) is safe. Guarded by sysSelfHealInterval so re-entry /
  // the buffer-base build can't stack a second interval.
  //
  // SINGLE-SINGLETON INVARIANT — registering only the FIRST getClient('system') set is sufficient
  // because the app builds exactly ONE sys client per process: `createRedisClients` is called once
  // (src/server/redis/client.ts `make()`, memoized — prod evaluates the module const once, dev
  // caches on global.__civitaiRedisClients, build builds nothing), and `createSysRedis` has zero
  // callers (civitai-auth uses createCacheRedis → cache-only). So there is never a second, unwatched
  // sys client. If a future caller builds an ADDITIONAL sys client, this guard would leave it
  // unwatched — revisit the guard (key it per client set) at that point.
  if (type === 'system' && !sysSelfHealInterval) {
    const sysBaseClients: any[] = [client];
    if (sysBufferBaseClient) sysBaseClients.push(sysBufferBaseClient);
    startSysSelfHeal(sysBaseClients);
  }

  return client;
}

function getCacheClient() {
  const client = getClient<RedisKeyTemplateCache>('cache') as CustomRedisClientCache;

  client.purgeTags = async (tag: string | string[]) => {
    const tags = Array.isArray(tag) ? tag : [tag];
    for (const tag of tags) {
      const cacheKey = `${REDIS_KEYS.CACHES.TAGGED_CACHE}:${slugit(tag)}` as const;
      const keys: RedisKeyTemplateCache[] = await client.sMembers(cacheKey);
      await client.del(cacheKey);
      const keyBatches = chunk(keys, 1000);
      for (const keys of keyBatches) await client.del(keys);
    }
  };

  return client;
}

function getSysClient() {
  return getClient<RedisKeyTemplateSys>('system') as CustomRedisClientSys;
}

export type RedisClients = { redis: CustomRedisClientCache; sysRedis: CustomRedisClientSys };

/** The cache / system Redis client instance types (the values `createRedisClients()` returns). Exported
 *  so consumers can hold a lazily-built client in a typed variable without re-declaring its surface. */
export type RedisCacheClient = RedisClients['redis'];
export type RedisSysClient = RedisClients['sysRedis'];

export type CreateRedisClientsOptions = Partial<RedisConfig> & {
  /** Debug logger (app-defined). Defaults to a no-op. */
  log?: RedisLogFn;
  /**
   * App policy resolving whether enhanced cluster failover is enabled for a given
   * Flipt context. Defaults to always-off; the app shim wires the real Flipt call.
   */
  isEnhancedFailoverEnabled?: RedisFailoverResolver;
};

/**
 * Build the cache + system Redis clients. Connection config defaults come from the
 * package env schema (./env, overridable via options); app behavior (logger, failover
 * policy) is injected. HMR/global singleton caching and the Next build guard live in
 * the app shim that calls this. See the `~/server/redis/client` shim.
 */
function applyOptions(options: CreateRedisClientsOptions) {
  const { log: logOption, isEnhancedFailoverEnabled: failoverOption, ...envOverrides } = options;
  config = { ...loadRedisEnv(), ...envOverrides };
  if (logOption) log = logOption;
  if (failoverOption) isEnhancedFailoverEnabled = failoverOption;
}

/**
 * Build ONLY the cache Redis client (no sys client). Prefer this over `createRedisClients().redis` when an
 * app needs just the cache: `createRedisClients` builds AND eagerly connects BOTH clients, so taking one
 * field off it leaks a live connection to the other. Each client is fresh per call — the caller memoizes.
 */
export function createCacheRedis(options: CreateRedisClientsOptions = {}): RedisCacheClient {
  applyOptions(options);
  return getCacheClient();
}

/** Build ONLY the system Redis client (no cache client). The sys-only counterpart to `createCacheRedis`. */
export function createSysRedis(options: CreateRedisClientsOptions = {}): RedisSysClient {
  applyOptions(options);
  return getSysClient();
}

export function createRedisClients(options: CreateRedisClientsOptions = {}): RedisClients {
  applyOptions(options);
  return { redis: getCacheClient(), sysRedis: getSysClient() };
}

// Source of Truth data
export const REDIS_SYS_KEYS = {
  DEVICE: {
    // Per-browser account-switch set — hash `device:accounts:${deviceId}` of userId → lastSwitchedAt.
    ACCOUNTS: 'device:accounts',
  },
  SWAP: {
    // Single-use marker for redeemed cross-domain swap tokens — `swap:used:${jti}` (TTL = swap max age).
    USED: 'swap:used',
  },
  BLOCKS: {
    // Emergency kill list — Redis SET of `block_id` strings BlockRegistry excludes from every
    // listForModel response (disable a runaway block without a deploy).
    EMERGENCY_KILL_LIST: 'system:blocks:emergency-kill-list',
    // Cumulative Buzz-spend cap counter, keyed `system:blocks:buzz-cap:${userId}:${appBlockId}:${day}`.
    BUZZ_CAP: 'system:blocks:buzz-cap',
    // Cumulative TIP-spend cap counter for the block tip endpoint, keyed
    // `system:blocks:tip-cap:${userId}:${UTC-day}`. DISTINCT from BUZZ_CAP: that
    // bounds a user's daily generation SPEND; this bounds a user's daily Buzz
    // TIPPED-OUT through blocks (money to third parties). Per-USER aggregate (no
    // appBlockId) so N installed blocks share ONE daily tip ceiling. INCRBY'd by
    // each tip amount pre-transaction (reserve-and-refund), TTL set on first write.
    TIP_CAP: 'system:blocks:tip-cap',
    /**
     * Per-APP cumulative spend-BOUNTY accrual cap counter (audit 🟡-2 / the
     * App-Blocks Sybil-economics review). DISTINCT from BUZZ_CAP: that one
     * bounds a single USER's daily Buzz SPEND; this one bounds the daily
     * platform-funded BOUNTY (in USD cents) accrued toward a single APP across
     * ALL viewers, so a Sybil ring of many accounts can't funnel unbounded
     * bounty at one author. Integer counter (cents), keyed
     * `system:blocks:bounty-cap:${appBlockId}:${UTC-day}`, INCRBY'd by each
     * row's accrued `app_owner_share_cents` at spend-attribution write time.
     * TTL is set on first write so the per-window key self-expires. DORMANT
     * today: the share is 0 until the payout rail (#2605) flips spendSharePct>0,
     * so the counter never moves and the cap never clamps.
     */
    BOUNTY_CAP: 'system:blocks:bounty-cap',
    /**
     * Per-APP aggregate generation-SPEND + velocity cap counters (G8 — generic
     * per-app safety). DISTINCT from BUZZ_CAP (which bounds a single USER's daily
     * Buzz spend) and from BOUNTY_CAP (which bounds a single APP's daily accrued
     * BOUNTY): this bounds the daily block-initiated generation SPEND (in Buzz)
     * AND the short-window generation VELOCITY funnelled through ONE app across
     * ALL viewers — the hard prerequisite before shareable, spend-driving block
     * apps open to non-mods (a Sybil ring of many accounts each under the per-user
     * cap could otherwise drive unbounded aggregate spend through one app).
     * Two keys, both on `sysRedis`, same atomic INCRBY-with-TTL reserve/refund
     * shape as BUZZ_CAP:
     *   - daily spend:    `system:blocks:app-spend-cap:${appBlockId}:${UTC-day}`
     *                     (INCRBY the Buzz cost, TTL ~25h, self-expiring window)
     *   - rolling gens:   `system:blocks:app-spend-cap:vel:${appBlockId}:${bucket}`
     *                     (INCR 1 per submit over a short fixed window)
     * DEV/live-harness tokens (synthetic appBlockId) are excluded by the caller.
     */
    APP_SPEND_CAP: 'system:blocks:app-spend-cap',
    // Per-API-key (fallback per-IP) rate-limit counter for the token-authed bundle-submit
    // endpoint (`/api/v1/blocks/submit-version`). On sysRedis like the retool limiter + BUZZ_CAP.
    SUBMIT_RATE_LIMIT: 'system:blocks:submit-rate-limit',
    /**
     * Per-user (fallback per-IP) rate-limit counter for the dev/preview
     * block-token mint (`/api/v1/blocks/dev-token`). Same `SET NX EX` + `INCR`
     * MULTI shape as `SUBMIT_RATE_LIMIT` (always created with its TTL), on
     * `sysRedis`. Bounds a mod minting fresh short-lived dev tokens for their
     * local "live" harness.
     */
    DEV_TOKEN_RATE_LIMIT: 'system:blocks:dev-token-rate-limit',
    /**
     * Per-user (fallback per-IP) rate-limit counter for the token-auth
     * self-scoped submission-status read (`/api/v1/blocks/submissions`). Same
     * `SET NX EX` + `INCR` MULTI shape as `SUBMIT_RATE_LIMIT` (always created
     * with its TTL), on `sysRedis`. Bounds a dev polling their own
     * submission/review/deploy status from `civitai app status`.
     */
    SUBMISSIONS_RATE_LIMIT: 'system:blocks:submissions-rate-limit',
    /**
     * Per-user (fallback per-IP) rate-limit counter for the token-auth
     * self-scoped submission WITHDRAW (`/api/v1/blocks/withdraw`). Same
     * `SET NX EX` + `INCR` MULTI shape as `SUBMISSIONS_RATE_LIMIT` (always
     * created with its TTL), on `sysRedis`. Bounds a dev pulling their own
     * pending submission back from review via `civitai app withdraw`. Tighter
     * window than the submissions read since this is a write.
     */
    WITHDRAW_RATE_LIMIT: 'system:blocks:withdraw-rate-limit',
    /**
     * APP DEV TUNNEL — root prefix for the short-TTL dev-tunnel control-plane
     * state (credential index, session record, host/user indexes, per-session
     * spend counter). Sub-keyed as `${DEV_TUNNEL}:cred:<fp>` /
     * `${DEV_TUNNEL}:session:<id>` / `${DEV_TUNNEL}:host:<host>` /
     * `${DEV_TUNNEL}:user:<uid>:<blockId>` / `${DEV_TUNNEL}:spend:<id>`. All
     * carry a hard-TTL EX so they self-expire (dev-tunnel.service.ts). On
     * `sysRedis`, like the sibling BLOCKS caps/limiters.
     */
    DEV_TUNNEL: 'system:blocks:dev-tunnel',
    /**
     * Per-user rate-limit counter for EPHEMERAL (pre-submit) dev-tunnel starts —
     * `startDevTunnel` when the caller owns NO AppBlock row for the slug yet
     * (block-registry.service.ts resolveEphemeralDevPageBlock). Keyed
     * `${DEV_TUNNEL_EPHEMERAL_RATE_LIMIT}:<userId>`. Same `INCR` + first-hit `EX`
     * shape as the sibling BLOCKS limiters, on `sysRedis`. Blunts host-pool
     * enumeration / DoS via ephemeral tunnel starts across many unclaimed slugs;
     * the approved/owned path is unaffected (only the ephemeral branch increments).
     */
    DEV_TUNNEL_EPHEMERAL_RATE_LIMIT: 'system:blocks:dev-tunnel-ephemeral-rate-limit',
    /**
     * App Blocks `customComfy` bridge — per-workflow SETTLE record so a
     * post-paid customComfy job's terminal poll/cancel can refund the
     * declared `maxBuzz` CEILING down to the workflow's REAL accrued cost
     * against BOTH the per-user daily and per-app aggregate reservations.
     * Keyed `${CUSTOM_COMFY_SETTLE}:<workflowId>`, JSON value
     * `{ buzzCapKey, appSpendKey|null, ceiling }`, hard-TTL EX ~25h so it
     * self-expires with the reservation window. Written at submit (after
     * reserving the ceiling), consumed once via GET+DEL at the FIRST terminal
     * observation (idempotent settle). On `sysRedis`, like the sibling BLOCKS
     * caps/limiters. DEV/live-harness tokens still get a per-user daily
     * reservation + settle; the per-app reservation (and its settle key) is
     * absent for them (synthetic appBlockId), matching the txt2img caps.
     */
    CUSTOM_COMFY_SETTLE: 'system:blocks:custom-comfy-settle',
  },
  DOWNLOAD: {
    LIMITS: 'download:limits',
    COUNT: 'download:count',
  },
  GENERATION: {
    LIMITS: 'generation:limits',
    COUNT: 'generation:count',
    STATUS: 'generation:status',
    WORKFLOWS: 'generation:workflows',
    ENGINES: 'generation:engines',
    TOKENS: 'generation:tokens',
    CUSTOM_CHALLENGE: 'generation:custom-challenge',
    BLOCKED_PROMPTS: 'generation:blocked-prompts',
    REMIX_AUDIT_CHECKED: 'generation:remix-audit-checked',
    CLIENT: 'generation:client',
  },
  TRAINING: {
    STATUS: 'training:status',
  },
  CLIENT: 'client',
  SYSTEM: {
    FEATURES: 'system:features',
    PERMISSIONS: 'system:permissions',
    USER_SCORE_MULTIPLIERS: 'system:user-score-multipliers',
    NON_CRITICAL_HEALTHCHECKS: 'non-critical-healthchecks',
    DISABLED_HEALTHCHECKS: 'disabled-healthchecks',
    FEATURE_STATUS: 'system:feature-status',
    BROWSING_SETTING_ADDONS: 'system:browsing-setting-addons',
    CREATION_BLOCKED_TAGS: 'system:creation-blocked-tags',
    LIVE_FEATURE_FLAGS: 'system:live-feature-flags',
    SUSPICIOUS_AUDIT_MATCHES: 'system:suspicious-audit-matches',
    /*
      Runtime toggle for the new image ingestion path (createImageIngestionRequest
      with the expanded mediaRating step). Read by image.service.ts before
      routing to the new vs legacy scanner. Accepts '1'/'true' to enable,
      '0'/'false' to disable. If the key is missing, the first call seeds it to
      'false' so the toggle is discoverable in Redis. Lets ops flip without a
      deploy.
     */
    IMAGE_SCANNER_NEW: 'system:image-scanner-new',
  },
  INDEX_UPDATES: {
    IMAGE_METRIC: 'index-updates:image-metric',
    // Accumulator for models-index re-index requests originating in the
    // per-minute model-metrics job. Flushed into the search-index queue
    // on a 15-min cadence (matches the search-index sync cron) to avoid
    // generating ~15× more re-index work than the consumer can drain.
    MODEL_METRIC_AFFECTED: 'index-updates:model-metric-affected',
    MODEL_METRIC_LAST_FLUSH: 'index-updates:model-metric-last-flush',
  },
  QUEUES: {
    BUCKETS: 'queues:buckets',
    SEEN_IMAGES: 'queues:seen-images',
    USER_CONTENT_REMOVAL: 'queues:user-content-removal',
  },
  RESEARCH: {
    RATINGS_TRACKS: 'research:ratings-tracks-2',
    RATINGS_SANITY_IDS: 'research:ratings-sanity-ids',
  },
  LIMITS: {
    EMAIL_VERIFICATIONS: 'limits:email-verifications',
    HISTORY_DOWNLOADS: 'limits:history-downloads',
    CHAT_MESSAGES: 'limits:chat-messages',
  },
  COUNTERS: {
    EMAIL_VERIFICATIONS: 'counters:email-verifications',
    HISTORY_DOWNLOADS: 'counters:history-downloads',
    CHAT_MESSAGES: 'counters:chat-messages',
  },
  INDEXES: {
    IMAGE_DELETED: 'indexes:image-deleted',
  },
  DAILY_CHALLENGE: {
    CONFIG: 'daily-challenge:config',
  },
  COLLECTION: {
    RANDOM_SEED: 'collection:random-seed',
  },
  EVENT: 'event', // special case
  SESSION: {
    ALL: 'session:all',
    TOKEN_STATE: 'session:token-state',
  },
  JOB: 'job',
  BUZZ_WITHDRAWAL_REQUEST: {
    STATUS: 'buzz-withdrawal-request:status',
  },
  CREATOR_PROGRAM: {
    FLIP_PHASES: 'creator-program:flip-phases',
  },
  NEW_ORDER: {
    EXP: 'new-order:exp',
    FERVOR: 'new-order:fervor',
    BUZZ: 'new-order:blessed-buzz',
    PENDING_BUZZ: 'new-order:pending-buzz',
    RECENTLY_GRANTED_BUZZ: 'new-order:recently-granted-buzz',
    SMITE: 'new-order:smite-progress',
    QUEUES: 'new-order:queues',
    ACTIVE_SLOT: 'new-order:active-slot',
    RATINGS: 'new-order:ratings',
    MATCHES: 'new-order:matches',
    JUDGEMENTS: {
      ALL: 'new-order:judgments:all',
      CORRECT: 'new-order:judgments:correct',
      ACOLYTE_FAILED: 'new-order:judgments:acolyte-failed',
    },
    SANITY_CHECKS: {
      POOL: 'new-order:sanity-checks',
      FAILURES: 'new-order:sanity-failures',
    },
    CONFIG: 'new-order:config',
    PROCESSING: {
      LAST_PROCESSED_AT: 'new-order:processing:last-processed-at',
      BATCH_CUTOFF: 'new-order:processing:batch-cutoff',
      PENDING_COUNT: 'new-order:processing:pending-count',
      LOCK: 'new-order:processing:lock',
    },
  },
  SCANNER_POLICY: {
    /*
      Use: Per-(mode,label) ordered list of candidate IDs.
      Structure: hset, field = `${mode}:${label}` (e.g. 'prompt:Young'),
      value = packed string[] of candidate IDs in display order.
     */
    CANDIDATE_IDS: 'packed:system:scanner-policy:candidate-ids',
    /*
      Use: Candidate payloads keyed by mode + label + id.
      Structure: hset, field = `${mode}:${label}:${id}`,
      value = packed ScannerPolicyCandidate.
     */
    CANDIDATES: 'packed:system:scanner-policy:candidates',
    /*
      Use: Track S3-uploaded dataset workbooks AND result workbooks per
      (mode, label) so the moderator UI can list them for re-download.
      Structure: hset, field = `${mode}:${label}`, value = packed
      DatasetExportRecord[] (most recent first).
     */
    EXPORTS: 'packed:system:scanner-policy:exports',
    /*
      Use: Per-mode system prompt override for the test bench.
      Falls back to the live xguard registry's systemPrompt when unset.
      Structure: hset, field = 'prompt' | 'text', value = packed string.
     */
    SYSTEM_PROMPTS: 'packed:system:scanner-policy:system-prompts',
    /*
      Use: Cooperative cancel flag for an in-progress scoring run. Set to
      '1' by the cancelRun endpoint; the scoring loop reads it between
      rows and exits cleanly when set.
      Structure: string, key = `system:scanner-policy:run-cancel:${runId}`,
      value = '1'. TTL: 1 hour.
     */
    RUN_CANCEL: 'system:scanner-policy:run-cancel',
    /*
      Use: Per-run frozen metadata (dataset, candidates, rows, baseline,
      systemPrompt snapshot) referenced by the callback webhook. Each run
      has its own keyed copy.
      Structure: packed JSON, key = `packed:system:scanner-policy:run-state:${runId}`.
      TTL: 24 hours.
     */
    RUN_STATE: 'packed:system:scanner-policy:run-state',
    /*
      Use: Per-run results accumulator written by the callback webhook.
      Field = `${rowIdx}:${candidateId}`, value = packed ScoredResultRow.
      Structure: hash, key = `packed:system:scanner-policy:run-results:${runId}`.
      TTL: 24 hours.
     */
    RUN_RESULTS: 'packed:system:scanner-policy:run-results',
    /*
      Use: Atomic counter for completed results. Incremented by the callback
      webhook; finalization fires when value == expected total.
      Structure: integer string, key = `system:scanner-policy:run-counter:${runId}`.
      TTL: 24 hours.
     */
    RUN_COUNTER: 'system:scanner-policy:run-counter',
  },
  ENTITY_MODERATION: {
    // hset
    BASE: 'system:entity-moderation',
    KEYS: {
      /*
        Use: Specify a default policy and an optional override for each entity.
        Structure: json ({"default": string, "overrides": { EntityType?: string } })
       */
      CLAVATA_POLICIES: 'clavata-policies',
      /*
        Use: Disable certain entities from running.
        Structure: json ({ EntityType?: false })
       */
      ENTITIES: 'entities',
      /*
        Use: Toggle the wordlist check.
        Structure: boolean
       */
      RUN_WORDLISTS: 'run-wordlists',
      /*
        Use: Specify which wordlists to use.
        Structure: json (string[])
       */
      WORDLISTS: 'wordlists',
      /*
        Use: Specify which urllists to use.
        Structure: json (string[])
       */
      URLLISTS: 'urllists',
    },
    WORDLISTS: {
      // hset, dynamic keys with packed string[]
      WORDS: 'packed:system:entity-moderation:words',
      // hset, dynamic keys with packed string[]
      URLS: 'packed:system:entity-moderation:urls',
    },
  },
  CONTENT: {
    /*
      Use: Store markdown content for region restrictions and other warnings
      Structure: hset with content keys and markdown string values
      Example: 'region-warning:GB' -> markdown content
     */
    REGION_WARNING: 'system:content:region-warning',
  },
  CACHES: {
    IMAGE_EXISTS: 'feed:image:exists',
  },
  WEBHOOKS: {
    MODEL_FILE_SCAN_PROCESSED: 'webhooks:model-file-scan:processed',
  },
  RETOOL_ENDPOINT: {
    RATE_LIMIT: 'retool-endpoint:rate-limit',
  },
} as const;

// Cached data
export const REDIS_KEYS = {
  BLOCKS: {
    REGISTRY: 'packed:caches:block-registry',
    TOKEN_RATE_LIMIT: 'blocks:token-rate-limit',
    // Per-blockInstanceId revocation marker (15-min TTL); block-scope middleware 403s when present.
    REVOKED_INSTANCE: 'blocks:revoked-instance',
    // Per-ecosystem-key most-popular-Checkpoint cache (JSON ValidatedCheckpoint, 1h TTL).
    POPULAR_CHECKPOINT: 'blocks:popular-checkpoint',
  },
  DOWNLOAD: {
    COUNT: 'download:count',
  },
  USER: {
    BASE: 'user',
    SESSION: 'session:data2',
    CACHE: 'packed:user',
    SETTINGS: 'user:settings',
  },
  EMAIL_VERIFICATION: 'email:verification',
  SESSION: {
    USER_TOKENS: 'session:user-tokens2',
  },
  BUZZ_EVENTS: 'buzz-events',
  GENERATION: {
    RESOURCE_DATA: 'packed:generation:resource-data-3',
    TOKENS: 'generation:tokens',
    COUNT: 'generation:count',
    BLOCKED_PROMPTS: 'generation:blocked-prompts',
    QUERIED_WORKFLOWS: 'packed:generation:queried-workflows',
  },
  OAUTH: {
    AUTHORIZATION_CODES: 'packed:oauth:authorization-codes',
    DEVICE_CODES: 'packed:oauth:device-codes',
    DEVICE_USER_CODES: 'packed:oauth:device-user-codes',
    OIDC_CONTEXT: 'packed:oauth:oidc-context',
  },
  SYSTEM: {
    MODERATED_TAGS: 'packed:system:moderated_tags',
    TAG_RULES: 'system:tag-rules',
    SYSTEM_TAGS: 'system:tags',
    TAGS_NEEDING_REVIEW: 'system:tags-needing-review',
    TAGS_BLOCKED: 'system:tags-blocked',
    HOME_EXCLUDED_TAGS: 'system:home-excluded-tags',
    BLOCKLIST: 'system:blocklist',
    PROMPT_ALLOWLIST: 'packed:system:prompt-allowlist',
    NOTIFICATION_COUNTS: 'system:notification-counts',
    CATEGORIES: 'system:categories',
    BLOCKED_BROWSING_TAGS: 'system:blocked-browsing-tags',
  },
  CACHES: {
    ECOSYSTEM_SEO: 'packed:caches:ecosystem-seo',
    FILES_FOR_MODEL_VERSION: 'packed:caches:files-for-model-version-2',
    MULTIPLIERS_FOR_USER: 'packed:caches:multipliers-for-user',
    TAG_IDS_FOR_IMAGES: 'packed:caches:tag-ids-for-images',
    USER_COSMETICS: 'packed:caches:user-cosmetics',
    COSMETICS_OLD: 'packed:caches:cosmetics',
    COSMETICS: 'packed:caches:cosmetics2',
    PROFILE_PICTURES: 'packed:caches:profile-pictures',
    IMAGES_FOR_MODEL_VERSION: 'packed:caches:images-for-model-version-2',
    EDGE_CACHED: 'packed:caches:edge-cache',
    TAGGED_CACHE: 'packed:caches:tagged-cache',
    DATA_FOR_MODEL: 'packed:caches:data-for-model',
    PUBLIC_MODEL_RESPONSE: 'packed:caches:public-model-response',
    BLOCKED_USERS: 'packed:caches:blocked-users',
    BLOCKED_BY_USERS: 'packed:caches:blocked-by-users',
    BASIC_USERS: 'packed:caches:basic-users',
    BASIC_TAGS: 'packed:caches:basic-tags',
    BASIC_TAGS_BY_NAME: 'packed:caches:basic-tags-by-name',
    ENTITY_AVAILABILITY: {
      MODEL_VERSIONS: 'packed:caches:entity-availability:model-versions',
    },
    OVERVIEW_USERS: 'packed:caches:overview-users',
    FEATURED_MODELS: 'packed:featured-models-2',
    OFFICIAL_MODELS: 'packed:caches:official-models',
    HOME_BLOCKS_PERMANENT: 'packed:caches:home-blocks-permanent',
    IMAGE_META: 'packed:caches:image-meta',
    IMAGE_METADATA: 'packed:caches:image-metadata',
    ANNOUNCEMENTS: 'packed:caches:announcement',
    THUMBNAILS: 'packed:caches:thumbnails',
    IMAGE_METRICS: 'packed:caches:image-metrics',
    ARTICLE_STATS: 'packed:caches:article-stats',
    POST_STATS: 'packed:caches:post-stats',
    USER_FOLLOWS: 'packed:caches:user-follows',
    MODEL_TAGS: 'packed:caches:model-tags',
    MODEL_VOTABLE_TAGS: 'packed:caches:model-votable-tags',
    MODEL_VERSION_PUBLIC_DONATION_GOALS: 'packed:caches:model-version-public-donation-goals',
    IMAGE_TAGS: 'packed:caches:image-tags',
    MODEL_VERSION_RESOURCE_INFO: 'packed:caches:model-version-resource-info',
    TENSOR_METADATA: 'packed:caches:tensor-metadata',
    TENSOR_METADATA_SUMMARY: 'packed:caches:tensor-metadata-summary',
    IMAGE_RESOURCES: 'packed:caches:image-resources',
    USER_DOWNLOADS: 'packed:caches:user-downloads:v2',
    MOD_RULES: {
      MODELS: 'packed:caches:mod-rules:models',
      IMAGES: 'packed:caches:mod-rules:images',
    },
    RESOURCE_OVERRIDES: 'packed:caches:resource-overrides',
    NEW_ORDER: {
      RANKS: 'new-order:ranks',
      RATE_LIMIT: {
        MINUTE: 'new-order:rate-limit:minute',
        HOUR: 'new-order:rate-limit:hour',
        DAY: 'new-order:rate-limit:day',
        COOLDOWN: 'new-order:rate-limit:cooldown',
      },
    },
    TOP_EARNERS: 'packed:caches:top-earners',
    SUPPORTED_CRYPTO_CURRENCIES: 'packed:caches:supported-crypto-currencies',
    CRYPTO_CONVERSION_RATE: 'packed:caches:crypto-conversion-rate',
    CRYPTO_MIN_AMOUNT: 'packed:caches:crypto-min-amount',
    TAG_PAGE_SEO: 'packed:caches:tag-page-seo',
    // Per-tag-name lookup backing `tag.getTagWithModelCount` (the tag page's
    // id/name/unfeatured resolve). ~2.5M calls/peak of a near-static citext row
    // read; keyed by the lowercased tag name (mirrors citext case-insensitivity),
    // positive results only (unknown names stay uncached so a new tag is findable
    // immediately), busted on tag delete. See `getTagWithModelCount` in tag.service.
    TAG_WITH_MODEL_COUNT: 'packed:caches:tag-with-model-count',
    // Total-creators count for the v1 /api/v1/creators pagination metadata. The
    // underlying dbRead.user.count scans the whole ~892k-row Model table on every
    // call (~1174ms in EXPLAIN ANALYZE); the total is a slowly-moving aggregate so
    // a few-minutes-stale value in totalItems/totalPages is harmless.
    CREATORS_COUNT: 'packed:caches:creators-count',
    // The user-independent active-auction list backing `auction.getAll` (~21.8
    // calls/s at peak, hitting the PRIMARY DB `dbWrite`). Output is a single global
    // `{ id, auctionBase, lowestBidRequired }[]` with no per-user/ctx variance, so
    // one global key serves everyone. Short TTL (30s), no bust: the set is time-
    // windowed (startAt<=now<endAt, transitions bounded to <=30s) and the frequently-
    // mutating input is bids (each shifts lowestBidRequired) — busting per-bid at
    // ~21/s would defeat the cache, and a slightly-stale lowestBidRequired is display-
    // only (bid submission re-validates the true minimum server-side). See
    // `getAllAuctions` in auction.service.
    ACTIVE_AUCTIONS: 'packed:caches:active-auctions',
    // url -> {id, url, hideMeta} lookup backing the internal image-delivery endpoint
    // (`/api/internal/image-delivery/[id]`, ~9.2 req/s at peak). The near-immutable
    // `Image WHERE url = $1` single-row read is the highest-volume DB query in the
    // profile. Keyed by the EXACT url (case/whitespace-sensitive — the WHERE key is not
    // normalized), positive results only (an unknown url stays uncached so a newly
    // registered image resolves immediately), busted when `hideMeta` flips in
    // updatePostImage. See `getCachedImageDeliveryMetadata` in image-delivery.service.
    IMAGE_DELIVERY_METADATA: 'packed:caches:image-delivery-metadata',
    // Per-user `id -> isValidCreatorMember(boolean)` for the read-time metric-privacy /
    // donation-goal hide gate (#3266). Near-static per user; both TRUE and FALSE are
    // cached (the resolver is a total function over the id). Busted on any subscription
    // change via `invalidateSubscriptionCaches`; TTL backstops the non-webhook paths.
    // See `getValidCreatorMembershipMap` in creator-membership.service.
    CREATOR_MEMBERSHIP_VALID: 'packed:caches:creator-membership-valid',
    // Per-user `id -> { hideModelBuzz, hideModelDownloads, hideModelGenerations }` — the
    // three model-metric-privacy DEFAULT flags read off `User.settings` at read time
    // (#3266). A tiny derived slice so the hot model-read paths (feed / v1 list /
    // associated) never fetch + synchronously deserialize the FULL `settings` blob per
    // owner per request just to read three booleans. Busted on any settings write via
    // `setUserSetting`; `CacheTTL.md` backstops any other writer. See
    // `getUserMetricPrivacyDefaultsMap` in creator-membership.service.
    USER_METRIC_PRIVACY_DEFAULTS: 'packed:caches:user-metric-privacy-defaults',
  },
  RESEARCH: {
    RATINGS_COUNT: 'research:ratings-count',
    RATINGS_PROGRESS: 'research:ratings-progress',
  },
  COUNTERS: {
    REDEMPTION_ATTEMPTS: 'counters:redemption-attempts',
    EMAIL_VERIFICATIONS: 'counters:email-verifications',
    HISTORY_DOWNLOADS: 'counters:history-downloads',
    BUG_REPORTS: 'counters:bug-reports',
  },
  LIVE_NOW: 'live-now',
  TAG: 'tag',
  EVENT: {
    BASE: 'event', // special case
    EVENT_CLEANUP: 'eventCleanup',
    CACHE: 'packed:event',
  },
  COSMETICS: {
    IDS: 'cosmeticIds',
  },
  TRPC: {
    BASE: 'packed:trpc',
    LIMIT: {
      BASE: 'packed:trpc:limit',
      KEYS: 'packed:trpc:limit:keys',
    },
  },
  MODEL: {
    GALLERY_SETTINGS: 'model:gallery-settings',
  },
  LAG_HELPER: 'lag-helper',
  HOLIDAY: {
    '2023': {
      BASE: 'holiday2023',
      CACHE: 'packed:holiday2023',
    },
    '2024': {
      BASE: 'holiday2024',
      CACHE: 'packed:holiday2024',
    },
  },
  BEEHIIV: {
    NEWSLETTER: 'newsletter',
  },
  HOMEBLOCKS: {
    BASE: 'packed:home-blocks',
    FEATURED_COLLECTIONS_STATE: 'home-blocks:featured-collections:state',
    FEATURED_COLLECTIONS_LAST_PICKED: 'home-blocks:featured-collections:last-picked',
  },
  CACHE_LOCKS: 'cache-lock',
  BUZZ: {
    POTENTIAL_POOL: 'buzz:potential-pool',
    POTENTIAL_POOL_VALUE: 'buzz:potential-pool-value',
    EARNED: 'buzz:earned',
  },
  CREATOR_PROGRAM: {
    CAPS: 'packed:caches:creator-program:caps',
    CASH: 'packed:caches:creator-program:cash',
    BANKED: 'packed:caches:creator-program:banked',
    PREV_MONTH_STATS: 'packed:caches:creator-program:prev-month-stats',
    POOL_VALUE: 'packed:caches:creator-program:pool-value',
    POOL_SIZE: 'packed:caches:creator-program:pool-size',
    POOL_FORECAST: 'packed:caches:creator-program:pool-forecast',
  },
  NEW_ORDER: {
    RATED: 'new-order:rated',
  },
  QUEUES: {
    SEEN_IMAGES: 'queues:recent-images',
  },
  ARTICLE: {
    SCAN_UPDATE: 'article:scan-update',
    RESCAN: 'article:rescan',
    RATING_REVIEW_RATE_LIMIT: 'article:nsfw-review-rate',
  },
} as const;

// These are used as subkeys after a dynamic key, such as `user:13:stuff`
// we should probably be flipping all redis keys to have any dynamic keys come at the end
export const REDIS_SUB_KEYS = {
  USER: {
    MODEL_ENGAGEMENTS: 'model-engagements', // cache
    PRIVATE_ENTITY_ACCESS: 'private-entity-access', // cache
  },
  EVENT: {
    COSMETICS: 'cosmetics', // cache
    CONTRIBUTORS: 'contributors', // sys
    PARTNERS: 'partners', // sys
    ADD_ROLE: 'add-role', // sys
    MANUAL_ASSIGNMENTS: 'manual-assignments', //sys
    DISCORD_ROLES: 'discord-roles', // sys
  },
  QUEUES: {
    MERGING: 'merging', // sys
  },
} as const;
