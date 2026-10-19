import { Prisma } from '@prisma/client';
import { CacheTTL } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { getDbWithoutLag } from '~/server/db/db-lag-helpers';
import { cacheHitCounter, cacheMissCounter } from '~/server/prom/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { modelWithDetailsSelect } from '~/server/selectors/model.selector';
import { fetchThroughCacheWithDeadline } from '~/server/utils/cache-helpers';
import { modelDetailPublicCacheKey } from '~/server/utils/model-detail-cache-key';

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

/** How stale the row can be when a write path does not bust it. */
export const MODEL_DETAIL_PUBLIC_CACHE_TTL = CacheTTL.xs;

/**
 * How long `model.getById` waits on the cache before reading the database instead. The handler
 * read the database directly before this cache existed, so a stalled cache must not hold it for
 * the Redis client's own socket timeout.
 */
export const MODEL_DETAIL_PUBLIC_CACHE_DEADLINE_MS = 500;

const CACHE_NAME = REDIS_KEYS.CACHES.MODEL_DETAIL_PUBLIC;

function readModelWithDetails(db: typeof dbRead, id: number) {
  return db.model.findFirst({ where: { id }, select: modelWithDetailsSelect });
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

function fromCached(row: CachedModelRow | null): ModelWithDetailsRow | null {
  if (!row) return null;
  return {
    ...row,
    modelVersions: row.modelVersions.map((version) => ({
      ...version,
      licensingFee: version.licensingFee == null ? null : new Prisma.Decimal(version.licensingFee),
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
  (missed ? cacheMissCounter : cacheHitCounter).inc({
    cache_name: CACHE_NAME,
    cache_type: 'fetchThroughCache',
  });

  const row = fromCached(cached);
  if (row && viewerId !== undefined && row.user.id === viewerId && !missed) {
    return readModelWithDetails(dbRead, id);
  }
  return row;
}
