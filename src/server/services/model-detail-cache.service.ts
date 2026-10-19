import { Prisma } from '@prisma/client';
import { CacheTTL } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { getDbWithoutLag } from '~/server/db/db-lag-helpers';
import { cacheHitCounter, cacheMissCounter } from '~/server/prom/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { modelWithDetailsSelect } from '~/server/selectors/model.selector';
import { getModel } from '~/server/services/model.service';
import { fetchThroughCacheWithDeadline } from '~/server/utils/cache-helpers';
import {
  bustModelDetailPublicCache,
  modelDetailPublicCacheKey,
} from '~/server/utils/model-detail-cache-key';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';

/**
 * A shared cache for the model row `model.getById` starts from, behind the
 * `modelPublicPayloadCache` flag.
 *
 * WHAT IS CACHED: exactly the result of `findFirst({ where: { id }, select: modelWithDetailsSelect })`,
 * the read `getModel` makes for that handler. That read does not depend on who is asking (`getModel`
 * accepts a `user` and ignores it), so one entry serves every viewer. It is the raw row, before any
 * filtering: unpublished versions, private files, moderator-only flags and meta are all in it.
 *
 * WHAT IS NOT: everything `getModelHandler` derives from the row for one viewer still runs per
 * request on top of it — the blocked-user check, version visibility, file visibility, mod-only
 * fields, entity access, early access and pricing, generation state, metric privacy, owner-only
 * flag state, tags, resources. A field computed from the viewer can therefore only come out the
 * way it would have from a database read.
 *
 * FRESHNESS: `MODEL_DETAIL_PUBLIC_CACHE_TTL`, plus explicit busts on model and version writes
 * (`bustModelDetailPublicCache`). Three cases skip the cache and read the database as before:
 * - The model was written in the last replication-lag window (`getDbWithoutLag` returns the
 *   primary). Nothing is read from or written to the cache, so a row from before the write cannot
 *   be served, nor stored by a read that raced the write.
 * - The viewer owns the model: they are the one editing it, and a write path that does not bust
 *   would otherwise show them their own change late. Known only after the cached row is read, so an
 *   owner's view costs one cache read plus the database read it always made.
 * - The cache is slow or failing: see `fetchThroughCacheWithDeadline`.
 * Moderators do use the cache — the row carries everything their per-request view derives — so a
 * moderators-first rollout exercises the cached path.
 */

/**
 * How long the row is served before a read refreshes it, when a write path does not bust it. The
 * entry itself lives twice this (`fetchThroughCache` keeps it for stale-while-refresh), so a request
 * that loses the refresh lock can be served it for up to 2x this while another request refreshes:
 * normally milliseconds, longer only while the refresh itself is slow.
 */
export const MODEL_DETAIL_PUBLIC_CACHE_TTL = CacheTTL.xs;

/**
 * How long `model.getById` waits on the cache before reading the database instead. The handler
 * read the database directly before this cache existed, so a stalled cache must not hold it for
 * the Redis client's own socket timeout.
 */
export const MODEL_DETAIL_PUBLIC_CACHE_DEADLINE_MS = 500;

const CACHE_NAME = REDIS_KEYS.CACHES.MODEL_DETAIL_PUBLIC;

// The same read `getModel` makes, on the client the lag check already chose.
function readModelWithDetails(db: typeof dbRead, id: number) {
  return getModel({ id, select: modelWithDetailsSelect, db });
}

export type ModelWithDetailsRow = NonNullable<Awaited<ReturnType<typeof readModelWithDetails>>>;
type VersionRow = ModelWithDetailsRow['modelVersions'][number];

// The cache codec (msgpack) round-trips Dates and JSON columns but not `Prisma.Decimal`, which it
// would store as a plain object that `Number()` reads as NaN. `licensingFee` is the select's only
// Decimal column (pinned by a test), so it travels as its string form.
type CachedVersion = Omit<VersionRow, 'licensingFee'> & { licensingFee: string | null };
type CachedModelRow = Omit<ModelWithDetailsRow, 'modelVersions'> & {
  modelVersions: CachedVersion[];
};

function toCached(row: ModelWithDetailsRow | null): CachedModelRow | null {
  if (!row) return null;
  return {
    ...row,
    modelVersions: row.modelVersions.map((version) => ({
      ...version,
      licensingFee: version.licensingFee == null ? null : version.licensingFee.toString(),
    })),
  };
}

// Returns objects no other request holds: `getModelHandler` edits file metadata in place
// (`excludeTrainingData`), and on the cache's fail-open path concurrent requests on one process can
// be handed the same origin result. Versions, files and file metadata are copied for that reason.
function fromCached(row: CachedModelRow | null): ModelWithDetailsRow | null {
  if (!row) return null;
  return {
    ...row,
    modelVersions: row.modelVersions.map((version) => ({
      ...version,
      licensingFee: version.licensingFee == null ? null : new Prisma.Decimal(version.licensingFee),
      files: version.files.map((file) => ({
        ...file,
        metadata:
          file.metadata && typeof file.metadata === 'object' && !Array.isArray(file.metadata)
            ? { ...file.metadata }
            : file.metadata,
      })),
    })),
  };
}

/**
 * The `modelWithDetailsSelect` row for `id`, through the shared cache. Returns what
 * `getModel({ id, select: modelWithDetailsSelect })` returns, including `null` for a missing model.
 */
export async function getModelWithDetailsCached({
  id,
  viewerId,
}: {
  id: number;
  viewerId?: number;
}): Promise<ModelWithDetailsRow | null> {
  const db = await getDbWithoutLag('model', id);
  if (db !== dbRead) return readModelWithDetails(db, id);

  let missed = false;
  const cached = await fetchThroughCacheWithDeadline(
    modelDetailPublicCacheKey(id),
    async () => {
      missed = true;
      return toCached(await readModelWithDetails(dbRead, id));
    },
    { ttl: MODEL_DETAIL_PUBLIC_CACHE_TTL, deadlineMs: MODEL_DETAIL_PUBLIC_CACHE_DEADLINE_MS }
  );
  if (missed) {
    // A write can land while this read is in flight: its delete then precedes our refill, and the
    // replica we read may predate it. Writers set the lag mark before deleting
    // (`preventReplicationLag`), so a mark seen now means what we stored may be the old row: drop it
    // and read the primary, as the lag-window path above does. Bounded like the cache read; a slow
    // answer is taken as "no write", the case it almost always is.
    const after = await withTimeoutFallback(
      getDbWithoutLag('model', id),
      MODEL_DETAIL_PUBLIC_CACHE_DEADLINE_MS,
      dbRead
    );
    if (after !== dbRead) {
      cacheMissCounter.inc({ cache_name: CACHE_NAME, cache_type: 'fetchThroughCache' });
      await bustModelDetailPublicCache(id);
      return readModelWithDetails(after, id);
    }
  }

  const row = fromCached(cached);
  // The owner is known only once the row is read; their view is a fresh read, counted as a miss so
  // the hit ratio reflects rows actually served from the cache.
  const ownerRefresh = !!row && viewerId !== undefined && row.user.id === viewerId && !missed;
  (missed || ownerRefresh ? cacheMissCounter : cacheHitCounter).inc({
    cache_name: CACHE_NAME,
    cache_type: 'fetchThroughCache',
  });
  return ownerRefresh ? readModelWithDetails(dbRead, id) : row;
}
