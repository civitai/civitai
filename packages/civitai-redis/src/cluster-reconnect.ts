/**
 * Cluster-client recovery when a node changes ADDRESS (e.g. a Redis cluster node changed address
 * after a rolling restart). Everything here is about one gap in node-redis 5.x (@redis/client
 * 5.8.3, cluster/index.js `_execute` and cluster/cluster-slots.js):
 *
 *   - The cluster client only re-reads the slot map on a MOVED or ASK reply. A node that went
 *     away never sends either, so nothing tells the client the map is stale.
 *   - Per-node clients are created with `.on('error', console.error)`, and the cluster emits no
 *     per-node events, so there is no event to hang a rediscover off.
 *   - A per-node client retries its old address for as long as the reconnect strategy says so.
 *     Ours never said stop, so commands queued on the dead address until the command deadline.
 *   - A discovery (`rediscover()` and the cluster `connect()`) eagerly connects every NEW address
 *     in the map and awaits all of them. One unreachable new address leaves it pending forever,
 *     and `rediscover()` is single-flighted, so every later rediscover returns that same promise.
 *
 * The only hook node-redis calls on a per-node connection failure is the socket
 * `reconnectStrategy(retries, cause)`, inherited by every node client from `defaults.socket`.
 * So that is where this module hooks in:
 *
 *   1. Every connection-class failure asks for a topology rediscovery (`createThrottle`: at most
 *      one per second per cluster client). Once the cluster advertises the node's new address, that
 *      re-read drops the old address and destroys its client, rejecting what was queued on it.
 *   2. After `maxConnectFailures` failed attempts ending in a connect error, the strategy returns
 *      an Error. node-redis then closes that node client and rejects everything queued on it, so
 *      callers fail fast and a pending discovery moves on instead of waiting forever.
 *
 * A closed node client is never reopened by node-redis; it stays in the slot map until a
 * discovery drops its address. `dropClosedNodeClients` (run right after a give-up, and before a
 * rediscover or a self-heal destroy) and `installLazyNodeClientReopen` cover the case where the
 * node comes back on the SAME address: after a short cooldown the next command lazily creates a
 * fresh client. Dropping also keeps node-redis's own teardown paths working —
 * `RedisClient.destroy()` throws ClientClosedError on an already-closed client, and both
 * `RedisClusterSlots.destroy()` and the stale-node cleanup inside a discovery call it without a
 * try/catch. NOT covered: pub/sub clients (`pubSubNode`, `node.pubSub`), which the package's
 * cache client does not use.
 *
 * No prom/app imports; the node-redis types are duck-typed so this stays unit-testable.
 */
import { ConnectionTimeoutError, SocketClosedUnexpectedlyError } from 'redis';

/** Socket error codes that mean "could not reach this address". */
const CONNECT_ERROR_CODES = new Set([
  'EHOSTUNREACH',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTDOWN',
]);

/**
 * True for a failure to ESTABLISH a connection to a node address — the failures that count
 * toward giving up on that address.
 */
export function isNodeConnectError(cause: unknown): boolean {
  if (cause instanceof ConnectionTimeoutError) return true;
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && CONNECT_ERROR_CODES.has(code);
}

/**
 * True for any failure that means the slot map may be stale: a connect failure, or an
 * established connection the node dropped (what a restarting node looks like first).
 */
export function isTopologyChangeSignal(cause: unknown): boolean {
  if (isNodeConnectError(cause)) return true;
  if (cause instanceof SocketClosedUnexpectedlyError) return true;
  return (cause as { code?: unknown } | null | undefined)?.code === 'ECONNRESET';
}

/** The pre-existing backoff, unchanged: 0, 100, 200, … capped at 3s. */
export function reconnectDelayMs(retries: number): number {
  return Math.min(retries * 100, 3000);
}

export interface ClusterReconnectStrategyOptions {
  /**
   * Give up on a node address once this many attempts of one reconnect loop have failed and the
   * latest failure is a connect error. `retries` is node-redis's own 0-based per-loop counter: it
   * counts EVERY failed attempt in the loop (a handshake error too) and resets when a connection
   * succeeds. <= 0 disables giving up.
   */
  maxConnectFailures: number;
  /** Called on every failure that may mean the topology changed (throttling is the callee's). */
  onTopologyChangeSignal: (cause: unknown) => void;
  /** Called when the strategy gives up on a node (node-redis closes that client right after). */
  onGiveUp?: () => void;
  log: (msg: string) => void;
}

/**
 * The per-node `socket.reconnectStrategy` for the CLUSTER client. Returns a delay in ms to retry,
 * or an Error to stop retrying (node-redis then closes the client and rejects its queue).
 */
