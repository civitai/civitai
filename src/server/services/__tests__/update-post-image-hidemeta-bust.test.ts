import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';

// Transparent, not the canonical default, which is the REAL deadline wrapper. The old fixture
// also supplied a permissive proxy for all three key tables; the real ones come through the
// canonical registration instead, so any path that does not exist for real now reads undefined.
redisMock.withSysReadDeadline.mockImplementation((p: Promise<unknown>) => p);
import { dbMock } from '~/__tests__/mocks/db.mock';

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

const { mockBustImageDeliveryMetadataCache } = vi.hoisted(() => ({
  mockBustImageDeliveryMetadataCache: vi.fn(),
}));

// --- infra scaffold (mirrors contest-entry-resource-gate.test.ts) ---------------------
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('@civitai/db', () => ({
  createLagTracker: vi.fn(() => ({})),
  loadDbEnv: vi.fn(() => ({})),
}));
vi.mock('~/server/db/pgDb', () => ({ pgDbReadLong: {}, pgDbRead: {}, pgDbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  preventReplicationLag: vi.fn(),
  preventReplicationLagBatch: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

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

const { mockPurgeResizeCache } = vi.hoisted(() => ({
  mockPurgeResizeCache: vi.fn().mockResolvedValue(undefined),
}));
const mockFindUniqueOrThrow = dbMock.dbWrite.image.findUniqueOrThrow;
const mockImageUpdate = dbMock.dbWrite.image.update;

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
  purgeResizeCache: mockPurgeResizeCache,
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
function wireCurrentImage(hideMeta: boolean, meta: unknown = null) {
  mockFindUniqueOrThrow.mockResolvedValue({
    hideMeta,
    ingestion: 'Scanned',
    blockedFor: null,
    metadata: {},
    nsfwLevel: 1,
    meta,
  });
  mockImageUpdate.mockResolvedValue({ id: IMAGE_ID, url: IMAGE_URL, userId: USER_ID });
}

/**
 * The `data` object actually handed to `dbWrite.image.update`. Asserting the update
 * HAPPENED first is load-bearing: `expect(data.meta).toBeUndefined()` passes vacuously
 * against a mock that was never called, which is exactly how a "meta is untouched"
 * claim can be green while the column is being nulled.
 */
function updateData() {
  expect(mockImageUpdate).toHaveBeenCalledTimes(1);
  return mockImageUpdate.mock.calls[0][0].data as Record<string, unknown>;
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

    // 🔴 SCOPED, and the scope is the whole point. This image stays LIVE — the flip re-keys it, so
    // only the variants derived BEFORE the flip are stale. Passing the default ('all') here would
    // also drop the variants the page is serving right now. Nothing else pins this argument, so
    // without this assertion the caller could silently regress to a full purge of a live image.
    expect(mockPurgeResizeCache).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'hidden-meta-orphans' })
    );
  });

  it('ALSO busts on a true -> false hideMeta flip (both-direction guarantee)', async () => {
    wireCurrentImage(true); // stored hideMeta = true

    await updatePostImage({ id: IMAGE_ID, hideMeta: false } as any); // flip to false (reveal)

    // This is the case the adjacent purgeResizeCache guard MISSES — the bust must still fire.
    expect(mockBustImageDeliveryMetadataCache).toHaveBeenCalledTimes(1);

    // 🔴 AND NO PURGE. `keep=hm` retains the _hm variants, which on a true -> false flip are the
    // ORPHANS, not the live set — the scope is inverted in this direction and the cache service
    // says so in its own rejection message. Widening the guard to fire on both directions passed
    // every other test in this suite, so without this the invariant rested on nothing.
    expect(mockPurgeResizeCache).not.toHaveBeenCalled();
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

/**
 * What gets WRITTEN to `Image.meta`. The suite above pins the cache wiring and asserts
 * nothing about the write, which is how a hideMeta-only toggle came to null the column:
 * `meta` is absent from the input for that call, and an absent `meta` must mean "leave the
 * stored value alone", not "clear it". Prisma distinguishes the two by `undefined` (field
 * omitted from the UPDATE) vs `Prisma.JsonNull` (SQL NULL written), so these tests assert
 * on the `data` object handed to `dbWrite.image.update` rather than on any return value.
 */
describe('updatePostImage — Image.meta write semantics', () => {
  it('does NOT write meta when the input omits it (hideMeta: true — hide direction)', async () => {
    wireCurrentImage(false, { prompt: 'stored prompt' });

    await updatePostImage({ id: IMAGE_ID, hideMeta: true } as any);

    const data = updateData();
    expect(data.meta).toBeUndefined();
    // Explicit: `undefined` omits the column, `Prisma.JsonNull` destroys it. Only the
    // second is a data-loss bug, so name it rather than relying on toBeUndefined alone.
    expect(data.meta).not.toBe(Prisma.JsonNull);
    expect(data.hideMeta).toBe(true);
  });

  it('does NOT write meta when the input omits it (hideMeta: false — un-hide direction)', async () => {
    // The button toggles, so the destructive path fires in BOTH directions; a fix that
    // only covered the hide direction would leave "Show prompt" wiping the prompt.
    wireCurrentImage(true, { prompt: 'stored prompt' });

    await updatePostImage({ id: IMAGE_ID, hideMeta: false } as any);

    const data = updateData();
    expect(data.meta).toBeUndefined();
    expect(data.meta).not.toBe(Prisma.JsonNull);
    expect(data.hideMeta).toBe(false);
  });

  it('does NOT write meta when the input carries neither meta nor hideMeta', async () => {
    wireCurrentImage(false, { prompt: 'stored prompt' });

    await updatePostImage({ id: IMAGE_ID } as any);

    const data = updateData();
    expect(data.meta).toBeUndefined();
    expect(data.meta).not.toBe(Prisma.JsonNull);
  });

  it('DOES write Prisma.JsonNull when meta is explicitly null (the clear path still works)', async () => {
    // `updatePostImageSchema` also folds an all-undefined meta object down to `null`, so
    // this is the shape an intentional "clear the metadata" edit arrives in.
    wireCurrentImage(false, { prompt: 'stored prompt' });

    await updatePostImage({ id: IMAGE_ID, meta: null } as any);

    expect(updateData().meta).toBe(Prisma.JsonNull);
  });

  it('writes the supplied meta object when meta is provided', async () => {
    wireCurrentImage(false, { prompt: 'stored prompt' });

    await updatePostImage({ id: IMAGE_ID, meta: { prompt: 'new prompt' } } as any);

    const data = updateData();
    expect(data.meta).toEqual({ prompt: 'new prompt' });
    expect(data.meta).not.toBe(Prisma.JsonNull);
  });

  it('still re-derives provenance from the stored row when meta is provided', async () => {
    // #3871's actual purpose: a client cannot assert a derivation by editing its own
    // image. The verified ids come from the stored row, never from the payload.
    wireCurrentImage(false, { prompt: 'stored', extra: { sourceImageIds: [42] } });

    await updatePostImage({
      id: IMAGE_ID,
      meta: { prompt: 'new prompt', extra: { sourceImageIds: [999] } },
    } as any);

    const meta = updateData().meta as { extra: { sourceImageIds: number[] } };
    expect(meta.extra.sourceImageIds).toEqual([42]);
  });

  it('strips an unverified provenance claim when the stored row has none', async () => {
    wireCurrentImage(false, { prompt: 'stored' });

    await updatePostImage({
      id: IMAGE_ID,
      meta: { prompt: 'new prompt', extra: { sourceImageIds: [999] } },
    } as any);

    const meta = updateData().meta as { extra: Record<string, unknown> };
    expect(meta.extra).not.toHaveProperty('sourceImageIds');
  });
});
