import chunk from 'lodash-es/chunk';
import { pack, unpack } from 'msgpackr';
import type { RedisClientType, SetOptions } from 'redis';
import { createClient, createCluster, createSentinel } from 'redis';
import { RESP_TYPES } from 'redis';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { createLogger } from '~/utils/logging';
import { slugit } from '~/utils/string-helpers';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { withCommandDeadline } from '~/server/redis/command-deadline';
import { withClusterRoutingRetry } from '~/server/redis/cluster-routing-retry';
import { ClusterSelfHealWatchdog } from '~/server/redis/cluster-selfheal';
import type { ClusterSelfHealTrigger } from '~/server/redis/cluster-selfheal';
import {
  decClusterInflight,
  getClusterInflight,
  incClusterInflight,
  resetClusterInflight,
} from '~/server/redis/cluster-inflight';
import {
  countClusterDeadlineHits,
  recordClusterDeadlineHit,
  resetClusterDeadlineHits,
} from '~/server/redis/cluster-deadline-hits';
import { compressPacked, decompressPacked } from '~/server/redis/packed-compression';
// NOTE: do NOT statically import the redis prom metrics from '~/server/prom/client'.
// This module is client-bundle-reachable (`_app.tsx` → `system-cache.ts` → here),
// and prom-client eagerly requires `fs`/`cluster` at module load (defaultMetrics +
// cluster aggregator), which the pages-router client webpack build cannot resolve
// → "Module not found: Can't resolve 'cluster'/'fs'". The metrics are defined and
// registered server-side in `~/server/prom/client` and published on `globalThis`
// (`__civitaiRedisMetrics`); `instrumentCommands` and the sentinel listener attach
// read that handle at runtime (server-only). See getRedisMetrics() below.

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
  withTypeMapping(mapping: Record<number, any>): any;
}

interface CustomRedisClientCache extends CustomRedisClient<RedisKeyTemplateCache> {
  purgeTags: (tag: string | string[]) => Promise<void>;
}
// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface CustomRedisClientSys extends CustomRedisClient<RedisKeyTemplateSys> {}

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalRedis: CustomRedisClientCache | undefined;
  // eslint-disable-next-line no-var, vars-on-top
  var globalSysRedis: CustomRedisClientSys | undefined;
}

const log = createLogger('redis', 'green');

// Track topology refresh intervals for cleanup
const clusterRefreshIntervals = new Map<string, ReturnType<typeof setInterval>>();

