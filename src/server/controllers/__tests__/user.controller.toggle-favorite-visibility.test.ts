import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import type * as UserService from '~/server/services/user.service';
import type * as ItemVisibility from '~/server/services/collection-item-visibility';
import type * as ResourceReviewService from '~/server/services/resourceReview.service';
import type * as RedisClient from '~/server/redis/client';

// Favoriting a model the user may not see is refused before anything is saved: no review, no
// notify engagement, no bookmark. Model 66 is hidden from the user here.

const { toggleReview, toggleModelEngagement, toggleBookmarked, assertVisible } = vi.hoisted(() => ({
  toggleReview: vi.fn(async () => true),
  toggleModelEngagement: vi.fn(async () => true),
  toggleBookmarked: vi.fn(async () => true),
  assertVisible: vi.fn(async ({ ids, isModerator }: { ids: number[]; isModerator?: boolean }) => {
    if (ids.includes(66) && !isModerator)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found' });
  }),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  toggleReview,
  toggleModelEngagement,
  toggleBookmarked,
}));
vi.mock('~/server/services/collection-item-visibility', async (importOriginal) => ({
  ...(await importOriginal<typeof ItemVisibility>()),
  assertCollectionItemsVisibleToViewer: assertVisible,
}));
vi.mock('~/server/services/resourceReview.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ResourceReviewService>()),
  getUserResourceReview: vi.fn(async () => []),
}));
vi.mock('~/server/redis/client', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisClient>()),
  redis: { del: vi.fn(async () => 1) },
}));

import { toggleFavoriteHandler } from '~/server/controllers/user.controller';

const favorite = (modelId: number, setTo: boolean, isModerator = false) =>
  toggleFavoriteHandler({
    input: { modelId, setTo },
    ctx: { user: { id: 42, isModerator, muted: false } },
  } as never);

beforeEach(() => vi.clearAllMocks());

describe('toggleFavoriteHandler', () => {
  it('refuses a model the user cannot see and saves nothing', async () => {
    await expect(favorite(66, true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(toggleReview).not.toHaveBeenCalled();
    expect(toggleModelEngagement).not.toHaveBeenCalled();
    expect(toggleBookmarked).not.toHaveBeenCalled();
  });

  it('favorites a model the user can see', async () => {
    await favorite(5, true);
    expect(toggleReview).toHaveBeenCalledTimes(1);
    expect(toggleBookmarked).toHaveBeenCalledTimes(1);
  });

  it('lets staff favorite it', async () => {
    await favorite(66, true, true);
    expect(toggleReview).toHaveBeenCalledTimes(1);
  });

  it('still lets the user unfavorite it', async () => {
    await favorite(66, false);
    expect(toggleReview).toHaveBeenCalledTimes(1);
  });
});
