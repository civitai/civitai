import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TRPCError } from '@trpc/server';
import type * as TextScanSubmit from '~/server/services/text-scan/submit';

// Publishing a post drafted from a storyline: the storyline step is checked before the publish is
// written and finished after it commits, and a post with no storyline link publishes exactly as
// before. Module-load scaffold from post.service.text-scan.test.ts.

const { prepareStorylinePublish, finishStorylinePublish } = vi.hoisted(() => ({
  prepareStorylinePublish: vi.fn(),
  finishStorylinePublish: vi.fn(),
}));
// Hand-listed: the real module's graph needs the server env, and these are all post.service uses.
vi.mock('~/server/services/storyline-publish.service', () => ({
  prepareStorylinePublish,
  finishStorylinePublish,
}));
vi.mock('~/server/services/text-scan/submit', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanSubmit>()),
  scanEntityInBackground: vi.fn(),
}));
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
  purgeResizeCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));

vi.mock('~/server/services/image-delivery.service', () => ({
  bustImageDeliveryMetadataCache: vi.fn(),
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
vi.mock('~/server/services/technique.service', () => ({ getTechniqueForWorkflow: vi.fn() }));
vi.mock('~/server/services/tool.service', () => ({
  getToolByAlias: vi.fn(),
  getToolByDomain: vi.fn(),
  getToolByName: vi.fn(),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));

const { updatePost } = await import('~/server/services/post.service');
const { userPostCountCache } = await import('~/server/redis/caches');

const POST_ID = 11;
const USER = { id: 5, isModerator: false } as never;
const tx = { post: { update: vi.fn() }, $queryRaw: vi.fn() };
const w = dbMock.dbWrite;
const NOW = new Date();
const STORED = { id: POST_ID, userId: 5, publishedAt: null, title: 'Hello' };
const PREPARED = { postId: POST_ID, storylineId: 3, userId: 5, kind: 'owner' };
const OUTCOME = { storylineId: 3, status: 'chapterWritten', chapterId: 9 };
const CONTEXT = { expectedPrice: 100, spendType: 'yellow' };

/** `written` is what the anti-bump UPDATE returns: empty when the guard refused the write. */
const publish = ({
  linked = true,
  written = [{ publishedAt: NOW }],
  data = { publishedAt: NOW } as Record<string, unknown>,
} = {}) => {
  w.storylinePendingChapter.findUnique.mockResolvedValue(
    (linked ? { postId: POST_ID } : null) as never
  );
  tx.$queryRaw.mockResolvedValue(written);
  return updatePost({ id: POST_ID, user: USER, storyline: CONTEXT, ...data } as never);
};

beforeEach(() => {
  vi.clearAllMocks();
  w.$transaction.mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx));
  w.image.findMany.mockResolvedValue([]);
  tx.post.update.mockImplementation(async () => ({ ...STORED }));
  prepareStorylinePublish.mockResolvedValue(PREPARED);
  finishStorylinePublish.mockResolvedValue(OUTCOME);
});

describe('publishing a post with no storyline link', () => {
  it('publishes as before, and returns the post alone', async () => {
    const post = await publish({ linked: false });

    expect(post).toEqual({ ...STORED, publishedAt: NOW });
    expect(post).not.toHaveProperty('storyline');
    expect(tx.post.update).toHaveBeenCalledTimes(1);
    expect(prepareStorylinePublish).not.toHaveBeenCalled();
    expect(finishStorylinePublish).not.toHaveBeenCalled();
    // `afterPostPublish` ran: the publish's own side effects are untouched.
    expect(userPostCountCache.refresh).toHaveBeenCalledWith([5]);
  });

  it('does not look for a link on an edit that publishes nothing', async () => {
    await publish({ data: { title: 'New title' } });

    expect(w.storylinePendingChapter.findUnique).not.toHaveBeenCalled();
    expect(prepareStorylinePublish).not.toHaveBeenCalled();
  });
});

describe('publishing a post drafted from a storyline', () => {
  it('checks the storyline step before the write, and finishes it after the commit', async () => {
    const order: string[] = [];
    prepareStorylinePublish.mockImplementation(async () => (order.push('prepare'), PREPARED));
    w.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => {
      order.push('publish');
      return fn(tx);
    });
    finishStorylinePublish.mockImplementation(async () => (order.push('finish'), OUTCOME));

    const post = await publish();

    expect(order).toEqual(['prepare', 'publish', 'finish']);
    expect(prepareStorylinePublish).toHaveBeenCalledWith({
      postId: POST_ID,
      actorId: 5,
      context: CONTEXT,
    });
    expect(finishStorylinePublish).toHaveBeenCalledWith(PREPARED);
    expect(post).toEqual({ ...STORED, publishedAt: NOW, storyline: OUTCOME });
    // The request's storyline context is not a column of the post.
    expect(tx.post.update.mock.calls[0][0].data).not.toHaveProperty('storyline');
  });

  it('writes nothing when the step refuses the publish', async () => {
    prepareStorylinePublish.mockRejectedValue(
      new TRPCError({
        code: 'BAD_REQUEST',
        message: 'storyline: the price changed while you were deciding: now 100 Buzz',
      })
    );

    await expect(publish()).rejects.toThrow('the price changed');
    expect(w.$transaction).not.toHaveBeenCalled();
    expect(finishStorylinePublish).not.toHaveBeenCalled();
  });

  it('finishes nothing when the publish was not written', async () => {
    const post = await publish({ written: [] });

    expect(finishStorylinePublish).not.toHaveBeenCalled();
    expect(post).not.toHaveProperty('storyline');
  });

  it('finishes nothing when the step had nothing to do', async () => {
    prepareStorylinePublish.mockResolvedValue(null);

    const post = await publish();

    expect(finishStorylinePublish).not.toHaveBeenCalled();
    expect(post).not.toHaveProperty('storyline');
  });
});
