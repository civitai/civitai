/**
 * Cluster-client recovery when a node changes ADDRESS (e.g. a Redis cluster node changed address
 * after a rolling restart). Everything here is about one gap in node-redis 5.x (@redis/client
 * 5.8.3, cluster/index.js `_execute` and cluster/cluster-slots.js):
 *
 *   - The cluster client only re-reads the slot map on a MOVED or ASK reply. A node that went
 *     away never sends either, so nothing tells the client the map is stale.
 *   - Per-node clients are created with `.on('error', console.error)`, and the cluster emits no
 *     per-node events, so there is no event to hang a rediscover off.
 *
 * The only hook node-redis calls on a per-node connection failure is the socket
 * `reconnectStrategy(retries, cause)`, inherited by every node client from `defaults.socket`.
 * So that is where this module hooks in: every connection-class failure asks for a topology
 * rediscovery (`createThrottle`: at most one per second per cluster client). Once the cluster
 * advertises the node's new address, that re-read drops the old address and destroys its client,
 * rejecting what was queued on it. REDIS_CLUSTER_ERROR_REDISCOVER_ENABLED=false turns it off.
 *
 * The strategy never gives up on an address (unchanged backoff). An unreachable address can still
 * leave a discovery's eager node connect pending; the self-heal reconnect bounds its own wait on
 * that (client.ts, forceClusterReconnect) rather than closing node clients here.
 *
 * No prom/app imports; the node-redis types are duck-typed so this stays unit-testable.
 */
import { ConnectionTimeoutError, SocketClosedUnexpectedlyError, SocketTimeoutError } from 'redis';

/** Socket error codes that mean "could not reach this address". */
const CONNECT_ERROR_CODES = new Set([
  'EHOSTUNREACH',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTDOWN',
]);

/** True for a failure to ESTABLISH a connection to a node address. */
export function isNodeConnectError(cause: unknown): boolean {
  if (cause instanceof ConnectionTimeoutError) return true;
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && CONNECT_ERROR_CODES.has(code);
}

/**
 * True for any failure that means the slot map may be stale: a connect failure, an established
 * connection the node dropped (what a restarting node looks like first), or one that went silent
 * until `socketTimeout` destroyed it (what a peer that vanished without a FIN/RST looks like).
 */
export function isTopologyChangeSignal(cause: unknown): boolean {
  if (isNodeConnectError(cause)) return true;
  if (cause instanceof SocketClosedUnexpectedlyError) return true;
  if (cause instanceof SocketTimeoutError) return true;
  return (cause as { code?: unknown } | null | undefined)?.code === 'ECONNRESET';
}

/** The pre-existing backoff, unchanged: 0, 100, 200, … capped at 3s. */
export function reconnectDelayMs(retries: number): number {
  return Math.min(retries * 100, 3000);
}

export interface ClusterReconnectStrategyOptions {
  /**
   * Called on every failure that may mean the topology changed (throttling is the callee's).
   * Omitted = rediscover-on-error disabled; the strategy is then just the backoff.
   */
  onTopologyChangeSignal?: (cause: unknown) => void;
  log: (msg: string) => void;
}

/**
 * The per-node `socket.reconnectStrategy` for the CLUSTER client: the unchanged backoff, plus a
 * rediscovery request on any failure that may mean the node moved.
 */
export function createClusterReconnectStrategy(opts: ClusterReconnectStrategyOptions) {
  return (retries: number, cause: unknown): number => {
    if (opts.onTopologyChangeSignal && isTopologyChangeSignal(cause)) {
      try {
        opts.onTopologyChangeSignal(cause);
      } catch {
        // A rediscover request must never break the reconnect loop.
      }
    }
    opts.log(`Redis reconnecting, retry ${retries}`);
    return reconnectDelayMs(retries);
  };
}

/**
 * Leading-edge throttle for error-driven rediscovers: runs `fn` at once unless it
 * ran within `minIntervalMs`, otherwise drops the call. A failing node produces a burst of
 * strategy calls (one per retry, per node client); one slot-map read per interval is enough, and
 * node-redis single-flights an in-progress rediscover anyway. Returns whether `fn` ran.
 */
export function createThrottle(
  minIntervalMs: number,
  fn: (reason: string) => void,
  now: () => number = () => Date.now()
): (reason: string) => boolean {
  let lastRunAt: number | null = null;
  return (reason: string) => {
    const t = now();
    if (lastRunAt != null && t - lastRunAt < minIntervalMs) return false;
    lastRunAt = t;
    try {
      fn(reason);
    } catch {
      // fire-and-forget: a throw must not reach the reconnect strategy
    }
    return true;
  };
}

/** Duck-typed slot node (cluster-slots.js `nodeByAddress` values / `masters` entries). */
export interface SlotNodeLike {
  client?: { isReady?: boolean; options?: unknown } | undefined;
}

/**
 * Pick the node a rediscover reads the slot map from. node-redis's `rediscover(startWith)`
 * dereferences `startWith.options` unconditionally, so it must never be called without one.
 * Prefer a master whose client is READY (one round trip, known good); otherwise rotate through
 * the configured seed nodes (`{ options: rootNode }` is exactly what node-redis itself passes to
 * its discovery). Returns undefined only when there is nothing to ask.
 */
export function pickRediscoverStartNode(
  masters: SlotNodeLike[] | undefined,
  rootNodes: unknown[] | undefined,
  cursor: number
): { options: unknown } | undefined {
  for (const master of masters ?? []) {
    const client = master?.client;
    if (client?.isReady && client.options) return client as { options: unknown };
  }
  if (rootNodes && rootNodes.length > 0) {
    const i = ((cursor % rootNodes.length) + rootNodes.length) % rootNodes.length;
    return { options: rootNodes[i] };
  }
  return undefined;
}
