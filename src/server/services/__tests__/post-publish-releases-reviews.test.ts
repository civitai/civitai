import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as Caches from '~/server/redis/caches';
import type * as LagHelpers from '~/server/db/db-lag-helpers';
import type * as PointsHooks from '~/server/events/points/hooks';
import type * as ReviewVisibility from '~/server/services/resourceReview.visibility';
import type * as Submit from '~/server/services/text-scan/submit';

/** Reviews written from a post wait for it; a publish now releases them, a scheduled date does not. */

const { sync } = vi.hoisted(() => ({
  sync: vi.fn<(typeof ReviewVisibility)['syncReviewsOfMovedPosts']>(),
}));

vi.mock('~/server/services/resourceReview.visibility', async (importOriginal) => ({
  ...(await importOriginal<typeof ReviewVisibility>()),
  syncReviewsOfMovedPosts: sync,
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent: async () => undefined,
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof LagHelpers>()),
  preventReplicationLag: async () => undefined,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return {
    ...actual,
    userPostCountCache: { ...actual.userPostCountCache, refresh: async () => undefined },
    userImageVideoCountCaches: {
      ...actual.userImageVideoCountCaches,
      refresh: async () => undefined,
    },
  };
});
vi.mock('~/server/events/points/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof PointsHooks>()),
  onStorySparkPostsRestored: async () => undefined,
}));
vi.mock('~/server/services/text-scan/submit', async (importOriginal) => ({
  ...(await importOriginal<typeof Submit>()),
  scanEntityInBackground: () => undefined,
}));

const { updatePost } = await import('~/server/services/post.service');
const { userHasReceivedReviewsCache } = await import('~/server/redis/caches');
const refreshHasReceivedReviews = vi
  .spyOn(userHasReceivedReviewsCache, 'refresh')
  .mockResolvedValue(undefined as never);

const POST_ID = 1;
const DAY = 24 * 60 * 60 * 1000;

const publishAt = async (publishedAt: Date) => {
  dbMock.dbWrite.post.update.mockResolvedValue({
    id: POST_ID,
    userId: 5,
    publishedAt: null,
  } as never);
  // The guarded publish UPDATE writes the date it was given.
  dbMock.dbWrite.$queryRaw.mockResolvedValue([{ publishedAt }] as never);
  await updatePost({
    id: POST_ID,
    publishedAt,
    user: { id: 9, isModerator: true },
  } as never);
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('updatePost releasing the reviews written from the post', () => {
  it('releases them when the post is published now', async () => {
    await publishAt(new Date(Date.now() - 1000));

    expect(sync).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ change: 'publish', postIds: [POST_ID] })
    );
  });

  it("refreshes the model owners' has-received-reviews flag once per owner", async () => {
    await publishAt(new Date(Date.now() - 1000));
    const { onReviews } = sync.mock.calls[0][0];

    await onReviews([{ modelOwnerId: 7 }, { modelOwnerId: 7 }, { modelOwnerId: 8 }]);

    expect(refreshHasReceivedReviews).toHaveBeenCalledExactlyOnceWith([7, 8]);
  });

  it('leaves them for the scheduled-publishing job when the post is scheduled', async () => {
    await publishAt(new Date(Date.now() + DAY));

    expect(sync).not.toHaveBeenCalled();
  });
});
