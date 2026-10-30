import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The review handlers are the half of the block fix that makes it reach production: the guard lives
 * in the service, but the service only knows who is acting because the handler passes it. Dropping
 * `userId` leaves the guard asking whether an undefined user is blocked — a silent no-op on the
 * exact path the guard exists to close — and no service-level test can see that.
 */

const { mockCreate, mockUpdate, mockUpsert, mockHasEntityAccess } = vi.hoisted(() => ({
  mockCreate: vi.fn(
    async (..._a: unknown[]): Promise<unknown> => ({
      id: 1,
      modelId: 10,
      modelVersionId: 20,
      recommended: true,
    })
  ),
  mockUpdate: vi.fn(
    async (..._a: unknown[]): Promise<unknown> => ({
      id: 1,
      modelId: 10,
      modelVersionId: 20,
      rating: 5,
      nsfw: false,
    })
  ),
  mockUpsert: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 1 })),
  mockHasEntityAccess: vi.fn(async (..._a: unknown[]): Promise<unknown> => [{ hasAccess: true }]),
}));

vi.mock('~/server/services/resourceReview.service', () => ({
  createResourceReview: (...a: unknown[]) => mockCreate(...(a as [])),
  updateResourceReview: (...a: unknown[]) => mockUpdate(...(a as [])),
  upsertResourceReview: (...a: unknown[]) => mockUpsert(...(a as [])),
  deleteResourceReview: vi.fn(),
  getUserRatingTotals: vi.fn(),
  toggleExcludeResourceReview: vi.fn(),
}));
vi.mock('~/server/services/common.service', () => ({
  hasEntityAccess: (...a: unknown[]) => mockHasEntityAccess(...(a as [])),
}));
import {
  createResourceReviewHandler,
  updateResourceReviewHandler,
  upsertResourceReviewHandler,
} from '../resourceReview.controller';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const USER_ID = 7;

const ctx = ({ isModerator = false } = {}) =>
  ({
    user: { id: USER_ID, isModerator },
    track: { resourceReview: vi.fn() },
  } as unknown as Parameters<typeof createResourceReviewHandler>[0]['ctx']);

const createInput = {
  modelId: 10,
  modelVersionId: 20,
  rating: 5,
  recommended: true,
  details: null,
} as Parameters<typeof createResourceReviewHandler>[0]['input'];

const updateInput = { id: 1, rating: 5, details: null } as Parameters<
  typeof updateResourceReviewHandler
>[0]['input'];

beforeEach(() => {
  vi.clearAllMocks();
  mockHasEntityAccess.mockResolvedValue([{ hasAccess: true }]);
});

describe('resource review handlers — who the guard is told is acting', () => {
  it('create passes the caller and their moderator status', async () => {
    await createResourceReviewHandler({ input: createInput, ctx: ctx() });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, isModerator: false })
    );
  });

  it('update passes the caller and their moderator status', async () => {
    await updateResourceReviewHandler({ input: updateInput, ctx: ctx() });
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, userId: USER_ID, isModerator: false })
    );
  });

  it('upsert passes the caller and their moderator status', async () => {
    await upsertResourceReviewHandler({ input: createInput, ctx: ctx() });
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, isModerator: false })
    );
  });

  // A moderator must arrive as one, or the guard refuses them wherever a creator has blocked them.
  it('carries moderator status through every handler', async () => {
    await createResourceReviewHandler({ input: createInput, ctx: ctx({ isModerator: true }) });
    await updateResourceReviewHandler({ input: updateInput, ctx: ctx({ isModerator: true }) });
    await upsertResourceReviewHandler({ input: createInput, ctx: ctx({ isModerator: true }) });

    for (const mock of [mockCreate, mockUpdate, mockUpsert])
      expect(mock).toHaveBeenCalledWith(expect.objectContaining({ isModerator: true }));
  });
});
