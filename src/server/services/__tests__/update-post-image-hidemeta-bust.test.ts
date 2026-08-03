import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wiring test for the image-delivery metadata cache bust in `updatePostImage`.
 *
 * The bust FUNCTION is unit-tested in isolation (image-delivery-metadata-cache.test.ts);
 * this asserts the PRIVACY WIRING — that `updatePostImage` actually calls the bust on a
 * `hideMeta` change, in BOTH directions, and does NOT call it when hideMeta is unchanged
 * or omitted. That both-direction guarantee is the entire privacy argument: the adjacent
 * `purgeResizeCache` guard only fires on hide (`image.hideMeta &&`), so a future edit that
 * copies that guard onto the bust would silently stop busting on `true -> false` and stay
 * green without this test.
 *
 * post.service sits at the top of the service dependency graph, so the module-load scaffold
 * below mocks every sibling-service + infra import it pulls, mirroring
 * contest-entry-resource-gate.test.ts's approach (redis/db/kysely short-circuits) — the
 * minimal set needed to import post.service without kysely/@civitai/db or the heavy
 * image.service graph.
 */

const IMAGE_ID = 9001;
const IMAGE_URL = 'abc123/def456.jpeg';
const USER_ID = 5;

const { mockFindUniqueOrThrow, mockImageUpdate, mockBustImageDeliveryMetadataCache } = vi.hoisted(
  () => ({
    mockFindUniqueOrThrow: vi.fn(),
    mockImageUpdate: vi.fn(),
    mockBustImageDeliveryMetadataCache: vi.fn(),
  })
);

// --- infra scaffold (mirrors contest-entry-resource-gate.test.ts) ---------------------
vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: { get: vi.fn(), set: vi.fn(), del: vi.fn(), packed: { get: vi.fn(), set: vi.fn() } },
    sysRedis: { get: vi.fn(), set: vi.fn() },
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    REDIS_SUB_KEYS: keyProxy,
    withSysReadDeadline: vi.fn((p) => p),
  };
});
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('@civitai/db', () => ({
  createLagTracker: vi.fn(() => ({})),
  loadDbEnv: vi.fn(() => ({})),
}));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  preventReplicationLag: vi.fn(),
  preventReplicationLagBatch: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

// dbWrite is the only DB surface updatePostImage touches (findUniqueOrThrow + update).
vi.mock('~/server/db/client', () => ({
  dbRead: {},
  dbWrite: { image: { findUniqueOrThrow: mockFindUniqueOrThrow, update: mockImageUpdate } },
}));

// Every cache post.service imports — each a stub whose methods are no-op vi.fns. (Named
// exports must be statically present for ESM import binding; a Proxy has no own keys.)
vi.mock('~/server/redis/caches', () => {
  const cacheStub = () => ({
    refresh: vi.fn().mockResolvedValue(undefined),
    bust: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn(),
    refreshMany: vi.fn(),
  });
  return {
    imageMetaCache: cacheStub(),
    imageResourcesCache: cacheStub(),
    modelVersionAccessCache: cacheStub(),
    postStatCache: cacheStub(),
    thumbnailCache: cacheStub(),
    imageMetadataCache: cacheStub(),
    userBasicCache: cacheStub(),
    userImageVideoCountCaches: cacheStub(),
    userPostCountCache: cacheStub(),
  };
});

// The heavy image.service graph — replaced wholesale with the named exports post.service
// imports. `purgeResizeCache` is spied so we can assert the hide-only path independently.
vi.mock('~/server/services/image.service', () => ({
  createImage: vi.fn(),
  createImageResources: vi.fn(),
  deleteImageFromS3: vi.fn(),
  deleteImagesForModelVersionCache: vi.fn(),
  getImagesForPosts: vi.fn(),
  imagesForModelVersionsCache: { refresh: vi.fn() },
  enqueueImageIngestion: vi.fn(),
  invalidateManyImageExistence: vi.fn(),
  purgeImageGenerationDataCache: vi.fn(),
  purgeResizeCache: vi.fn().mockResolvedValue(undefined),
  queueImageSearchIndexUpdate: vi.fn(),
}));

