/**
 * Reconnect strategy for the sys client's Sentinel NODE connections (the master pool and its
 * pub/sub connection): keep retrying an address, as before, except that the connections of a
 * discovery that has never had a master connection up give up once the Sentinel names a
 * different master and that node answers as a master.
 *
 * WHY (node-redis @redis/client 5.8.3, sentinel/index.js): when the master closes its
 * connections, the next command makes RedisSentinel rediscover (`#reset` → `#connect`). If the
 * Sentinel has not failed over yet it still names the old master, and because no master
 * connection is ready, `analyze` treats that address as a new master: `transform` opens fresh
 * master connections to it and awaits their `connect()`. A node `connect()` only settles once a
 * connection is up or the reconnect strategy gives up, and this package's backoff never gives up.
 * So when the old master never answers on that address again (it came back somewhere else), the
 * discovery never finishes. Every command awaits it, every later one (the Sentinel's
 * `switch-master` notification, the periodic scan) joins it instead of starting over, and
 * `destroy()` awaits it too, so neither the client nor the sys self-heal can recover: only a
 * process restart does.
 *
 * Not a retry count: that also gives up on the current master and can wedge RedisSentinel (see
 * the commit that added this module).
 *
 * Here a connection gives up only on evidence that the master really is elsewhere: the Sentinel
 * names another node AND that node answers ROLE as a master. A lagging Sentinel still naming the
 * previous master during a blip on the current one is then not enough while that node is gone or
 * already a replica. (Left open: a previous master that stalled, was failed over, and answers
 * ROLE master again before the Sentinels demote it, while a lagging Sentinel still names it.)
 * While the Sentinel still names this address (the failover window, a master restarting in
 * place) nothing changes from before either. A spin can still follow a give-up inside a first
 * `connect()` that later fails; client.ts `connectOrDestroy` cuts it short.
 *
 * Giving up makes that `connect()` reject, so that discovery attempt fails; RedisSentinel's
 * discovery loop waits 1s, asks the Sentinel again and connects to the master it names.
 *
 * The address being dialled is the one RedisSentinel last reported in a MASTER_CHANGE
 * `topology-change` event: every master connection is (re)created by the discovery that emits
 * it, and the pub/sub connection follows the same node. The Sentinel's current answer comes from
 * our own `SENTINEL GET-MASTER-ADDR-BY-NAME` query plus a ROLE check on the node it names
 * (RedisSentinel's own switch-master handling only joins the stuck discovery), asked only while
 * connections are failing. Until an answer asked for after the discovery arrives, or if no
 * Sentinel answers, the strategy keeps retrying.
 */
import { createClient } from 'redis';
import { reconnectDelayMs } from './cluster-reconnect';
import { withTimeout } from './deadline';

export interface SentinelNode {
  host: string;
  port: number;
}

/** Asks the Sentinels which master they name; undefined when none answers. */
export type NamedMasterQuery = () => Promise<SentinelNode | undefined>;

/** A Sentinel answer older than this is treated as unknown. */
export const NAMED_MASTER_MAX_AGE_MS = 10_000;
/** At most one Sentinel query per this many ms, per source. */
const NAMED_MASTER_REFRESH_MIN_INTERVAL_MS = 1000;

/** The Sentinel's latest answer. */
export interface NamedMasterAnswer {
  node: SentinelNode;
  /** When it arrived (its age is measured from here). */
  answeredAt: number;
  /** Order of the query's START among queries and discoveries (see `nextSeq`). */
  askedSeq: number;
}

/**
 * Orders query starts against discoveries choosing a master. A clock cannot: both can land in the
 * same millisecond, and then whether an answer was asked for after the discovery is unknowable.
 */
let seq = 0;
const nextSeq = () => ++seq;

/**
 * The Sentinel's answer to "which master?". Asked when a connection fails, then every second
 * while failures continue (until 10s after the last). At most one query a second and one at a time.
 */
