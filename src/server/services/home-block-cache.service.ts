import { redis, REDIS_KEYS } from '~/server/redis/client';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { getHomeBlockData, HomeBlockWithData } from '~/server/services/home-block.service';
import { HomeBlockType } from '~/shared/utils/prisma/enums';
import { createLogger } from '~/utils/logging';

const CACHE_EXPIRY = {
  [HomeBlockType.Collection]: 60 * 3, // 3 min
  [HomeBlockType.Leaderboard]: 60 * 60, // 1 hr
  [HomeBlockType.Announcement]: 60 * 60, // 1 hr
  [HomeBlockType.Social]: 60 * 3, // 3 min - doesn't actually do anything since this is from metadata
  [HomeBlockType.Event]: 60 * 3, // 3 min - doesn't actually do anything since this is from metadata
  [HomeBlockType.CosmeticShop]: 60 * 3, // 3 min
};

type HomeBlockForCache = {
  id: number;
  type: HomeBlockType;
  metadata: HomeBlockMetaSchema;
};

const log = createLogger('home-block-cache', 'green');

function getHomeBlockIdentifier(homeBlock: HomeBlockForCache) {
  switch (homeBlock.type) {
    case HomeBlockType.Collection:
      return homeBlock.metadata.collection?.id;
    case HomeBlockType.Leaderboard:
    case HomeBlockType.Announcement:
      return homeBlock.id;
    case HomeBlockType.CosmeticShop:
      return homeBlock.metadata.cosmeticShopSection?.id;
  }
}

export async function getHomeBlockCached(homeBlock: HomeBlockForCache) {
  const identifier = getHomeBlockIdentifier(homeBlock);

  if (!identifier) return null;

  const cacheKey = `${REDIS_KEYS.HOMEBLOCKS.BASE}:${homeBlock.type}:${identifier}` as const;
  const cachedHomeBlock = await redis.packed.get<HomeBlockWithData>(cacheKey);

  if (cachedHomeBlock) return cachedHomeBlock;

  log(`getHomeBlockCached :: getting home block with identifier ${identifier}`);

  const homeBlockWithData = await getHomeBlockData({ homeBlock, input: { limit: 14 * 4 } });
  // Important that we combine these. Data might be the same for 2 blocks (i.e, 2 user collection blocks),
  // but other relevant info might differ (i.e, index of the block)
  const parsedHomeBlock = {
    ...(homeBlockWithData || {}),
    ...homeBlock,
  };

  if (homeBlockWithData) {
    await redis.packed.set<HomeBlockWithData>(cacheKey, parsedHomeBlock, {
      EX: CACHE_EXPIRY[homeBlock.type],
    });

    log('getHomeBlockCached :: done getting system home blocks');
  }

  return parsedHomeBlock;
}

export async function homeBlockCacheBust(type: HomeBlockType, entityId: number) {
  const redisString = `${REDIS_KEYS.HOMEBLOCKS.BASE}:${type}:${entityId}` as const;
  log(`Cache busted: ${redisString}`);
  await redis.del(redisString);
}
