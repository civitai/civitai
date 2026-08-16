import { redis, REDIS_KEYS } from '~/server/redis/client';
import type { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import type { HomeBlockWithData } from '~/server/services/home-block.service';
import { getHomeBlockData, resolveHomeBlockMetadata } from '~/server/services/home-block.service';
import { HomeBlockType } from '~/shared/utils/prisma/enums';
import type { DomainColor } from '~/shared/utils/prisma/enums';
import { colorDomainNames } from '~/shared/constants/domain.constants';
import { createLogger } from '~/utils/logging';

const CACHE_EXPIRY = {
  [HomeBlockType.Collection]: 60 * 3, // 3 min
  [HomeBlockType.Leaderboard]: 60 * 60, // 1 hr
  [HomeBlockType.Announcement]: 60 * 60, // 1 hr
  [HomeBlockType.Social]: 60 * 3, // 3 min - doesn't actually do anything since this is from metadata
  [HomeBlockType.Event]: 60 * 3, // 3 min - doesn't actually do anything since this is from metadata
  [HomeBlockType.CosmeticShop]: 60 * 3, // 3 min
  [HomeBlockType.FeaturedModelVersion]: 60 * 60, // 1 hour
  [HomeBlockType.FeaturedCollections]: 60 * 3, // 3 min — random pick rotates on refresh
  [HomeBlockType.Feed]: 60 * 10, // 10 min — a live feed slice, so shorter than a board
};

type HomeBlockForCache = {
  id: number;
  type: HomeBlockType;
  metadata: HomeBlockMetaSchema;
  sourceId?: number | null;
};

const log = createLogger('home-block-cache', 'green');

/**
 * Takes RESOLVED metadata — the source block's, for a clone — never the row's own column. A
 * clone's column is empty now that it is a pointer, so keying off it would produce `undefined`
 * for Collection and CosmeticShop, and an identifier of `undefined` makes `getHomeBlockCached`
 * return null: the block does not error, it silently stops rendering.
 */
function getHomeBlockIdentifier(homeBlock: HomeBlockForCache, metadata: HomeBlockMetaSchema) {
  switch (homeBlock.type) {
    case HomeBlockType.Collection:
      // Keyed by the RESOLVED collection id so the ~114k clones of a system block share one entry
      // and stay reachable by homeBlockCacheBust(Collection, collectionId).
      return metadata.collection?.id;
    case HomeBlockType.Leaderboard:
    case HomeBlockType.Announcement:
      return homeBlock.sourceId ?? homeBlock.id;
    case HomeBlockType.CosmeticShop:
      // Resolved too, so clones of one source share a section-id entry rather than each holding
      // their own. Was keyed on the clone's own id back when the snapshot could disagree.
      return metadata.cosmeticShopSection?.id;
    case HomeBlockType.FeaturedModelVersion:
      return 'default';
    case HomeBlockType.FeaturedCollections:
    case HomeBlockType.Feed:
      // Source-keyed, so one entry serves every clone. It also makes the existing busts land:
      // both callers pass the SYSTEM block's id, which under a per-row key cleared one entry and
      // left every clone serving a stale pick until its own TTL expired.
      return homeBlock.sourceId ?? homeBlock.id;
  }
}

// Leaderboard blocks resolve different boards per color, so the cache key carries
// the domain. Without it the first color to warm a block serves every other one —
// a red-scoped board rendered onto civitai.com.
const domainSegment = (domain?: DomainColor) => domain ?? 'unscoped';

export async function getHomeBlockCached(homeBlock: HomeBlockForCache, domain?: DomainColor) {
  const metadata = await resolveHomeBlockMetadata(homeBlock);
  const identifier = getHomeBlockIdentifier(homeBlock, metadata);

  if (!identifier) return null;

  const cacheKey = `${REDIS_KEYS.HOMEBLOCKS.BASE}:${homeBlock.type}:${identifier}:${domainSegment(
    domain
  )}` as const;
  const cachedHomeBlock = await redis.packed.get<HomeBlockWithData>(cacheKey);

  // One entry serves every clone of a source, so the stored copy carries the identity of whichever
  // row filled it first. The content is shared; the identity is not — the caller asked about THIS
  // row and uses its id to place the block on the page.
  if (cachedHomeBlock) return { ...cachedHomeBlock, ...homeBlock, metadata };

  log(`getHomeBlockCached :: getting home block with identifier ${identifier}`);

  const homeBlockWithData = await getHomeBlockData({
    homeBlock,
    input: { limit: 14 * 4, domain },
  });
  // Important that we combine these. Data might be the same for 2 blocks (i.e, 2 user collection blocks),
  // but other relevant info might differ (i.e, index of the block)
  const parsedHomeBlock = {
    ...(homeBlockWithData || {}),
    ...homeBlock,
    // ...and never the clone's own column, which is empty now that it is a pointer.
    metadata,
  };

  if (homeBlockWithData) {
    await redis.packed.set<HomeBlockWithData>(cacheKey, parsedHomeBlock, {
      EX: CACHE_EXPIRY[homeBlock.type],
    });

    log('getHomeBlockCached :: done getting system home blocks');
  }

  return parsedHomeBlock;
}

/**
 * Bust everything a write to a SYSTEM block invalidates: the system-metadata map every clone
 * resolves through, the permanent-block list, and the block's own rendered entry — which clones
 * now share, so this one call reaches all of them.
 */
export async function bustSystemHomeBlockCaches(row?: {
  id: number;
  type: HomeBlockType;
  metadata?: HomeBlockMetaSchema | unknown;
}) {
  await Promise.all([
    redis.del(REDIS_KEYS.CACHES.HOME_BLOCKS_SYSTEM),
    redis.del(REDIS_KEYS.CACHES.HOME_BLOCKS_PERMANENT),
  ]);

  if (!row) return;
  const identifier = getHomeBlockIdentifier(
    { id: row.id, type: row.type, metadata: {} as HomeBlockMetaSchema },
    (row.metadata || {}) as HomeBlockMetaSchema
  );
  if (identifier) await homeBlockCacheBust(row.type, identifier);
}

export async function homeBlockCacheBust(type: HomeBlockType, entityId: number | string) {
  // One entry per color, so a bust has to clear them all. Also clears the
  // un-suffixed legacy key so entries written before domain keying still drop.
  const base = `${REDIS_KEYS.HOMEBLOCKS.BASE}:${type}:${entityId}` as const;
  const keys = [
    base,
    ...[...colorDomainNames, undefined].map((d) => `${base}:${domainSegment(d)}`),
  ];
  log(`Cache busted: ${base} (${keys.length} keys)`);
  await Promise.all(keys.map((key) => redis.del(key as typeof base)));
}