export function createNamedMasterSource(query: NamedMasterQuery, now: () => number = Date.now) {
  let answer: NamedMasterAnswer | undefined;
  let querying = false;
  let lastAskedAt = -Infinity;
  let demandUntil = -Infinity;

  const ask = () => {
    if (querying || now() - lastAskedAt < NAMED_MASTER_REFRESH_MIN_INTERVAL_MS) return;
    querying = true;
    lastAskedAt = now();
    const askedSeq = nextSeq();
    query()
      .then((node) => {
        if (node) answer = { node, answeredAt: now(), askedSeq };
      })
      .catch(() => undefined)
      .finally(() => {
        querying = false;
        // Keep polling while connections are failing. A follow-up skipped by the spacing check
        // means another ask ran meanwhile, and that one schedules the next.
        if (now() < demandUntil) {
          setTimeout(ask, NAMED_MASTER_REFRESH_MIN_INTERVAL_MS).unref?.();
        }
      });
  };

  return {
    /** A node connection failed: ask now (if allowed) and keep asking while failures continue. */
    refresh: () => {
      demandUntil = now() + NAMED_MASTER_MAX_AGE_MS;
      ask();
    },
    current: (): NamedMasterAnswer | undefined => answer,
  };
}

export type NamedMasterSource = ReturnType<typeof createNamedMasterSource>;

export interface SentinelStaleMasterGuardOptions {
  source: NamedMasterSource;
  /**
   * True while any of this RedisSentinel's master connections is ready (`getMasterNode() !==
   * undefined`); once one has been, none of this discovery's connections may give up (see
   * `established`).
   */
  isMasterConnectionReady: () => boolean;
  log: (msg: string) => void;
  /** false = never give up (the strategy is then just the backoff). */
  enabled: boolean;
  now?: () => number;
}

/** How often a discovery's connections are checked for having come up (see `established`). */
const ESTABLISHED_CHECK_INTERVAL_MS = 250;

const sameNode = (a: SentinelNode, b: SentinelNode) =>
  a.host === b.host && Number(a.port) === Number(b.port);

/**
 * Builds the node reconnect strategy plus the `topology-change` listener that feeds it. One per
 * RedisSentinel instance: each tracks the master its own discovery last chose.
 */
export function createSentinelStaleMasterGuard(opts: SentinelStaleMasterGuardOptions) {
  const now = opts.now ?? Date.now;
  let dialed: { node: SentinelNode; seq: number } | undefined;
  /**
   * Whether a connection of the current discovery has been seen up (checked every 250ms, and at
   * each failure). Once any has been seen up, none may give up for the rest of this discovery:
   * they are retried forever, as before. This is a second line of defence beside the ROLE check:
   * a pool connection given up while its partner reconnects stays closed for good, since
   * RedisSentinel reopens master connections only when none is ready. When such a master is
   * really gone, the next command's discovery replaces these connections with fresh ones, which
   * may give up.
   */
  let established = false;
  let checker: ReturnType<typeof setInterval> | undefined;
  const stopChecker = () => {
    if (checker) clearInterval(checker);
    checker = undefined;
  };

  /** Wire to the RedisSentinel's `topology-change` event. */
  const onTopologyChange = (event: { type?: string; node?: SentinelNode } | undefined) => {
    if (event?.type !== 'MASTER_CHANGE' || !event.node) return;
    dialed = { node: { host: event.node.host, port: Number(event.node.port) }, seq: nextSeq() };
    // A successful connect never consults the strategy, so watch for the connections coming up.
    established = false;
    stopChecker();
    checker = setInterval(() => {
      if (opts.isMasterConnectionReady()) {
        established = true;
        stopChecker();
      }
    }, ESTABLISHED_CHECK_INTERVAL_MS);
    checker.unref?.();
  };

  /** The node `socket.reconnectStrategy`. */
  const reconnectStrategy = (retries: number, cause: unknown): number | Error => {
    if (opts.enabled) {
      opts.source.refresh();
      const answer = opts.source.current();
      // Only an answer asked for AFTER this discovery chose its master says anything about it,
      // and only while it is recent.
      const named =
        dialed &&
        answer &&
        answer.askedSeq > dialed.seq &&
        now() - answer.answeredAt <= NAMED_MASTER_MAX_AGE_MS
          ? answer.node
          : undefined;
      if (opts.isMasterConnectionReady()) {
        established = true;
        stopChecker();
      }
      if (dialed && named && !established && !sameNode(dialed.node, named)) {
        const from = `${dialed.node.host}:${dialed.node.port}`;
        const to = `${named.host}:${named.port}`;
        const reason = cause instanceof Error ? cause.message : String(cause);
        opts.log(
          `Redis Sentinel node connection: giving up on ${from} (${reason}); the Sentinel names ${to} as master`
        );
        return new Error(`gave up on ${from}: the Sentinel names ${to} as master`);
      }
    }
    opts.log(`Redis Sentinel node reconnecting, retry ${retries}`);
    return reconnectDelayMs(retries);
  };

  return { reconnectStrategy, onTopologyChange };
}

