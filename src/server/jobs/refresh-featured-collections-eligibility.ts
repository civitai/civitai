import { dbRead } from '~/server/db/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { homeBlockCacheBust } from '~/server/services/home-block-cache.service';
import type { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { HomeBlockType } from '~/shared/utils/prisma/enums';
import { createJob } from './job';

const DEFAULT_STALE_DAYS = 5;
const DEFAULT_MIN_RECENT_ITEMS = 3;
const STATE_KEY = REDIS_KEYS.HOMEBLOCKS.FEATURED_COLLECTIONS_STATE;
const LAST_PICKED_KEY = REDIS_KEYS.HOMEBLOCKS.FEATURED_COLLECTIONS_LAST_PICKED;

export type FeaturedCollectionEntry = {
  recentCount: number;
  lastAcceptedAt: string | null;
  currentName: string | null;
  nameChanged: boolean;
  eligible: boolean;
};

export type FeaturedCollectionsState = {
  eligibleIds: number[];
  perCollection: Record<number, FeaturedCollectionEntry>;
  computedAt: string;
};

export async function getFeaturedCollectionsState(): Promise<FeaturedCollectionsState | null> {
  const raw = await redis.get(STATE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as FeaturedCollectionsState;
    if (!parsed || !Array.isArray(parsed.eligibleIds)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeState(state: FeaturedCollectionsState) {
  await redis.set(STATE_KEY, JSON.stringify(state));
}

export async function getLastPickedId(): Promise<number | null> {
  const raw = await redis.get(LAST_PICKED_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Separate key (SET only) so concurrent hydration doesn't R-M-W the eligibility blob.
export async function setLastPickedId(id: number) {
  await redis.set(LAST_PICKED_KEY, String(id));
}

export async function computeFeaturedCollectionsState(): Promise<FeaturedCollectionsState | null> {
  const block = await dbRead.homeBlock.findFirst({
    where: { userId: -1, type: HomeBlockType.FeaturedCollections },
    select: { id: true, metadata: true },
  });
  if (!block) return null;

  const metadata = (block.metadata || {}) as HomeBlockMetaSchema;
  const pool = metadata.featuredCollections?.collectionIds ?? [];
  const snapshots = metadata.featuredCollections?.nameSnapshots ?? {};
  const staleDays = metadata.featuredCollections?.maxStaleDays ?? DEFAULT_STALE_DAYS;
  const minRecent = metadata.featuredCollections?.minRecentItems ?? DEFAULT_MIN_RECENT_ITEMS;

  if (pool.length === 0) {
    const empty: FeaturedCollectionsState = {
      eligibleIds: [],
      perCollection: {},
      computedAt: new Date().toISOString(),
    };
    await writeState(empty);
    await homeBlockCacheBust(HomeBlockType.FeaturedCollections, block.id);
    return empty;
  }

  const since = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);

  const [activityRows, nameRows] = await Promise.all([
    dbRead.$queryRaw<{ collectionId: number; recentCount: bigint; lastAcceptedAt: Date | null }[]>`
      SELECT
        ci."collectionId" AS "collectionId",
        COUNT(*) FILTER (WHERE COALESCE(ci."reviewedAt", ci."createdAt") >= ${since}) AS "recentCount",
        MAX(COALESCE(ci."reviewedAt", ci."createdAt")) AS "lastAcceptedAt"
      FROM "CollectionItem" ci
      WHERE ci."collectionId" = ANY(${pool}::int[])
        AND ci."status" = 'ACCEPTED'
      GROUP BY ci."collectionId"
    `,
    dbRead.collection.findMany({
      where: { id: { in: pool } },
      select: { id: true, name: true },
    }),
  ]);

  const activityById = new Map(activityRows.map((r) => [r.collectionId, r]));
  const nameById = new Map(nameRows.map((r) => [r.id, r.name]));

  const perCollection: Record<number, FeaturedCollectionEntry> = {};
  for (const id of pool) {
    const row = activityById.get(id);
    const count = row ? Number(row.recentCount) : 0;
    const currentName = nameById.get(id) ?? null;
    const approvedName = snapshots[id];
    const nameChanged = !!approvedName && currentName !== null && currentName !== approvedName;
    perCollection[id] = {
      recentCount: count,
      lastAcceptedAt: row?.lastAcceptedAt ? row.lastAcceptedAt.toISOString() : null,
      currentName,
      nameChanged,
      eligible: count >= minRecent && !nameChanged,
    };
  }

  const eligibleIds = pool.filter((id) => perCollection[id]?.eligible);

  const state: FeaturedCollectionsState = {
    eligibleIds,
    perCollection,
    computedAt: new Date().toISOString(),
  };
  await writeState(state);
  await homeBlockCacheBust(HomeBlockType.FeaturedCollections, block.id);
  return state;
}

export const refreshFeaturedCollectionsEligibility = createJob(
  'refresh-featured-collections-eligibility',
  '0 * * * *',
  async () => {
    const state = await computeFeaturedCollectionsState();
    if (!state) return { reason: 'no-featured-collections-block' };
    return {
      pool: Object.keys(state.perCollection).length,
      eligible: state.eligibleIds.length,
    };
  }
);
