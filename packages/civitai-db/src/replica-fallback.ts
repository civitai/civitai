// Replica → primary fallback for READ clients, for when the replica cannot be reached at all.
//
// What it acts on: only `isDbConnectionError` — a connection that could not be made or was dropped.
// A query that reached the replica and failed (syntax, constraint, statement_timeout) is rethrown
// untouched and never retried on the primary. A pool-queue timeout counts only while the replica is
// already marked down, because on its own it means "saturated", not "unreachable".
//
// What bounds it: at most `maxConcurrent` borrowed primary resources at once (a pool client until it
// is released, a Prisma read until it settles). Past the cap the replica's own error is rethrown at
// once, so a replica outage can never move the whole read load onto the primary.
//
// After a connection failure the replica is skipped for `cooldownMs`, so each read does not pay a
// connect timeout before falling back; the first read after the window probes the replica again.
//
// Off unless a caller wires it in (the app gates that on an env flag). Every decision is counted.
import type { Pool, PoolClient } from 'pg';
import client from 'prom-client';
import { isDbAcquireTimeout, isDbConnectionError } from './db-errors';

export const REPLICA_FALLBACK_COUNTER_NAME = 'node_postgres_replica_fallback_total';
export type ReplicaFallbackOutcome = 'primary' | 'capped' | 'primary_error';
export type ReplicaFallbackCounter = client.Counter<'pool' | 'outcome'>;

export function createReplicaFallbackCounter(
  registers?: client.Registry[]
): ReplicaFallbackCounter {
  return new client.Counter({
    name: REPLICA_FALLBACK_COUNTER_NAME,
    help: 'Reads sent to the primary because the replica was unreachable, by client and outcome',
    labelNames: ['pool', 'outcome'] as const,
    ...(registers ? { registers } : {}),
  });
}

let defaultCounter: ReplicaFallbackCounter | undefined;
function getDefaultCounter(): ReplicaFallbackCounter {
  if (defaultCounter) return defaultCounter;
  try {
    defaultCounter = createReplicaFallbackCounter();
  } catch {
    // HMR re-registration: prom-client throws on a duplicate name; reuse the registered one.
    defaultCounter = client.register.getSingleMetric(
      REPLICA_FALLBACK_COUNTER_NAME
    ) as ReplicaFallbackCounter;
  }
  return defaultCounter;
}

export type ReplicaFallbackOptions = {
  /** Metric label: which read client this guards. */
  label: string;
  /** Most borrowed primary resources at once. */
  maxConcurrent: number;
  /** How long a connection failure marks the replica down. */
  cooldownMs?: number;
  counter?: ReplicaFallbackCounter;
  /** Injected clock, for tests. */
  now?: () => number;
};

export type ReplicaFallback = {
  /**
   * Run `replica`; on a connection-level failure (or while the replica is marked down) run `primary`
   * instead when a slot is free. `primary` gets `done`, which it must call exactly once when the
   * borrowed primary resource is given back — including when acquiring it fails.
   */
  run<T>(replica: () => Promise<T>, primary: (done: () => void) => Promise<T>): Promise<T>;
  readonly inFlight: number;
};

export const DEFAULT_REPLICA_FALLBACK_COOLDOWN_MS = 5_000;

export function createReplicaFallback(options: ReplicaFallbackOptions): ReplicaFallback {
  const {
    label,
    maxConcurrent,
    cooldownMs = DEFAULT_REPLICA_FALLBACK_COOLDOWN_MS,
    now = Date.now,
  } = options;
  const counter = options.counter ?? getDefaultCounter();
  let inFlight = 0;
  let downUntil = 0;
  let lastError: unknown;

  const toPrimary = async <T>(
    replicaError: unknown,
    primary: (done: () => void) => Promise<T>
  ): Promise<T> => {
    if (inFlight >= maxConcurrent) {
      counter.inc({ pool: label, outcome: 'capped' });
      throw replicaError;
    }
    inFlight++;
    let released = false;
    const done = () => {
      if (released) return;
      released = true;
      inFlight--;
    };
    try {
      const result = await primary(done);
      counter.inc({ pool: label, outcome: 'primary' });
      return result;
    } catch (e) {
      done();
      counter.inc({ pool: label, outcome: 'primary_error' });
      throw e;
    }
  };

  return {
    get inFlight() {
      return inFlight;
    },
    async run(replica, primary) {
      if (now() < downUntil) return toPrimary(lastError, primary);
      try {
        return await replica();
      } catch (e) {
        const replicaDown = now() < downUntil; // a sibling call marked it down meanwhile
        if (isDbConnectionError(e)) {
          downUntil = now() + cooldownMs;
          lastError = e;
        } else if (!(replicaDown && isDbAcquireTimeout(e))) {
          throw e;
        }
        return toPrimary(e, primary);
      }
    },
  };
}

/**
 * Route `read`'s connection acquisition through `fallback`: an unreachable replica hands out a client
 * from `primary()` instead. Mutates and returns `read`, so every existing holder of the pool (Kysely,
 * `pool.query`, `cancellableQuery`) goes through it. `pool.query` calls `this.connect(cb)`, so the
 * callback form is covered too.
 */
export function withPgReplicaFallback<P extends Pool>(
  read: P,
  primary: () => Pool,
  fallback: ReplicaFallback
): P {
  const inner = read.connect.bind(read) as () => Promise<PoolClient>;
  const acquire = () =>
    fallback.run(
      () => inner(),
      async (done) => {
        const conn = await primary().connect();
        // pg-pool assigns a fresh `release` on every checkout, so this wrapper lives exactly as long
        // as this checkout.
        const release = conn.release.bind(conn);
        conn.release = ((err?: Error | boolean) => {
          done();
          return release(err);
        }) as typeof conn.release;
        return conn;
      }
    );

  read.connect = ((cb?: (err: Error | undefined, c?: PoolClient, d?: unknown) => void) => {
    if (typeof cb !== 'function') return acquire();
    acquire().then(
      (c) => cb(undefined, c, c.release),
      (e) => cb(e as Error)
    );
    return undefined;
  }) as P['connect'];
  return read;
}

const PRISMA_READ_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

type PrismaQueryParams = {
  model?: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
};

/**
 * The body of a Prisma `$allModels.$allOperations` query extension on the READ client: a model read
 * whose replica connection fails is re-run through `primary`'s delegate for the same model. Writes and
 * raw queries pass straight through (raw reads are not covered).
 */
export function runPrismaReadWithFallback(
  params: PrismaQueryParams,
  primary: unknown,
  fallback: ReplicaFallback
): Promise<unknown> {
  const { model, operation, args, query } = params;
  if (!model || !PRISMA_READ_OPERATIONS.has(operation)) return query(args);
  const delegateKey = model.charAt(0).toLowerCase() + model.slice(1);
  return fallback.run(
    () => query(args),
    (done) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const delegate = (primary as any)[delegateKey];
      return Promise.resolve(delegate[operation](args)).finally(done);
    }
  );
}