/**
 * The production query: ask each Sentinel in turn for the master of `name`, then ask that node
 * for its ROLE, each on a short-lived connection that never reconnects and bounded by `timeoutMs`
 * (one that accepts the connection but never replies cannot pin the query). Returns the first
 * named node that answers as a master.
 */
export function createNamedMasterQuery(opts: {
  sentinels: SentinelNode[];
  name: string;
  /** Sentinel auth (REDIS_SYS_SENTINEL_PASSWORD). */
  password?: string;
  /** Redis node auth (the REDIS_SYS_URL password), for the ROLE check. */
  nodePassword?: string;
  timeoutMs: number;
}): NamedMasterQuery {
  /** One command on a short-lived connection that never reconnects, bounded by `timeoutMs`. */
  const once = async (node: SentinelNode, password: string | undefined, args: string[]) => {
    const client = createClient({
      ...(password ? { password } : {}),
      socket: {
        host: node.host,
        port: node.port,
        // Half the budget, so a dial still in flight at the deadline cannot exist: an open
        // connection is always one destroy() below can reach.
        connectTimeout: Math.max(1, Math.floor(opts.timeoutMs / 2)),
        reconnectStrategy: false,
      },
    });
    client.on('error', () => undefined);
    const run = async () => {
      await client.connect();
      return (await client.sendCommand(args)) as unknown;
    };
    try {
      return await withTimeout(
        run(),
        opts.timeoutMs,
        `${args[0]} did not settle within ${opts.timeoutMs}ms`
      );
    } finally {
      // Also on a timeout: destroying rejects whatever is still pending and closes the connection.
      if (client.isOpen) client.destroy();
    }
  };
  const askOne = async (sentinel: SentinelNode): Promise<SentinelNode | undefined> => {
    const reply = await once(sentinel, opts.password, [
      'SENTINEL',
      'GET-MASTER-ADDR-BY-NAME',
      opts.name,
    ]);
    if (!Array.isArray(reply) || reply.length < 2) return undefined;
    const named = { host: String(reply[0]), port: Number(reply[1]) };
    // A Sentinel lagging behind a failover can still name the previous master. Count the answer
    // only if that node answers and says it is a master: a gone or demoted node is no evidence
    // that the dialled address has been replaced.
    const role = await once(named, opts.nodePassword, ['ROLE']);
    return Array.isArray(role) && String(role[0]) === 'master' ? named : undefined;
  };
  return async () => {
    for (const sentinel of opts.sentinels) {
      try {
        const node = await askOne(sentinel);
        if (node) return node;
      } catch {
        // try the next Sentinel
      }
    }
    return undefined;
  };
}
