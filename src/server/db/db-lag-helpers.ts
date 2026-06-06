import type { PrismaClient } from '@prisma/client';
import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { notifDbRead, notifDbWrite } from '~/server/db/notifDb';
import { FLIPT_FEATURE_FLAGS, isFliptSync } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { dbReadFallbackCounter } from '~/server/prom/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';

type LaggingType =
  | 'model'
  | 'modelVersion'
  | 'commentModel'
  | 'resourceReview'
  | 'post'
  | 'postImages'
  | 'article'
  | 'imageResource'
  | 'notification'
  | 'userTrainingModels'
  | 'userArticles'
  | 'userApiKeys'
  | 'collection'
  | 'userCollections';

function lagKey(type: LaggingType, id: number | string) {
  return `${REDIS_KEYS.LAG_HELPER}:${type}:${id}` as const;
}

function isHighReplicationLagMode() {
  // Synchronous eval — null when Flipt hasn't initialized yet; treat that as off.
  return isFliptSync(FLIPT_FEATURE_FLAGS.HIGH_REPLICATION_LAG_MODE) === true;
}

// Called with (type, id): returns dbWrite only when a recent write flagged
// that specific entity in Redis. The Flipt flag does NOT override this path —
// per-id is already precise, and flipping every targeted reader to primary
// would flood it.
// Called with no args: falls back to the HIGH_REPLICATION_LAG_MODE Flipt flag
// as a global kill-switch for RAW reads that have no per-id flagging (e.g.
// reaction toggles).
export async function getDbWithoutLag(type?: LaggingType, id?: number | string) {
  if (env.REPLICATION_LAG_DELAY <= 0) return dbRead;
  if (type === undefined || id === undefined || id === null) {
    return isHighReplicationLagMode() ? dbWrite : dbRead;
  }
  const value = await redis.get(lagKey(type, id));
  if (value) return dbWrite;
  return dbRead;
}

export async function preventReplicationLag(type: LaggingType, id?: number | string) {
  if (env.REPLICATION_LAG_DELAY <= 0 || id === undefined || id === null) return;
  await redis.set(lagKey(type, id), 'true', { EX: env.REPLICATION_LAG_DELAY });
}

// Batch variant: routes the whole batch to dbWrite when ANY id has the lag flag.
// Correctness over marginal perf — batches are typically small and a full-primary
// read is preferable to splitting queries. Flipt kill-switch intentionally does
// not override the batch path — callers with ids are precise.
export async function getDbWithoutLagBatch(type: LaggingType, ids: (number | string)[]) {
  if (env.REPLICATION_LAG_DELAY <= 0 || ids.length === 0) return dbRead;
  const values = await Promise.all(ids.map((id) => redis.get(lagKey(type, id))));
  return values.some(Boolean) ? dbWrite : dbRead;
}

export async function preventReplicationLagBatch(type: LaggingType, ids: (number | string)[]) {
  if (env.REPLICATION_LAG_DELAY <= 0 || ids.length === 0) return;
  await Promise.all(
    ids.map((id) => redis.set(lagKey(type, id), 'true', { EX: env.REPLICATION_LAG_DELAY }))
  );
}

// Readers route via getDbWithoutLag('model', modelId) for model-page queries AND
// getDbWithoutLag('modelVersion', versionId) for direct version lookups. Any
// mutation touching a ModelVersion row must flag both so either access path
// catches the lag window.
export async function preventModelVersionLagBatch(
  modelIds: number | number[],
  versionIds: number | number[]
) {
  const mIds = Array.isArray(modelIds) ? modelIds : [modelIds];
  const vIds = Array.isArray(versionIds) ? versionIds : [versionIds];
  await Promise.all([
    preventReplicationLagBatch('model', mIds),
    preventReplicationLagBatch('modelVersion', vIds),
  ]);
}

export const preventModelVersionLag = (modelId: number, versionId: number) =>
  preventModelVersionLagBatch(modelId, versionId);

// Prisma error codes that indicate the connection/pool — not the query — failed.
// P1001 can't reach DB · P1002 reached but timed out · P1008 operation timed out ·
// P1017 server closed the connection · P2024 timed out fetching a connection from the pool.
const PRISMA_CONNECTION_ERROR_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);

// Substrings seen in the engine-level message when the underlying socket drops.
// Driven by the 2026-06-06 incident, where the buzz read-replica's RO PgBouncer
// pooler had zero backends and reads surfaced as `PostgreSQL connection: Error { kind: Closed }`.
const CONNECTION_ERROR_MESSAGE_FRAGMENTS = [
  'kind: closed',
  'connection closed',
  'connection terminated',
  'connection refused',
  'econnrefused',
  'econnreset',
  'server has closed the connection',
  'timed out fetching a new connection from the connection pool',
  'connection pool timeout',
];