// In-process count of in-flight CLUSTER commands lives in `./cluster-inflight` so EVERY
// mutation goes through a single floored helper (the counter can never go negative — see
// FIX #2 there). instrumentCommands inc/decs it in lockstep with the
// redis_commands_inflight{client="cluster"} gauge — the same signal the gauge exposes, read
// locally (the prom-client Gauge doesn't cheaply surface its value) so the self-heal watchdog
// (FIX #1) can sample it without a prom dependency. (The sys client uses 'sys' and is NOT
// tracked — the watchdog only ever acts on the cluster client.)

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
      enabled: env.REDIS_CLUSTER_SELFHEAL_ENABLED,
      inflightThreshold: env.REDIS_CLUSTER_SELFHEAL_INFLIGHT_THRESHOLD,
      sustainedMs: env.REDIS_CLUSTER_SELFHEAL_SUSTAINED_MS,
      cooldownMs: env.REDIS_CLUSTER_SELFHEAL_COOLDOWN_MS,
      deadlineHitThreshold: env.REDIS_CLUSTER_SELFHEAL_DEADLINE_HIT_THRESHOLD,
      deadlineHitWindowMs: env.REDIS_CLUSTER_SELFHEAL_DEADLINE_HIT_WINDOW_MS,
      reconnectJitterMs: env.REDIS_CLUSTER_SELFHEAL_RECONNECT_JITTER_MS,
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
        getRedisMetrics()?.redisSelfHealReconnectCounter?.inc({ trigger });
        log(
          `Cluster self-heal RECONNECT fired [trigger=${trigger}, inflight=${inflightAtTrigger}, inflightThreshold=${env.REDIS_CLUSTER_SELFHEAL_INFLIGHT_THRESHOLD}, sustainedMs=${env.REDIS_CLUSTER_SELFHEAL_SUSTAINED_MS}, deadlineHitThreshold=${env.REDIS_CLUSTER_SELFHEAL_DEADLINE_HIT_THRESHOLD}, deadlineHitWindowMs=${env.REDIS_CLUSTER_SELFHEAL_DEADLINE_HIT_WINDOW_MS}]`
        );
      },
    }
  );

  if (!env.REDIS_CLUSTER_SELFHEAL_ENABLED) {
    log('Cluster self-heal watchdog DISABLED (REDIS_CLUSTER_SELFHEAL_ENABLED=false)');
    return watchdog;
  }

  const interval = Math.max(250, env.REDIS_CLUSTER_SELFHEAL_CHECK_INTERVAL_MS);
  clusterSelfHealInterval = setInterval(() => {
    try {
      watchdog.tick();
    } catch (err) {
      log(`Cluster self-heal tick error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, interval);
  // Don't keep the event loop alive for the watchdog on a graceful process exit.
  clusterSelfHealInterval.unref?.();
  log(
    `Cluster self-heal watchdog ENABLED [inflightThreshold=${env.REDIS_CLUSTER_SELFHEAL_INFLIGHT_THRESHOLD}, sustainedMs=${env.REDIS_CLUSTER_SELFHEAL_SUSTAINED_MS}, deadlineHitThreshold=${env.REDIS_CLUSTER_SELFHEAL_DEADLINE_HIT_THRESHOLD}, deadlineHitWindowMs=${env.REDIS_CLUSTER_SELFHEAL_DEADLINE_HIT_WINDOW_MS}, reconnectJitterMs=${env.REDIS_CLUSTER_SELFHEAL_RECONNECT_JITTER_MS}, cooldownMs=${env.REDIS_CLUSTER_SELFHEAL_COOLDOWN_MS}, checkMs=${interval}]`
  );
  return watchdog;
}

/**
 * Attach `topology-change` and `client-error` listeners to a Sentinel client.
 *
 * Extracted so it can be unit-tested without booting the full redis-client
 * module (which pulls in prom/db init). Both listeners destructure
 * event.node.{host,port} into a square-bracketed key/value list so Loki regex
 * can extract per-pod identifiers, and increment per-event Prometheus counters
 * labeled {type, host, deployment}.
 *
 * `deployment` is the running pod's HOSTNAME env (matches Prometheus's `pod`
 * label); falls back to 'unknown' off-cluster.
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
      `Redis sentinel sub-client error [type=${eventType ?? 'unknown'}, host=${host}, port=${port}]`,
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
 * Parse cluster node URLs from environment variable.
 * Falls back to single URL if REDIS_CLUSTER_NODES is not set.
 */
function parseClusterNodes(fallbackUrl: string): { url: string }[] {
  if (env.REDIS_CLUSTER_NODES) {
    const nodes = env.REDIS_CLUSTER_NODES.split(',')
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

function getBaseClient(type: 'cache' | 'system') {
  log(`Creating Redis client (${type})`);

  const REDIS_URL = type === 'system' ? env.REDIS_SYS_URL : env.REDIS_URL;
  const url = new URL(REDIS_URL);
  const connectionUrl = `${url.protocol}//${url.host}`;

  // socketTimeout is scoped PER client kind. The CLUSTER (cache) client carries the
  // 504-cascade structural fix — a silent half-open there parks every request handler.
  // The SYSTEM client is single-node + mostly idle; applying the same aggressive 10s
  // teardown to it (against the flaky single-replica sysRedis backend, which doesn't
  // cleanly complete the TCP close) converted a transient half-open into a reconnect
  // storm that ACCUMULATES half-closed sockets and wedged /api/health for hours. So the
  // sys client uses REDIS_SYS_SOCKET_TIMEOUT_MS (default 0 = disabled → pre-#2556
  // self-healing); the cache client keeps REDIS_SOCKET_TIMEOUT_MS.
  const socketTimeoutMs =
    type === 'system' ? env.REDIS_SYS_SOCKET_TIMEOUT_MS : env.REDIS_SOCKET_TIMEOUT_MS;

  // Two coupled guards on the SYSTEM client (both system-only; the cache client keeps
  // node-redis defaults — its socketTimeout tears the socket down and flushes the queue):
  //
  // 1. commandsQueueMaxLength — with socketTimeoutMs=0, a SILENT half-open is only
  //    cleared by OS TCP keepalive (minutes), during which written-but-unanswered
  //    commands pile in the reply queue. The cap fast-fails new commands once wedged
  //    (the fail-open callers catch it) so the heap can't grow unbounded toward OOM.
  // 2. disableOfflineQueue — while the socket is RECONNECTING (not ready), node-redis
  //    would otherwise buffer commands in its offline write queue. Under sustained authed
  //    load that buffer fills before the reconnect handshake (HELLO/AUTH/SELECT) can
  //    enqueue — and the handshake goes through the SAME bounded queue — starving
  //    recovery → a PERMANENT wedge. Rejecting offline commands immediately
  //    (ClientOfflineError → fail-open) keeps the write queue empty so the handshake
  //    always has room. Together: bounded heap on a half-open AND guaranteed recovery.
  const isSystem = type === 'system';
  const commandsQueueMaxLength =
    isSystem && env.REDIS_SYS_COMMANDS_QUEUE_MAX_LENGTH > 0
      ? env.REDIS_SYS_COMMANDS_QUEUE_MAX_LENGTH
      : undefined;

  // Shared configuration
  const socketConfig = {
    reconnectStrategy(retries: number) {
      log(`Redis reconnecting, retry ${retries}`);
      return Math.min(retries * 100, 3000);
    },
    connectTimeout: env.REDIS_TIMEOUT,
    // Socket-level inactivity guard. node-redis maps this to net.Socket.setTimeout,
    // an IDLE timer that fires when NO read OR write happens for this long (any
    // command write or received reply resets it — verified against @redis/client@5.8.3
    // + a real redis-server), then destroys the socket with a SocketTimeoutError and
    // triggers the reconnectStrategy above.
    // This is the structural fix for the 504 cascade: on a SILENT half-open
    // connection (pod reschedule/failover, no RST/FIN) the in-flight command is PARKED
    // in the node-redis queue and blocks every subsequent write (incl. the keepalive
    // PING), so the idle timer runs to completion and tears the dead socket down in
    // ~REDIS_SOCKET_TIMEOUT_MS instead of waiting ~30s for OS TCP keepalive (= Traefik
    // ceiling = 504); parked commands then reject promptly and the client reconnects.
    // On a HEALTHY idle socket the keepalive PING (pingInterval, derived below) writes
    // every interval and keeps this timer reset, so it does NOT spuriously fire.
    // Tunable via REDIS_SOCKET_TIMEOUT_MS (cache) / REDIS_SYS_SOCKET_TIMEOUT_MS
    // (system); 0/unset disables it (the system default is 0 — see socketTimeoutMs).
    ...(socketTimeoutMs > 0 ? { socketTimeout: socketTimeoutMs } : {}),
  };

  const authConfig = {
    username: url.username === '' ? undefined : url.username,
    password: url.password,
  };

  // Keepalive PING interval. node-redis issues a PING every interval ONLY when the
  // socket is otherwise idle (a parked/in-flight command blocks it from being written),
  // and each PING is a write+reply that resets the socketTimeout idle timer — so it
  // keeps a HEALTHY idle socket alive while a genuinely half-open socket (parked command
  // blocks the PING) still trips socketTimeout. The INVARIANT pingInterval < socketTimeout
  // is what prevents a healthy idle socket from spuriously firing socketTimeout. We CLAMP
  // to min(env, socketTimeout/2) so the invariant holds even if REDIS_PING_INTERVAL_MS is
  // mis-set >= socketTimeout. When socketTimeout is disabled (0) there is no idle timer
  // to keep reset, so we just honor the configured ping interval. (socketTimeoutMs is
  // the per-client-kind value derived above — sys defaults to 0/disabled.)
  const pingInterval =
    socketTimeoutMs > 0
      ? Math.min(env.REDIS_PING_INTERVAL_MS, Math.floor(socketTimeoutMs / 2))
      : env.REDIS_PING_INTERVAL_MS;
  log(
    `Redis ping interval (${type}) = ${pingInterval}ms (env REDIS_PING_INTERVAL_MS=${env.REDIS_PING_INTERVAL_MS}, socketTimeout=${socketTimeoutMs}ms)`
  );

  // System redis is always a single node (or — when REDIS_SYS_SENTINELS is set —
  // a Sentinel-discovered HA topology). See claudedocs/sysredis-ha-migration-runbook.md.
  // Cache redis can be either cluster or single node based on env.REDIS_CLUSTER
  const isCluster = type === 'cache' && env.REDIS_CLUSTER;
  const isSysSentinel = type === 'system' && !!env.REDIS_SYS_SENTINELS;

  const baseClient = isSysSentinel
    ? createSentinel({
        // Non-null assertion is safe: server-schema's superRefine rejects boot
        // when REDIS_SYS_SENTINELS is set without REDIS_SYS_SENTINEL_NAME.
        name: env.REDIS_SYS_SENTINEL_NAME!,
        sentinelRootNodes: env.REDIS_SYS_SENTINELS!.split(',').map((hp) => {
          const [host, port] = hp.trim().split(':');
          return { host, port: parseInt(port ?? '26379', 10) };
        }),
        nodeClientOptions: {
          // Reuse the password that's already extracted from REDIS_SYS_URL —
          // the new HA cluster is provisioned with the same secret.
          password: authConfig.password,
          socket: socketConfig,
          // Match the standalone path's PING heartbeat. Sentinel sub-clients
          // are long-lived against each master/replica pod; without this, an
          // idle connection through any intermediate LB or rolling-update of a
          // sentinel pod can silently expire.
          pingInterval,
        },
        sentinelClientOptions: env.REDIS_SYS_SENTINEL_PASSWORD
          ? { password: env.REDIS_SYS_SENTINEL_PASSWORD, socket: socketConfig }
          : { socket: socketConfig },
        // Pool size 2 (not 1) so the periodic PING heartbeat can run on a
        // separate TCP connection from in-flight writes. With pool size 1, a
        // slow EVAL (see PR #2332's atomic helper) head-of-line blocks the
        // heartbeat, which can trip the kubelet readiness probe during normal
        // load spikes.
        masterPoolSize: 2,
        replicaPoolSize: 0,
        scanInterval: 10_000,
        // Keep sub-client errors local — surfacing them here would flood the
        // top-level `error` listener whenever a single sentinel/replica pod
        // flaps. We log them explicitly via the `client-error` listener below.
        passthroughClientErrorEvents: false,
        reserveClient: false,
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

  // Common event handlers (note: cluster clients don't emit connect/ready events in node-redis v4.x)
  baseClient.on('error', (err: Error) => log(`Redis Error (${type})`, err));
  baseClient.on('connect', () => log(`Redis connected (${type})`));
  baseClient.on('reconnecting', () => log(`Redis reconnecting (${type})`));
  baseClient.on('ready', () => log(`Redis ready! (${type})`));

  // Sentinel clients don't emit connect/reconnecting/ready — they expose
  // topology-change (master/replica/sentinel set changed) and client-error
  // (a sub-client errored). Surface both so failovers are visible in Loki and
  // queryable per-pod, and increment Prometheus counters alongside so Grafana
  // can graph + alert. See attachSysSentinelListeners for the log/label shape.
  if (isSysSentinel) {
    // Look up the counters via the globalThis bridge instead of a static import
    // — prom-client requires fs/cluster which breaks the client webpack bundle.
    // By the time getBaseClient runs at server startup, '~/server/prom/client'
    // has already loaded and populated the bridge. Fall back to no-op stubs in
    // the off-chance the bridge isn't populated yet (logs still flow to Loki).
    const metrics = getRedisMetrics();
    const noopCounter = { labels: () => ({ inc: () => undefined }) };
    attachSysSentinelListeners(baseClient, {
      // process.env.HOSTNAME is the pod name in Kubernetes (matches the
      // Prometheus `pod` label). Fall back to 'unknown' off-cluster.
      deployment: process.env.HOSTNAME ?? 'unknown',
      log,
      topologyCounter: metrics?.sysredisSentinelTopologyChangesCounter ?? noopCounter,
      errorCounter: metrics?.sysredisSentinelClientErrorsCounter ?? noopCounter,
    });
  }

  // Cluster-specific event handlers for failover detection
  // Enhanced failover handling is gated behind FLIPT_FEATURE_FLAGS.REDIS_CLUSTER_ENHANCED_FAILOVER
  // The flag uses the "is-next" segment (hostname == next.civitai.com) to enable by default on next
  if (isCluster) {
    // Extract hostname for Flipt context (used for segment matching)
    const getFliptHostname = (): string => {
      try {
        // NEXTAUTH_URL contains the full URL like https://next.civitai.com
        const nextAuthUrl = env.NEXTAUTH_URL;
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
    if (env.FLIPT_DEPLOYMENT_ID) fliptContext.deploymentId = env.FLIPT_DEPLOYMENT_ID;
    log(
      `Flipt context for enhanced failover flag: hostname=${fliptHostname}, deploymentId=${
        env.FLIPT_DEPLOYMENT_ID ?? 'unset'
      }`
    );

    // Helper to check feature flag before triggering rediscovery
    const maybeRediscover = async (reason: string) => {
      const isEnhancedFailoverEnabled = await isFlipt(
        FLIPT_FEATURE_FLAGS.REDIS_CLUSTER_ENHANCED_FAILOVER,
        'redis-cluster', // entityId
        fliptContext // context for segment matching
      );
      if (isEnhancedFailoverEnabled) {
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
        const isEnhancedFailoverEnabled = await isFlipt(
          FLIPT_FEATURE_FLAGS.REDIS_CLUSTER_ENHANCED_FAILOVER,
          'redis-cluster', // entityId
          fliptContext // context for segment matching
        );

        if (!isEnhancedFailoverEnabled) {
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
          env.REDIS_CLUSTER_REFRESH_INTERVAL
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

/**
 * Wrap the per-client command chokepoint so EVERY command is counted in the
 * `redis_commands_inflight` gauge and timed into `redis_command_duration_seconds`.
 *
 * The chokepoint differs by client kind (verified against @redis/client@5.8.3):
 *  - SINGLE client (sysRedis): typed methods (`get`/`hGetAll`/`set`/...) →
 *    `_executeCommand` → `this.sendCommand`. Wrap `sendCommand` on `_self`.
 *  - CLUSTER client (cache): typed methods route through `this._self._execute(...)`,
 *    NOT the cluster's top-level `sendCommand` (that's only for keyless commands).
 *    `_execute` is the per-command wrapper that picks a node and runs it. Wrap
 *    `_execute` on `_self` so both keyed and keyless cluster commands are caught.
 *
 * `createCluster` returns a proxy (`Object.create(realCluster)`) and `_self` points
 * at the real instance, so we must patch the method on `client._self` (own property),
 * which proxies inherit through the prototype chain.
 *
 * NOTE: node-redis routes MULTI/pipeline sub-commands through `#queue.addCommand`
 * directly (NOT `sendCommand`/`_execute`), so a batched `multi().exec()` is counted
 * as ONE inflight unit, not per sub-command. Acceptable: the gauge is a
 * stall/concurrency signal and a parked pipeline still shows as one long-lived
 * inflight entry landing in the top duration bucket.
 *
 * Overhead per command: one gauge inc/dec + one Date.now() delta observe. No
 * per-command allocation beyond the closure the call already pays for.
 */
// Shape of the prom metric handles published by '~/server/prom/client' on
// globalThis. Only the methods instrumentCommands calls are typed here.
type RedisMetricsBridge = {
  redisCommandsInflight: { inc: (labels: { client: string }) => void; dec: (labels: { client: string }) => void };
  redisCommandDuration: { observe: (labels: { client: string }, value: number) => void };
  // PR #2331 round-3: sentinel observability counters, exposed via the same
  // bridge to avoid a static prom-client import edge in this client-bundle-
  // reachable module. attachSysSentinelListeners reads them at attach time.
  sysredisSentinelTopologyChangesCounter: { labels: (labels: Record<string, string>) => { inc: () => void } };
  sysredisSentinelClientErrorsCounter: { labels: (labels: Record<string, string>) => { inc: () => void } };
  // FIX #1 self-heal reconnect counter (labeled by `trigger`: 'deadline' | 'inflight') + FIX #3
  // metric-write fail-soft counter. Read via the globalThis bridge so this client-bundle-
  // reachable module avoids a static prom-client import (which drags in fs/cluster). Both may be
  // undefined until prom/client loads server-side; callers null-check.
  redisSelfHealReconnectCounter?: { inc: (labels: { trigger: string }) => void };
  redisMetricWriteFailSoftCounter?: { labels: (labels: { op: string }) => { inc: () => void } };
  // Cluster routing retry-after-rediscover counter (the topology-churn 500 wave). Read via the
  // same globalThis bridge so this client-bundle-reachable module avoids a static prom import.
  redisRoutingRetryCounter?: { inc: (labels: { result: 'recovered' | 'exhausted' }) => void };
};

// Server-runtime lookup of the prom metric handles WITHOUT a static import edge
// (which would drag prom-client's fs/cluster requires into the client bundle).
// Returns undefined until '~/server/prom/client' has loaded server-side (always
// true by the time real redis commands run — trpc/api routes import it at startup);
// when undefined, instrumentation simply no-ops for that command (leak-free).
function getRedisMetrics(): RedisMetricsBridge | undefined {
  return (globalThis as unknown as { __civitaiRedisMetrics?: RedisMetricsBridge })
    .__civitaiRedisMetrics;
}

function instrumentCommands(client: any, clientLabel: 'cluster' | 'sys') {
  const self = client?._self ?? client;
  if (!self) return;
  const labels = { client: clientLabel } as const;
  // Detect the real chokepoint by capability rather than the static label: a
  // 'cache' client is a CLUSTER (wrap `_execute`) only when REDIS_CLUSTER is on;
  // otherwise it's a plain single client (wrap `sendCommand`), same as sysRedis.
  const isClusterClient = typeof self._execute === 'function';
  const methodName = isClusterClient ? '_execute' : 'sendCommand';
  const original = self[methodName];
  if (typeof original !== 'function') {
    log(`Redis instrumentation: ${methodName} not found on ${clientLabel} client`);
    return;
  }
  // Bounded per-command timeout — CLUSTER (cache) client ONLY. A ~0.5% minority of
  // cluster `_execute` promises NEVER settle even after socketTimeout (inferred:
  // cluster retry/topology-rediscovery orphans the outer promise across reconnects),
  // which both LEAKS the inflight gauge (done() below never fires) and PARKS the request
  // handler ~125s → flat-125s SSR 499s. Racing `_execute` against a rejecting deadline
  // guarantees the wrapped promise settles, so done() runs (gauge dec'd) and the handler
  // unparks with an error the existing fail-open cache readers degrade through. We must
  // NOT apply this to the SYSTEM client (sendCommand) — a blanket sys-client timeout
  // caused the #2556/#2586 wedge; sysRedis is bounded by withSysReadDeadline instead.
  const wrapWithDeadline = isClusterClient && clientLabel === 'cluster';
  self[methodName] = function (this: any, ...args: any[]) {
    // Read the metric handles published by '~/server/prom/client' on globalThis
    // (no static import — see the note on the prom import above). Capture ONCE per
    // command so inc/dec stay balanced even if prom/client loads mid-flight (a
    // dec without its matching inc would drive the gauge negative).
    const metrics = getRedisMetrics();
    metrics?.redisCommandsInflight.inc(labels);
    // Mirror the gauge into the local counter for the self-heal watchdog (cluster only).
    if (clientLabel === 'cluster') incClusterInflight();
    const start = Date.now();
    let dec = false; // per-closure guard so a double-settle (shouldn't happen) can't double-dec
    const done = () => {
      if (clientLabel === 'cluster' && !dec) {
        // FLOORED decrement (decClusterInflight clamps at 0). The per-closure `dec` guard above
        // only stops THIS closure decrementing twice — it does NOT stop N distinct rejected
        // closures (e.g. the burst destroy() rejects after a heal) decrementing past 0. The
        // floor is what keeps the counter accurate post-heal so the watchdog can re-arm (FIX #2).
        decClusterInflight();
        dec = true;
      }
      metrics?.redisCommandsInflight.dec(labels);
      metrics?.redisCommandDuration.observe(labels, (Date.now() - start) / 1000);
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
          rediscover: () => triggerTopologyRediscovery(self, 'routing-retry'),
          onResult: (result) => getRedisMetrics()?.redisRoutingRetryCounter?.inc({ result }),
        })
      : runOnce();

    // Bound the cluster command so a never-settling `_execute` still reaches done()
    // (gauge dec'd, handler unparked). No-op when the deadline env is 0/disabled or for
    // the sys client (wrapWithDeadline=false). withCommandDeadline reaps the late
    // rejection of the orphaned command so it can't surface as an unhandledRejection.
    // Layered OUTSIDE the routing retry so the 15s deadline bounds the WHOLE retried sequence
    // (the bounded ~50ms+150ms backoff is well inside it).
    const settled = wrapWithDeadline
      ? withCommandDeadline(executed, undefined, recordClusterDeadlineHit)
      : executed;
    return settled.finally(done);
  };
}

// Wall-clock deadline for per-request sysRedis reads — defined in a leaf module so it
// can be unit-tested without constructing the redis clients. Re-exported here because
// callers import it from `~/server/redis/client`.
export { withSysReadDeadline } from './sys-read-deadline';

function getClient<K extends RedisKeyTemplates>(type: 'cache' | 'system') {
  const client = getBaseClient(type) as unknown as CustomRedisClient<K>;

  // Wire in-flight + duration instrumentation at the per-command chokepoint.
  // 'cache' is the cluster client (wrap `_execute`), 'system' is the single
  // sysRedis client (wrap `sendCommand`).
  instrumentCommands(client, type === 'cache' ? 'cluster' : 'sys');

  // Create a separate client instance with Buffer type mapping for packed operations
  // `withTypeMapping` creates a NEW client instance - it doesn't modify the original client.
  // So `bufferClient` returns Buffers, while `client` still returns strings.
  const bufferClient = client.withTypeMapping({
    [RESP_TYPES.BLOB_STRING]: Buffer,
  }) as CustomRedisClient<K>;

  // Decode a packed Buffer, evicting the bad entry if msgpack fails so the next
  // read falls through to source. Returns null on decode failure, treated as cache miss.
  //
  // This is the GENERAL decode path for EVERY packed read (get/mGet/sMembers/sPop/
  // hGet/hGetAll/hmGet) across ~30 cache writers. It does plain `unpack(value)` only —
  // it deliberately does NOT brotli-decompress, so the 0x01 brotli sentinel is NOT a
  // global invariant on all packed values (a bare msgpack `1` packs to <01> and must
  // decode as the integer 1, not be mistaken for a compressed payload). Brotli
  // decompression is confined to the opt-in compress-aware read path below
  // (`get(key, { compress: true })`) — see ~/server/redis/packed-compression for why the
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

  // Implement scanIterator for cluster - it doesn't exist natively on RedisCluster
  // For Sentinel, scanIterator is also absent (the JS-only helper lives on
  // RedisClient, not the Sentinel proxy); we replicate its scan loop manually
  // using SCAN, which IS proxied to the current master.
  const baseClient = client as any;

  // Save reference to the original scanIterator (exists on single client only,
  // not on cluster, not on sentinel).
  const originalScanIterator = baseClient.scanIterator?.bind(baseClient);

  // Detect sentinel mode: the Sentinel proxy exposes getMasterNode but not
  // scanIterator. Cluster exposes .masters. Single client exposes scanIterator.
  const isSentinelClient =
    typeof baseClient.getMasterNode === 'function' &&
    typeof baseClient.scanIterator !== 'function';

  client.scanIterator = async function* (options) {
    if (baseClient.masters) {
      // Cluster mode: iterate through all master nodes
      const masters = await baseClient.masters;
      for (const master of masters) {
        const nodeClient = await baseClient.nodeClient(master);
        yield* nodeClient.scanIterator(options);
      }
    } else if (isSentinelClient) {
      // Sentinel mode: drive SCAN directly against the proxy. SCAN is part of
      // the COMMANDS map and is routed to the master client lease, so this
      // works without needing to borrow a raw client via .use(...).
      let cursor = options?.cursor ?? '0';
      do {
        const reply = await baseClient.scan(cursor, options);
        cursor = reply.cursor;
        yield reply.keys;
      } while (cursor !== '0');
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

export let redis: CustomRedisClientCache;
export let sysRedis: CustomRedisClientSys;
if (!env.IS_BUILD) {
  if (isProd) {
    redis = getCacheClient();
    sysRedis = getSysClient();
  } else {
    if (!global.globalRedis) global.globalRedis = getCacheClient();
    redis = global.globalRedis;

    if (!global.globalSysRedis) global.globalSysRedis = getSysClient();
    sysRedis = global.globalSysRedis;
  }
} else {
  log('Skipping Redis initialization (build phase)');
}

// Source of Truth data
export const REDIS_SYS_KEYS = {
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
    EXPERIMENTAL: 'generation:experimental',
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
    REFRESH_CAUSE: 'session:refresh-cause',
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
  BLOCKS: {
    /**
     * Emergency kill list — Redis SET of `block_id` strings that
     * BlockRegistry excludes from every listForModel response. Lets ops
     * disable a runaway block without a deploy.
     */
    EMERGENCY_KILL_LIST: 'system:blocks:emergency-kill-list',
    /**
     * Cumulative Buzz-spend cap counter (audit A7 / design-gaps H1). The
     * per-call `claims.buzzBudget` only bounds a SINGLE submitWorkflow; a
     * block holding a valid token can issue unlimited sequential capped
     * submits and drain the whole balance. This is an integer counter, keyed
     * `system:blocks:buzz-cap:${userId}:${appBlockId}:${UTC-day}`, INCRBY'd by
     * the cost of each successful submit and checked before submit. TTL is set
     * on first write so the per-window key self-expires.
     */
    BUZZ_CAP: 'system:blocks:buzz-cap',
    /**
     * Per-API-key (fallback per-IP) rate-limit counter for the token-authed
     * bundle-submit endpoint (`/api/v1/blocks/submit-version`). `SET NX EX` +
     * `INCR` in one MULTI (same atomic pattern as the retool endpoint) so the
     * counter is always created with its TTL. Bundle submit is heavy (decode +
     * ZIP extract + manifest validate up to ~72 MiB), so the limit is tight.
     * Lives on `sysRedis` (like the retool limiter + `BUZZ_CAP`), so the key is
     * declared here rather than in `REDIS_KEYS.BLOCKS`.
     */
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
  },
} as const;

// Cached data
export const REDIS_KEYS = {
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
  },
  CACHES: {
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
    BLOCKED_USERS: 'packed:caches:blocked-users',
    BLOCKED_BY_USERS: 'packed:caches:blocked-by-users',
    BASIC_USERS: 'packed:caches:basic-users',
    BASIC_TAGS: 'packed:caches:basic-tags',
    ENTITY_AVAILABILITY: {
      MODEL_VERSIONS: 'packed:caches:entity-availability:model-versions',
    },
    OVERVIEW_USERS: 'packed:caches:overview-users',
    FEATURED_MODELS: 'packed:featured-models-2',
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
  DAILY_CHALLENGE: {
    DETAILS: 'daily-challenge:details',
  },
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
  ENTITY_METRICS: {
    BASE: 'entitymetric',
  },
  QUEUES: {
    SEEN_IMAGES: 'queues:recent-images',
  },
  ARTICLE: {
    SCAN_UPDATE: 'article:scan-update',
    RESCAN: 'article:rescan',
    RATING_REVIEW_RATE_LIMIT: 'article:nsfw-review-rate',
  },
  BLOCKS: {
    REGISTRY: 'packed:caches:block-registry',
    TOKEN_RATE_LIMIT: 'blocks:token-rate-limit',
    /**
     * Per-blockInstanceId revocation marker. Writers (uninstall,
     * toggleEnabled(false), publisher ban) set this key with a 15-minute
     * TTL — the worst-case remaining lifetime of any token issued for the
     * instance just before revocation. The block-scope middleware checks
     * existence on every request; missing key → allowed, present → 403.
     */
    REVOKED_INSTANCE: 'blocks:revoked-instance',
    /**
     * Per-ecosystem-key most-popular-Checkpoint cache. Resolves to a
     * JSON-encoded ValidatedCheckpoint. 1h TTL — popularity changes
     * slowly and we'd rather serve a stale-by-an-hour Checkpoint than
     * pay a multi-join query on every block submit.
     */
    POPULAR_CHECKPOINT: 'blocks:popular-checkpoint',
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
