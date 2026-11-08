import { Prisma } from '@prisma/client';
import { CacheTTL } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { createCachedObject } from '~/server/utils/cache-helpers';
import type { CollectionItemRejectionReason } from '~/shared/utils/prisma/enums';

/**
 * The contest entries one image has, for the image detail view (`getImageContestCollectionDetails`).
 *
 * Two caches read through `queryContestCollectionItems`: the per-pod LRU in image.service (flag
 * OFF) and the shared Redis cache below (flag `contest-collection-items-redis-cache` ON). One query
 * for both, so the two cannot disagree about what an entry is.
 */
export type ContestCollectionItem = {
  id: number;
  imageId: number;
  addedById: number | null;
  status: string;
  tag: { id: number; name: string } | null;
  collection: { id: number; name: string; metadata: Prisma.JsonValue; mode: 'Contest' };
  scores: { userId: number; score: number }[];
  rejectionReason: CollectionItemRejectionReason | null;
  rejectionDetail: string | null;
};

/**
 * What the SHARED cache holds: an entry without its rejection reason.
 *
 * 🔴 The reason, and above all the reviewer's free text, is readable only by the submitter, the
 * collection's managers and moderators. A shared value is served to every viewer of the image, so
 * the text stays out of it and is read live, per viewer, only for one who passes that gate
 * (`getContestRejections`). `addedById` stays because the gate is decided on it; it is stripped
 * from the response exactly as on the LRU path.
 */
export type SharedContestCollectionItem = Omit<
  ContestCollectionItem,
  'rejectionReason' | 'rejectionDetail'
>;

type CachedContestCollectionItems = { imageId: number; items: SharedContestCollectionItem[] };

export async function queryContestCollectionItems(
  imageIds: number[]
): Promise<ContestCollectionItem[]> {
  if (!imageIds.length) return [];
  return dbRead.$queryRaw<ContestCollectionItem[]>`
    SELECT
      ci.id,
      ci."imageId",
      ci."addedById",
      ci.status,
      ci."rejectionReason"::text as "rejectionReason",
      ci."rejectionDetail",
      CASE WHEN t.id IS NOT NULL
        THEN jsonb_build_object('id', t.id, 'name', t.name)
        ELSE NULL
      END as tag,
      jsonb_build_object('id', c.id, 'name', c.name, 'metadata', c.metadata, 'mode', c.mode) as collection,
      COALESCE(
        (SELECT jsonb_agg(jsonb_build_object('userId', cis."userId", 'score', cis.score))
         FROM "CollectionItemScore" cis
         WHERE cis."collectionItemId" = ci.id),
        '[]'::jsonb
      ) as scores
    FROM "CollectionItem" ci
    JOIN "Collection" c ON c.id = ci."collectionId"
    LEFT JOIN "Tag" t ON t.id = ci."tagId"
    WHERE ci."imageId" IN (${Prisma.join(imageIds)})
      AND c.mode = 'Contest'
  `;
}

export function toSharedContestCollectionItem({
  rejectionReason: _reason,
  rejectionDetail: _detail,
  ...shared
}: ContestCollectionItem): SharedContestCollectionItem {
  return shared;
}

/**
 * How long an entry can be stale when its writer does not bust it. Every write to one image's
 * entries that has the image ids in hand busts (see `bustContestCollectionItemsCache` and the
 * ledger in `__tests__/contest-collection-items-writers.test.ts`); what remains are
 * collection-wide job updates and collection-level edits (name, metadata, delete), which this
 * bounds.
 */
export const CONTEST_COLLECTION_ITEMS_TTL = CacheTTL.md;

