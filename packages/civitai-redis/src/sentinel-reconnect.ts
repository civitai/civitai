/**
 * Reconnect strategy for the sys client's Sentinel node connections. node-redis 5.8.3's
 * RedisSentinel awaits a discovery's fresh master connects, so one that dials a master gone for
 * good never finishes and wedges the client until restart. A connection here gives up only when
 * the Sentinel names another node that answers ROLE master and no connection of its discovery has
 * been up (see `established`).
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
 * The Sentinel's answer to "which master?". Asked when a connection fails and again while failures
 * continue; one query at a time, spaced by `NAMED_MASTER_REFRESH_MIN_INTERVAL_MS`.
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
  /** A connection of this discovery has been seen up: then none may give up, since RedisSentinel
   * reopens master connections only when none is up on the master the Sentinel names. */
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
 * Asks each Sentinel in turn for `name`'s master, then that node for ROLE; returns the first named
 * node that answers as a master.
 */
export function createNamedMasterQuery(opts: {
  sentinels: SentinelNode[];
  name: string;
  /** Sentinel auth (REDIS_SYS_SENTINEL_PASSWORD). */
  password?: string;
  /** Redis node auth (the REDIS_SYS_URL password), for the ROLE check. */
  nodePassword?: string;
  timeoutMs: number;
  /** Called with what failed when no Sentinel gave an answer and at least one could not be asked. */
  onFailure?: (reason: string) => void;
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
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(`${args[0]} ${node.host}:${node.port}: ${why}`);
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
    const failures: string[] = [];
    for (const sentinel of opts.sentinels) {
      try {
        const node = await askOne(sentinel);
        if (node) return node;
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (failures.length > 0) opts.onFailure?.(failures.join('; '));
    return undefined;
  };
}

/** `log(msg)` at most once per `intervalMs`; the calls in between are dropped. */
export function createRateLimitedLog(
  log: (msg: string) => void,
  intervalMs: number,
  now: () => number = Date.now
): (msg: string) => void {
  let lastAt = -Infinity;
  return (msg) => {
    if (now() - lastAt < intervalMs) return;
    lastAt = now();
    log(msg);
  };
}
