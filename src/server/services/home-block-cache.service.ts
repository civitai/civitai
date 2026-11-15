import { FLIPT_FEATURE_FLAGS, isFliptSync } from '~/server/flipt/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { clusterCacheGuard } from '~/server/redis/cluster-cache-guard';
import { L1_CACHE_BYTE_BUDGETS } from '~/server/redis/l1-cache-budget';
import { bustFetchThroughCache } from '~/server/utils/cache-helpers';
import { createCachedFlagGate } from '~/server/utils/cached-flag-gate';
import { createLruCache } from '~/server/utils/lru-cache';
import type { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import type { HomeBlockWithData } from '~/server/services/home-block.service';
import { isCollectionReadShared } from '~/server/services/collection-item-access';
import { HomeBlockType } from '~/shared/utils/prisma/enums';
import type { DomainColor } from '~/shared/utils/prisma/enums';
import { colorDomainNames } from '~/shared/constants/domain.constants';
import { createLogger } from '~/utils/logging';

// Lazy: a static import here closes the image.service import cycle (no-image-service-import-cycle).
const homeBlockService = () => import('~/server/services/home-block.service');

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
  // Declared because the stored payload carries whichever row filled the shared entry, and the
  // hit path overwrites it from here. A caller that omitted it would hand back a stranger's.
  userId?: number;
};

const log = createLogger('home-block-cache', 'green');

// Not 'default': entries under that key predate the PG cap and must never be read again.
const FEATURED_MODELS_HOME_BLOCK_KEY = 'pg';

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
      return FEATURED_MODELS_HOME_BLOCK_KEY;
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

// ---------------------------------------------------------------------------------------------
// Per-process L1 over the shared Redis entry, behind `home-block-server-cache` (default OFF).
//
// It holds exactly what the Redis entry holds, under the same key (type, identifier, domain), and
// only what would be written there: a block whose content is the same for every viewer. Nothing
// viewer-specific is in it, because nothing viewer-specific is in the Redis entry either — the
// viewer gates (`canViewHomeBlock`, the collection audience) run in `getHomeBlockById` before this
// is reached, and a viewer-only collection never comes here. The per-row identity (id, userId,
// index, sourceId) and the resolved metadata are laid over the shared content on every call, hit
// or miss, and the cosmetic shop rotation is applied per request after it, as before.
//
// The TTL matches the procedure's edge cache. A bust clears this process's entries at once;
// another process keeps its copy for up to the TTL, the same window the edge cache already has.
export const HOME_BLOCK_L1_TTL_MS = 60_000;
const HOME_BLOCK_L1_MAX = 1_000;

const readHomeBlockL1Flag = () => isFliptSync(FLIPT_FEATURE_FLAGS.HOME_BLOCK_SERVER_CACHE);
let isHomeBlockL1On = createCachedFlagGate(readHomeBlockL1Flag);

const homeBlockL1 = createLruCache<string, HomeBlockWithData>({
  name: 'home-block-l1',
  max: HOME_BLOCK_L1_MAX,
  maxSize: L1_CACHE_BYTE_BUDGETS.homeBlocks,
  ttl: HOME_BLOCK_L1_TTL_MS,
  keyFn: (key) => key,
  fetchFn: () => Promise.reject(new Error('home-block-l1 is get/set only')),
});

/** The shared entry's key: every input that changes the shared content. */
export function homeBlockCacheKey(
  type: HomeBlockType,
  identifier: number | string,
  domain?: DomainColor
) {
  return `${REDIS_KEYS.HOMEBLOCKS.BASE}:${type}:${identifier}:${domainSegment(domain)}` as const;
}

/** Tests only: forget every L1 entry and the cached flag read, optionally reading `read` instead. */
export function resetHomeBlockL1ForTests(read: () => boolean | null = readHomeBlockL1Flag) {
  homeBlockL1.clear();
  isHomeBlockL1On = createCachedFlagGate(read);
}

export async function getHomeBlockCached(
  homeBlock: HomeBlockForCache,
  domain?: DomainColor,
  resolvedMetadata?: HomeBlockMetaSchema
) {
  const metadata =
    resolvedMetadata ?? (await (await homeBlockService()).resolveHomeBlockMetadata(homeBlock));
  const identifier = getHomeBlockIdentifier(homeBlock, metadata);

  if (!identifier) return null;

  const cacheKey = homeBlockCacheKey(homeBlock.type, identifier, domain);
  const useL1 = isHomeBlockL1On();
  const local = useL1 ? homeBlockL1.get(cacheKey) : undefined;
  // An unreadable cache (error, timeout, open breaker) is a miss: the block is built from source.
  const cachedHomeBlock =
    local ??
    (await clusterCacheGuard.readOr(
      'home-block-cache.getHomeBlockCached',
      () => redis.packed.get<HomeBlockWithData>(cacheKey),
      null
    ));

  // One entry serves every clone of a source, so the stored copy carries the identity of whichever
  // row filled it first. The content is shared; the identity is not — the caller asked about THIS
  // row and uses its id to place the block on the page.
  if (cachedHomeBlock) {
    if (useL1 && !local) homeBlockL1.set(cacheKey, cachedHomeBlock);
    return { ...cachedHomeBlock, ...homeBlock, metadata };
  }

  log(`getHomeBlockCached :: getting home block with identifier ${identifier}`);

  const homeBlockWithData = await (
    await homeBlockService()
  ).getHomeBlockData({
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

  // Only a collection everyone may read goes in this entry, which every viewer reads.
  const shareable =
    homeBlock.type !== HomeBlockType.Collection ||
    isCollectionReadShared(
      (homeBlockWithData as { collection?: { read?: string } } | null)?.collection?.read
    );
  if (homeBlockWithData && shareable) {
    if (useL1) homeBlockL1.set(cacheKey, parsedHomeBlock);
    await clusterCacheGuard.writeBestEffort('home-block-cache.getHomeBlockCached set', () =>
      redis.packed.set<HomeBlockWithData>(cacheKey, parsedHomeBlock, {
        EX: CACHE_EXPIRY[homeBlock.type],
      })
    );

    log('getHomeBlockCached :: done getting system home blocks');
  }

  // A copy: with the L1 on, `parsedHomeBlock` is the object later hits are served from.
  return { ...parsedHomeBlock };
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
  // `bustFetchThroughCache`, not `del`: a plain delete leaves concurrent readers with nothing to
  // serve, and the losers of the refill lock sleep out a retry. Resetting `cachedAt` lets them
  // serve stale while one refreshes — and the system map is on the homepage's hottest path.
  await Promise.all([
    bustFetchThroughCache(REDIS_KEYS.CACHES.HOME_BLOCKS_SYSTEM),
    bustFetchThroughCache(REDIS_KEYS.CACHES.HOME_BLOCKS_PERMANENT),
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
  // This process's L1 too, whatever the flag says now: an entry kept while it was on must not
  // outlive a bust if it is turned on again within the TTL.
  for (const key of keys) homeBlockL1.delete(key);
  await Promise.all(keys.map((key) => redis.del(key as typeof base)));
}

export async function bustFeaturedModelsHomeBlockCache() {
  await homeBlockCacheBust(HomeBlockType.FeaturedModelVersion, FEATURED_MODELS_HOME_BLOCK_KEY);
}