export function createClusterReconnectStrategy(opts: ClusterReconnectStrategyOptions) {
  return (retries: number, cause: unknown): number | Error => {
    if (isTopologyChangeSignal(cause)) {
      try {
        opts.onTopologyChangeSignal(cause);
      } catch {
        // A rediscover request must never break the reconnect loop.
      }
    }
    if (
      opts.maxConnectFailures > 0 &&
      isNodeConnectError(cause) &&
      retries + 1 >= opts.maxConnectFailures
    ) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      opts.log(
        `Redis cluster node unreachable after ${
          retries + 1
        } attempts (${reason}); closing the node client so queued commands fail fast`
      );
      try {
        opts.onGiveUp?.();
      } catch {
        // Bookkeeping only; the give-up itself must still happen.
      }
      return new Error(`Redis cluster node unreachable after ${retries + 1} attempts: ${reason}`);
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
  address?: string;
  client?: { isOpen?: boolean; isReady?: boolean; options?: unknown } | undefined;
  connectPromise?: unknown;
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

/** Duck-typed `RedisClusterSlots` surface used below. */
export interface ClusterSlotsLike {
  nodeByAddress?: Map<string, SlotNodeLike>;
  nodeClient?: (node: SlotNodeLike) => unknown;
}

/**
 * After a node client is dropped, how long commands routed to that node fail fast instead of
 * opening a new client. Without it, traffic to a node that refuses connections restarts the
 * give-up cycle as soon as the last one ends (~0.6s), many times the old 3s backoff cap.
 */
export const NODE_REOPEN_COOLDOWN_MS = 3000;

type ReopenMarked = SlotNodeLike & { __reopenNotBefore?: number };

/**
 * Forget every node client that node-redis has CLOSED (e.g. after the strategy above gave up on
 * it) and that is not mid-connect, and start that node's reopen cooldown. After the cooldown the
 * next command routed to the node creates a fresh client (`installLazyNodeClientReopen`), and
 * node-redis's own teardown loops no longer hit a closed client. Returns how many were dropped.
 */
export function dropClosedNodeClients(
  slots: ClusterSlotsLike | undefined,
  now: () => number = () => Date.now()
): number {
  let dropped = 0;
  for (const node of slots?.nodeByAddress?.values() ?? []) {
    if (isClosedIdle(node)) {
      dropNodeClient(node, now());
      dropped++;
    }
  }
  return dropped;
}

/**
 * Wrap `slots.nodeClient` (node-redis routes every command and ASK redirect through it) so a
 * closed client is dropped right before a command would use it, and a node in its reopen cooldown
 * fails the command at once. Discovery does not go through `nodeClient`, so it is unaffected.
 * Idempotent per slots instance.
 */
export function installLazyNodeClientReopen(
  slots: ClusterSlotsLike | undefined,
  now: () => number = () => Date.now(),
  /**
   * Called when a command is refused during a cooldown. The refused node produces no reconnect
   * attempts (and so no strategy calls) while it has no client, so this is how a node that moved
   * keeps asking for a slot-map re-read during its cooldown. Throttling is the callee's.
   */
  onDeferred?: (node: SlotNodeLike) => void
): void {
  if (!slots || typeof slots.nodeClient !== 'function') return;
  const marked = slots as ClusterSlotsLike & { __lazyReopenInstalled?: boolean };
  if (marked.__lazyReopenInstalled) return;
  const original = slots.nodeClient.bind(slots);
  slots.nodeClient = (node: SlotNodeLike) => {
    const t = now();
    if (isClosedIdle(node)) dropNodeClient(node, t);
    const notBefore = (node as ReopenMarked | undefined)?.__reopenNotBefore;
    if (node && !node.client && notBefore != null) {
      if (t < notBefore) {
        try {
          onDeferred?.(node);
        } catch {
          // a rediscover request must never break routing
        }
        return Promise.reject(
          new Error(`Redis cluster node ${node.address ?? '?'} unreachable; reconnect deferred`)
        );
      }
      (node as ReopenMarked).__reopenNotBefore = undefined;
    }
    return original(node);
  };
  marked.__lazyReopenInstalled = true;
}

function dropNodeClient(node: SlotNodeLike, t: number): void {
  node.client = undefined;
  (node as ReopenMarked).__reopenNotBefore = t + NODE_REOPEN_COOLDOWN_MS;
}

function isClosedIdle(node: SlotNodeLike | undefined): node is SlotNodeLike {
  return !!node && !!node.client && node.client.isOpen === false && !node.connectPromise;
}