// The unit under scrutiny: spy the bust so we can assert exactly when/whether it fires.
vi.mock('~/server/services/image-delivery.service', () => ({
  bustImageDeliveryMetadataCache: mockBustImageDeliveryMetadataCache.mockResolvedValue(undefined),
}));

// Other sibling services post.service imports — mocked so their graphs aren't evaluated.
vi.mock('~/server/services/collection.service', () => ({
  getCollectionById: vi.fn(),
  getUserCollectionPermissionsById: vi.fn(),
  removeEntityFromAllCollections: vi.fn(),
}));
vi.mock('~/server/services/cosmetic.service', () => ({ getCosmeticsForEntity: vi.fn() }));
vi.mock('~/server/services/post-collection-visibility', () => ({ canViewCollectionPost: vi.fn() }));
vi.mock('~/server/services/tag.service', () => ({
  findOrCreateTagsByName: vi.fn(),
  getVotableImageTags: vi.fn(),
}));
vi.mock('~/server/services/technique.service', () => ({ getTechniqueByName: vi.fn() }));
vi.mock('~/server/services/tool.service', () => ({
  getToolByAlias: vi.fn(),
  getToolByDomain: vi.fn(),
  getToolByName: vi.fn(),
}));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedLinkDomain: vi.fn() }));

// isValidAIGeneration is called before shouldIngest; keep it deterministic. shouldIngest is
// forced false via currentImage.blockedFor below, so its value doesn't affect the bust path.
vi.mock('~/utils/image-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/utils/image-utils')>();
  return { ...actual, isValidAIGeneration: vi.fn(() => true) };
});

const { updatePostImage } = await import('~/server/services/post.service');

const KEY_URL = IMAGE_URL;

// Build a currentImage row. blockedFor is anything BUT AiNotVerified so shouldIngest=false
// (no enqueueImageIngestion side effect on this path).
function wireCurrentImage(hideMeta: boolean) {
  mockFindUniqueOrThrow.mockResolvedValue({
    hideMeta,
    ingestion: 'Scanned',
    blockedFor: null,
    metadata: {},
    nsfwLevel: 1,
  });
  mockImageUpdate.mockResolvedValue({ id: IMAGE_ID, url: IMAGE_URL, userId: USER_ID });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBustImageDeliveryMetadataCache.mockResolvedValue(undefined);
});

describe('updatePostImage — image-delivery metadata cache bust wiring', () => {
  it('busts on a false -> true hideMeta flip (privacy-sensitive direction)', async () => {
    wireCurrentImage(false); // stored hideMeta = false

    await updatePostImage({ id: IMAGE_ID, hideMeta: true } as any); // flip to true

    expect(mockBustImageDeliveryMetadataCache).toHaveBeenCalledTimes(1);
    expect(mockBustImageDeliveryMetadataCache).toHaveBeenCalledWith(KEY_URL);
  });

  it('ALSO busts on a true -> false hideMeta flip (both-direction guarantee)', async () => {
    wireCurrentImage(true); // stored hideMeta = true

    await updatePostImage({ id: IMAGE_ID, hideMeta: false } as any); // flip to false (reveal)

    // This is the case the adjacent purgeResizeCache guard MISSES — the bust must still fire.
    expect(mockBustImageDeliveryMetadataCache).toHaveBeenCalledTimes(1);
    expect(mockBustImageDeliveryMetadataCache).toHaveBeenCalledWith(KEY_URL);
  });

  it('does NOT bust when hideMeta is unchanged (same value passed)', async () => {
    wireCurrentImage(false); // stored hideMeta = false

    await updatePostImage({ id: IMAGE_ID, hideMeta: false } as any); // no change

    expect(mockBustImageDeliveryMetadataCache).not.toHaveBeenCalled();
  });

  it('does NOT bust when hideMeta is omitted from the update', async () => {
    wireCurrentImage(false); // stored hideMeta = false

    await updatePostImage({ id: IMAGE_ID } as any); // hideMeta not part of the update

    expect(mockBustImageDeliveryMetadataCache).not.toHaveBeenCalled();
  });
});
