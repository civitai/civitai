import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { LRUCache } from 'lru-cache';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { FLIPT_FEATURE_FLAGS, isFliptSync } from '~/server/flipt/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { clusterCacheGuard } from '~/server/redis/cluster-cache-guard';
import { L1_CACHE_BYTE_BUDGETS } from '~/server/redis/l1-cache-budget';
import { bustFetchThroughCache } from '~/server/utils/cache-helpers';
import { createCachedFlagGate } from '~/server/utils/cached-flag-gate';
import {
  countHomeBlockL1Eviction,
  countHomeBlockL1Hit,
  countHomeBlockL1Miss,
} from '~/server/prom/home-block-l1.metrics';
import type { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import type { HomeBlockWithData } from '~/server/services/home-block.service';
import { isCollectionReadShared } from '~/server/services/collection-item-access';
import { coverIndexExists } from '~/server/services/collection-media-index';
import { HomeBlockType } from '~/shared/utils/prisma/enums';
import type { DomainColor } from '~/shared/utils/prisma/enums';
import { colorDomainNames } from '~/shared/constants/domain.constants';
import { createLogger } from '~/utils/logging';

// Lazy, but not a cycle cut: the cycle guards count dynamic imports (docs/dev/import-cycles.md).
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
// STALENESS. A bust clears the Redis entry and THIS process's copy, but most busts run in a
// process that serves no home page (a job), so every serving process keeps its copy until it
// expires. A copy filled from a Redis hit also starts a fresh TTL, however old the Redis entry
// was. So the TTL is short, not the edge cache's 60s: that would stack with the edge and put a
// bust up to ~120s from reaching every viewer. With 10s, the worst case after a bust is 10s for a
// request that misses the edge (it was 0s), and 10s + the edge's 60s = 70s for one served from
// the edge (it was 60s). A copy outlives its Redis entry's natural expiry by at most 10s (every
// entry here is kept 3 min or more). The alternative, clipping each copy to the Redis entry's
// remaining TTL, bounds only that last case, never a bust, and costs a TTL read per fill.
export const HOME_BLOCK_L1_TTL_MS = 10_000;

// SIZE. The key space is (type, identifier, domain segment). The hot part is the system blocks
// every default home page shows (`getSystemHomeBlocks`, userId -1), each under at most 4 domain
// segments (`getRequestBoardDomainColor` answers green, blue, red or none); a user's own
// collection blocks add one key per public collection that is on someone's page. Sized to hold
// the hot part with room for users' blocks; `home_block_l1_evictions_total` shows whether it does.
const HOME_BLOCK_L1_MAX = 256;
// The byte cap is measured with an estimate, not a serialisation: `packed.get` hands back the
// decoded value only (the wire size is not exposed to the caller), and a JSON.stringify of a
// 56-item block on every fill is the cost this cache exists to remove. A block's size is driven
// by its item count, so the estimate is a fixed overhead plus an allowance per item. The 4KB
// allowance is a deliberately generous guess, not a measurement: an under-estimate would let the
// cache hold more than its budget, an over-estimate only evicts sooner (which the counter shows).
const HOME_BLOCK_L1_ENTRY_BYTES = 4 * 1024;
const HOME_BLOCK_L1_ITEM_BYTES = 4 * 1024;

const readHomeBlockL1Flag = () => isFliptSync(FLIPT_FEATURE_FLAGS.HOME_BLOCK_SERVER_CACHE);
let isHomeBlockL1On = createCachedFlagGate(readHomeBlockL1Flag);

/**
 * Array elements in a block, three levels down: the block's item lists (a collection's items, a
 * feed's items, a shop section's items) and lists one level inside a list (a board's results, a
 * picked collection's items). Walks containers only, never an item's fields, so it costs O(items).
 */
export function countHomeBlockItems(value: unknown, depth = 3): number {
  if (Array.isArray(value)) {
    let n = value.length;
    if (depth > 0) for (const v of value) n += countHomeBlockItems(v, depth - 1);
    return n;
  }
  if (!value || typeof value !== 'object' || depth <= 0) return 0;
  let n = 0;
  for (const v of Object.values(value)) n += countHomeBlockItems(v, depth - 1);
  return n;
}

export function estimateHomeBlockBytes(block: HomeBlockWithData): number {
  return HOME_BLOCK_L1_ENTRY_BYTES + countHomeBlockItems(block) * HOME_BLOCK_L1_ITEM_BYTES;
}

const homeBlockL1 = new LRUCache<string, HomeBlockWithData>({
  max: HOME_BLOCK_L1_MAX,
  maxSize: L1_CACHE_BYTE_BUDGETS.homeBlocks,
  sizeCalculation: (value) => Math.max(1, estimateHomeBlockBytes(value)),
  ttl: HOME_BLOCK_L1_TTL_MS,
  // 'evict' is a removal to make room; expiry, a bust ('delete') and replacement ('set') are not.
  dispose: (_value, _key, reason) => {
    if (reason === 'evict') countHomeBlockL1Eviction();
  },
});

/** Reads the L1, counting the answer as a hit or a miss. */
function readHomeBlockL1(key: string): HomeBlockWithData | undefined {
  const value = homeBlockL1.get(key);
  if (value === undefined) countHomeBlockL1Miss();
  else countHomeBlockL1Hit();
  return value;
}

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
  const local = useL1 ? readHomeBlockL1(cacheKey) : undefined;
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
    // A new top-level object per caller over shared nested content; see the note on the miss path.
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

  // A copy: with the L1 on, `parsedHomeBlock` is the object later hits are served from. SHALLOW:
  // it protects the top-level fields only. The nested content (items, boards) is shared with the
  // L1 and with every other caller, which is safe because no consumer mutates it: the controller
  // returns it, `getHomeBlockById` replaces (never edits) `cosmeticShopSection`, and the
  // procedure's middlewares only read the result.
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

const EVICT_IMAGE_BATCH = 1000;
const EVICT_BUST_BATCH = 100;
// The refill reads a replica, so the entry is refreshed again once replicas have caught up.
export const evictRetryDelayMs = () => Math.max(5, env.REPLICATION_LAG_DELAY) * 1000;

const logEvictFailure = (error: unknown) =>
  logToAxiom({
    type: 'error',
    name: 'home-block-evict-images',
    message: error instanceof Error ? error.message : String(error),
    error,
  });

type EvictTarget = { imageIds: number[] } | { userId: number } | { collectionIds: number[] };

// Only a collection anyone may read has a shared entry (see `isCollectionReadShared`); the others
// have nothing to refresh.
async function collectionsHolding(target: EvictTarget) {
  let batches: Prisma.Sql[];
  if ('userId' in target)
    batches = [
      Prisma.sql`SELECT DISTINCT ci."collectionId" FROM "CollectionItem" ci
        JOIN "Image" i ON i.id = ci."imageId"
        JOIN "Collection" c ON c.id = ci."collectionId"
        WHERE i."userId" = ${target.userId} AND c.read IN ('Public', 'Unlisted')`,
    ];
  else if ('collectionIds' in target)
    batches = chunk(target.collectionIds, EVICT_IMAGE_BATCH).map(
      (ids) => Prisma.sql`SELECT c.id AS "collectionId" FROM "Collection" c
        WHERE c.id = ANY(${ids}::int[]) AND c.read IN ('Public', 'Unlisted')`
    );
  else {
    // Without that index the cover lookup would scan every collection; the items are still found.
    const withCovers =
      target.imageIds.length > 0 &&
      (await coverIndexExists().catch((error: unknown) => {
        logEvictFailure(error);
        return false;
      }));
    batches = chunk(target.imageIds, EVICT_IMAGE_BATCH).map(
      (ids) => Prisma.sql`SELECT ci."collectionId" FROM "CollectionItem" ci
        JOIN "Collection" c ON c.id = ci."collectionId"
        WHERE ci."imageId" = ANY(${ids}::int[]) AND c.read IN ('Public', 'Unlisted')${
        withCovers
          ? Prisma.sql`
        UNION
        SELECT c.id FROM "Collection" c
        WHERE c."imageId" = ANY(${ids}::int[]) AND c.read IN ('Public', 'Unlisted')`
          : Prisma.empty
      }`
    );
  }
  const collectionIds = new Set<number>();
  for (const query of batches) {
    const rows = await dbRead.$queryRaw<{ collectionId: number }[]>(query);
    for (const { collectionId } of rows) collectionIds.add(collectionId);
  }
  return [...collectionIds];
}

/** The system FeaturedCollections blocks whose pool includes one of these collections. */
async function featuredBlocksShowing(collectionIds: number[]) {
  const ids = new Set(collectionIds);
  const blocks = await dbRead.homeBlock.findMany({
    where: { userId: -1, type: HomeBlockType.FeaturedCollections },
    select: { id: true, metadata: true },
  });
  return blocks
    .filter((block) =>
      (
        (block.metadata as HomeBlockMetaSchema | null)?.featuredCollections?.collectionIds ?? []
      ).some((id) => ids.has(id))
    )
    .map((block) => block.id);
}

async function bustHomeBlocksShowing(collectionIds: number[], featuredBlockIds: number[]) {
  const busts = [
    ...collectionIds.map((id) => () => homeBlockCacheBust(HomeBlockType.Collection, id)),
    ...featuredBlockIds.map(
      (id) => () => homeBlockCacheBust(HomeBlockType.FeaturedCollections, id)
    ),
  ];
  // Settled, so one failed bust does not leave the rest of the list in place.
  for (const batch of chunk(busts, EVICT_BUST_BATCH))
    for (const result of await Promise.allSettled(batch.map((bust) => bust())))
      if (result.status === 'rejected') logEvictFailure(result.reason);
}

/**
 * Refreshes every Collection and FeaturedCollections home block holding one of these images (as an
 * item, or as the collection's cover), now and again once replicas catch up. Call it after any
 * write that sets an image Blocked, once that write has committed. A delete passes the
 * `collectionIds` it resolved before the delete, since the delete takes the items with it.
 * Never throws: the write stands either way.
 * shortcut: the second refresh is an in-process timer, so it needs the process to keep running;
 * every caller today runs in the app's server process.
 */
export async function evictHomeBlocksForImages(target: EvictTarget) {
  let collectionIds: number[];
  let featuredBlockIds: number[];
  try {
    collectionIds = await collectionsHolding(target);
    if (!collectionIds.length) return;
    featuredBlockIds = await featuredBlocksShowing(collectionIds);
  } catch (error) {
    logEvictFailure(error);
    return;
  }
  await bustHomeBlocksShowing(collectionIds, featuredBlockIds);
  setTimeout(() => {
    bustHomeBlocksShowing(collectionIds, featuredBlockIds).catch(logEvictFailure);
  }, evictRetryDelayMs()).unref?.();
}

export async function bustFeaturedModelsHomeBlockCache() {
  await homeBlockCacheBust(HomeBlockType.FeaturedModelVersion, FEATURED_MODELS_HOME_BLOCK_KEY);
}