// Prisma error class names that always indicate a connection/engine failure
// (not a query failure). We match on `.name` rather than `instanceof` because the
// repo's slim-generated client does not expose the error constructors on the
// `Prisma` namespace at runtime, so `instanceof Prisma.X` is unreliable here.
const PRISMA_CONNECTION_ERROR_NAMES = new Set([
  'PrismaClientInitializationError',
  'PrismaClientRustPanicError',
]);

/**
 * Detects connection-LEVEL failures (the read connection/pool is unavailable),
 * as opposed to genuine query failures (constraint violations, bad SQL, NOT_FOUND).
 * Only connection-level failures are safe to transparently retry on the primary.
 *
 * Detection is duck-typed (by `.name`, `.code`, and message fragments) rather than
 * via `instanceof`, because this repo's slim-generated Prisma client does not expose
 * the error constructors at runtime.
 */
export function isDbConnectionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const name =
    'name' in error && typeof (error as { name: unknown }).name === 'string'
      ? (error as { name: string }).name
      : '';
  if (PRISMA_CONNECTION_ERROR_NAMES.has(name)) return true;

  const code =
    'code' in error && typeof (error as { code: unknown }).code === 'string'
      ? (error as { code: string }).code
      : '';
  if (code && PRISMA_CONNECTION_ERROR_CODES.has(code)) return true;

  // Some errors (PrismaClientUnknownRequestError, raw node-postgres errors) only
  // carry the detail in the message — inspect it for known connection-failure fragments.
  const message =
    'message' in error && (error as { message: unknown }).message != null
      ? String((error as { message: unknown }).message).toLowerCase()
      : '';
  if (!message) return false;
  return CONNECTION_ERROR_MESSAGE_FRAGMENTS.some((fragment) => message.includes(fragment));
}

/**
 * Runs a read against the read-replica (RO) connection and, ONLY when that
 * connection itself is unavailable, transparently retries the same read against
 * the primary (write/RW) connection.
 *
 * Normal operation is unchanged: reads still go to the replica for offload. The
 * fallback fires solely on a connection-level failure (pool/socket closed,
 * refused, or pool-acquire timeout) — never on a genuine query error, which is
 * re-thrown unchanged so callers still see real failures.
 *
 * Motivated by the 2026-06-06 incident: a maintenance window took down the node
 * hosting BOTH the buzz read-replica and its RO PgBouncer pooler, leaving the RO
 * service with zero backends. Buzz reads (e.g. the multipliers query behind
 * buzz.getBuzzAccount, which fires on essentially every authenticated request)
 * threw `PostgreSQL connection: Error { kind: Closed }` and surfaced as
 * INTERNAL_SERVER_ERROR for ~19% of API traffic until ops manually repointed the
 * RO pooler at the primary. This helper degrades gracefully instead.
 *
 * @param read   Performs the read using the supplied client; called first with
 *               dbRead, and — only on a connection failure — again with dbWrite.
 * @param caller Label for the dbread_fallback_total metric (entity is `buzz`-style).
 */
export async function readWithReplicaFallback<T>(
  read: (db: PrismaClient) => Promise<T>,
  { entity, caller }: { entity: string; caller: string }
): Promise<T> {
  // When read and write share a client there is no separate RO connection to fall
  // back from — run directly and let any error propagate.
  if (dbRead === dbWrite) return read(dbRead);

  try {
    return await read(dbRead);
  } catch (error) {
    if (!isDbConnectionError(error)) throw error;

    dbReadFallbackCounter.inc({ entity, caller });
    logToAxiom(
      {
        type: 'warning',
        name: 'db-read-replica-fallback',
        message: 'Read-replica connection unavailable; falling back to primary',
        entity,
        caller,
        error: error instanceof Error ? error.message : String(error),
      },
      'db-logs'
    ).catch(() => {
      /* best-effort */
    });

    return read(dbWrite);
  }
}

// Same as getDbWithoutLag / getDbWithoutLagBatch but for the notifDb pool.
export async function getNotifDbWithoutLag(type?: LaggingType, id?: number | string) {
  if (env.REPLICATION_LAG_DELAY <= 0) return notifDbRead;
  if (type === undefined || id === undefined || id === null) {
    return isHighReplicationLagMode() ? notifDbWrite : notifDbRead;
  }
  const value = await redis.get(lagKey(type, id));
  if (value) return notifDbWrite;
  return notifDbRead;
}
