import { redis, REDIS_KEYS } from '~/server/redis/client';
import type { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import type { HomeBlockWithData } from '~/server/services/home-block.service';
import { getHomeBlockData } from '~/server/services/home-block.service';
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
};

type HomeBlockForCache = {
  id: number;
  type: HomeBlockType;
  metadata: HomeBlockMetaSchema;
  sourceId?: number | null;
};

const log = createLogger('home-block-cache', 'green');

function getHomeBlockIdentifier(homeBlock: HomeBlockForCache) {
  switch (homeBlock.type) {
    case HomeBlockType.Collection:
      // Keyed by collection id so the ~110k clones of a system block share one entry and stay
      // reachable by homeBlockCacheBust(Collection, collectionId) when the collection changes.
      return homeBlock.metadata.collection?.id;
    case HomeBlockType.Leaderboard:
    case HomeBlockType.Announcement:
      return homeBlock.id;
    case HomeBlockType.CosmeticShop:
      // Clones read the section through to their source, so a section-id key would store source
      // data under the clone's stale snapshot id and poison blocks genuinely on that section.
      return homeBlock.sourceId ? homeBlock.id : homeBlock.metadata.cosmeticShopSection?.id;
    case HomeBlockType.FeaturedModelVersion:
      return 'default';
    case HomeBlockType.FeaturedCollections:
      return homeBlock.id;
  }
}

// Leaderboard blocks resolve different boards per color, so the cache key carries
// the domain. Without it the first color to warm a block serves every other one —
// a red-scoped board rendered onto civitai.com.
const domainSegment = (domain?: DomainColor) => domain ?? 'unscoped';

export async function getHomeBlockCached(homeBlock: HomeBlockForCache, domain?: DomainColor) {
  const identifier = getHomeBlockIdentifier(homeBlock);

  if (!identifier) return null;

  const cacheKey = `${REDIS_KEYS.HOMEBLOCKS.BASE}:${homeBlock.type}:${identifier}:${domainSegment(
    domain
  )}` as const;
  const cachedHomeBlock = await redis.packed.get<HomeBlockWithData>(cacheKey);

  if (cachedHomeBlock) return cachedHomeBlock;

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
    // ...but metadata may have been resolved through to the source block, so it can't come from
    // the clone's snapshot.
    metadata: homeBlockWithData?.metadata ?? homeBlock.metadata,
  };

  if (homeBlockWithData) {
    await redis.packed.set<HomeBlockWithData>(cacheKey, parsedHomeBlock, {
      EX: CACHE_EXPIRY[homeBlock.type],
    });

    log('getHomeBlockCached :: done getting system home blocks');
  }

  return parsedHomeBlock;
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
