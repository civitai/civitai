import { Prisma } from '@prisma/client';
import { CacheTTL } from '~/server/common/constants';
import { loadKyselyDb } from '~/server/db/kyselyDb.lazy';
import { isPgInt4, queryPrismaSql } from '~/server/db/prisma-sql-kysely';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { createCachedObject } from '~/server/utils/cache-helpers';

/**
 * Which host images have ANY remix-gallery placement, in any status: a negative cache in front
 * of the card summaries and the gallery existence check (remix-gallery.service), which run on
 * feed cards and image detail views where almost no host has a gallery entry at all.
 *
 * Membership is a superset of "has an entry this viewer may see", so the reads still filter by
 * visibility; the cache only lets them skip the database for a host with no placement row. A
 * host can only JOIN the set: Placement rows of this surface are inserted and their status
 * changes, but no path in the repository deletes one. So the one write that can make a cached
 * answer wrong is an INSERT, and every insert busts (`bustRemixGalleryHosts`, ledger in
 * `__tests__/remix-gallery-hosts-writers.test.ts`). A row that did vanish out of band would leave
 * a stale "has entries", which costs the full query and changes nothing on screen.
 *
 * Approval busts too, though it does not change membership: an entry renders only once approved,
 * so if a fill raced the insert's bust (a lookup or replica lag outlasting `debounceTime`), the
 * approval clears the stale negative before there is anything to show.
 */

// The surface and target type of a remix-gallery placement. Defined here, not in
// remix-gallery.service, because that module imports this one; it reads them from here.
export const REMIX_GALLERY_SURFACE = 'remixGallery' as const;
export const REMIX_GALLERY_TARGET_TYPE = 'image' as const;

/** How long a cached answer lives without a bust. Long: every insert busts (see above). */
export const REMIX_GALLERY_HOSTS_TTL = CacheTTL.day;

type HostWithEntries = { hostId: number };

/**
 * The ids among `hostIds` with any placement of this surface, from the replica. Every id must fit
 * int4 (`getRemixGalleryHostsWithEntries` drops the rest): one that does not fails the cast.
 */
export async function queryHostsWithEntries(hostIds: number[]): Promise<number[]> {
  if (!hostIds.length) return [];
  const { kyselyRead } = await loadKyselyDb();
  const rows = await queryPrismaSql<{ hostId: number }>(
    kyselyRead,
    Prisma.sql`
      SELECT DISTINCT pl."targetId" AS "hostId"
      FROM "Placement" pl
      WHERE pl.surface = ${REMIX_GALLERY_SURFACE}
        AND pl."targetType" = ${REMIX_GALLERY_TARGET_TYPE}
        AND pl."targetId" = ANY(${hostIds}::int[])
    `
  );
  return rows.map((row) => row.hostId);
}

// Lazy, like the other module-level cached objects: a top-level createCachedObject() breaks any
// suite that partially mocks cache-helpers and only transitively imports this module.
let cacheInstance: ReturnType<typeof createRemixGalleryHostsCache> | undefined;
function createRemixGalleryHostsCache() {
  return createCachedObject<HostWithEntries>({
    key: REDIS_KEYS.CACHES.REMIX_GALLERY_HOSTS,
    idKey: 'hostId',
    ttl: REMIX_GALLERY_HOSTS_TTL,
    // A bust removes the answer rather than serving it while a revalidation runs.
    staleWhileRevalidate: false,
    // A fill (SET NX) loses to a bust's marker while it lives, so a lookup that read the replica
    // before an insert cannot cache "no entries" over the bust. 10s outlasts lookup + replica lag.
    fillIfAbsent: true,
    debounceTime: 10,
    // Hosts with no placement are the point: cached as notFound markers (the default).
    lookupFn: async (ids) => {
      const hostIds = (Array.isArray(ids) ? ids : [ids]).filter((id) => id != null);
      const found = await queryHostsWithEntries(hostIds);
      return Object.fromEntries(found.map((hostId) => [String(hostId), { hostId }]));
    },
  });
}
function remixGalleryHostsCache() {
  return (cacheInstance ??= createRemixGalleryHostsCache());
}

/** The ids among `hostIds` that have any remix-gallery placement (see the module comment). */
export async function getRemixGalleryHostsWithEntries(hostIds: number[]): Promise<Set<number>> {
  // An id past int4 is no image, so it has no placement: dropped here, before the cache and the
  // lookup, where it would fail the `::int[]` cast (Prisma's raw read answered it with no rows).
  const ids = [...new Set(hostIds)].filter(isPgInt4);
  if (!ids.length) return new Set();
  const cached = await remixGalleryHostsCache().fetch(ids);
  return new Set(Object.values(cached).map((entry) => entry.hostId));
}

/**
 * Drops a host's cached answer. Call it after a committed write that inserts a remix-gallery
 * placement on it (and on approval, see the module comment).
 *
 * Never throws: the write it follows has committed, and a Redis failure must not turn it into an
 * error. What a lost bust costs is bounded by the TTL, and an approval busts again.
 */
export async function bustRemixGalleryHosts(hostIds: number[]): Promise<void> {
  const ids = [...new Set(hostIds)];
  if (!ids.length) return;
  try {
    await remixGalleryHostsCache().bust(ids);
  } catch (error) {
    Promise.resolve()
      .then(() =>
        logToAxiom({
          type: 'error',
          name: 'remix-gallery-hosts-bust',
          message: (error as Error)?.message,
          count: ids.length,
        })
      )
      .catch(() => undefined);
  }
}