// Lazy, like the other module-level cached objects: a top-level createCachedObject() breaks any
// suite that partially mocks cache-helpers and only transitively imports this module.
let cacheInstance: ReturnType<typeof createContestCollectionItemsCache> | undefined;
function createContestCollectionItemsCache() {
  return createCachedObject<CachedContestCollectionItems>({
    key: REDIS_KEYS.CACHES.CONTEST_COLLECTION_ITEMS,
    idKey: 'imageId',
    ttl: CONTEST_COLLECTION_ITEMS_TTL,
    // No stale-while-revalidate: after a bust the cached entry is gone, not served while a
    // revalidation runs.
    staleWhileRevalidate: false,
    // 10s, not the helper default: a fill (SET NX) only loses to the bust marker while it lives, so
    // the window must outlast lookup + replica lag. A longer fill can still cache a pre-write value
    // until the TTL.
    fillIfAbsent: true,
    debounceTime: 10,
    // Most images are in no contest; those are cached as notFound markers (the default) for the
    // same TTL, and a bust replaces the marker like any other entry.
    lookupFn: async (ids) => {
      const imageIds = (Array.isArray(ids) ? ids : [ids]).filter((id) => id != null);
      const rows = await queryContestCollectionItems(imageIds);
      const byImage: Record<string, CachedContestCollectionItems> = {};
      for (const row of rows) {
        const entry = (byImage[String(row.imageId)] ??= { imageId: row.imageId, items: [] });
        entry.items.push(toSharedContestCollectionItem(row));
      }
      return byImage;
    },
  });
}
function contestCollectionItemsCache() {
  return (cacheInstance ??= createContestCollectionItemsCache());
}

export async function fetchSharedContestCollectionItems(
  imageId: number
): Promise<SharedContestCollectionItem[]> {
  const cached = await contestCollectionItemsCache().fetch([imageId]);
  return cached[String(imageId)]?.items ?? [];
}

/**
 * The rejection fields for entries this viewer may read them on, live from the database. Never
 * cached: see `SharedContestCollectionItem`.
 */
export async function getContestRejections(collectionItemIds: number[]) {
  const out = new Map<
    number,
    { rejectionReason: CollectionItemRejectionReason | null; rejectionDetail: string | null }
  >();
  if (!collectionItemIds.length) return out;
  const rows = await dbRead.$queryRaw<
    {
      id: number;
      rejectionReason: CollectionItemRejectionReason | null;
      rejectionDetail: string | null;
    }[]
  >`
    SELECT id, "rejectionReason"::text as "rejectionReason", "rejectionDetail"
    FROM "CollectionItem"
    WHERE id IN (${Prisma.join(collectionItemIds)})
  `;
  for (const row of rows)
    out.set(row.id, { rejectionReason: row.rejectionReason, rejectionDetail: row.rejectionDetail });
  return out;
}

// Logging must not be able to fail the write either, whatever logToAxiom returns.
function logBustFailure(error: unknown, count: number) {
  Promise.resolve()
    .then(() =>
      logToAxiom({
        type: 'error',
        name: 'contest-collection-items-bust',
        message: (error as Error)?.message,
        count,
      })
    )
    .catch(() => undefined);
}

/**
 * Drops these images' cached contest entries. Call it after any committed write that changes an
 * entry of an image (status, tag, score, add, remove).
 *
 * Unconditional on the flag: it costs one Redis write per image, and a bust skipped while the
 * flag was off would leave an entry cached before that stale once it is back on.
 *
 * Never throws — the write it follows has already committed, and a Redis failure here must not
 * turn it into an error. The TTL bounds what a lost bust costs.
 */
export async function bustContestCollectionItemsCache(
  imageIds: (number | null | undefined)[]
): Promise<void> {
  const ids = [...new Set(imageIds.filter((id): id is number => typeof id === 'number'))];
  if (!ids.length) return;
  try {
    await contestCollectionItemsCache().bust(ids);
  } catch (error) {
    logBustFailure(error, ids.length);
  }
}

/** The same bust for a writer that holds collection item ids rather than image ids. */
export async function bustContestCollectionItemsCacheForItems(
  collectionItemIds: number[]
): Promise<void> {
  if (!collectionItemIds.length) return;
  try {
    const rows = await dbWrite.collectionItem.findMany({
      where: { id: { in: collectionItemIds }, imageId: { not: null } },
      select: { imageId: true },
    });
    await bustContestCollectionItemsCache(rows.map((row) => row.imageId));
  } catch (error) {
    logBustFailure(error, collectionItemIds.length);
  }
}
