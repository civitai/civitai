import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as PlacementModeration from '~/server/services/placement-moderation.service';
import type * as PlacementService from '~/server/services/placement.service';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';

const assertCanPlace = vi.fn();

vi.mock('~/server/services/placement-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementModeration>()),
  assertCanPlace,
}));
vi.mock('~/server/services/placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementService>()),
  placementPriceRange: async () => ({ min: 0, max: 500, freeSlotCap: 0, score: 0, tier: 'free' }),
}));

const { createStorylinePlacement } = await import('~/server/services/storyline-placement.service');

const OWNER = 10;
const PLACER = 20;
const CHAPTER = 77;

const givenStoryline = (status: 'Ongoing' | 'Complete') =>
  dbMock.dbWrite.storylineChapter.findUnique.mockResolvedValue({
    id: 1,
    storylineId: 31,
    depth: 0,
    userId: OWNER,
    storyline: {
      id: 31,
      userId: OWNER,
      status,
      tosViolation: false,
      maxNsfwLevel: 4,
      whoCanContinue: 'Anyone',
      user: { username: 'o' },
    },
  });

const submit = () =>
  createStorylinePlacement({
    placerId: PLACER,
    parentPostId: CHAPTER,
    postId: 78,
    expectedPrice: 0,
    spendType: 'yellow',
  });

beforeEach(() => {
  vi.clearAllMocks();
  assertCanPlace.mockResolvedValue(undefined);
  // A finished, rated continuation, so the readiness checks pass and only the
  // status decides.
  dbMock.dbWrite.post.findUnique.mockResolvedValue({
    userId: PLACER,
    publishedAt: new Date('2026-01-01'),
    nsfwLevel: 1,
    tosViolation: false,
    storylineChapter: null,
    images: [
      { ingestion: 'Scanned', tosViolation: false, minor: false, poi: false, needsReview: null },
    ],
  });
  dbMock.dbWrite.placementSpace.findMany.mockResolvedValue([]);
  dbMock.dbWrite.placement.count.mockResolvedValue(0);
  dbMock.dbWrite.placement.create.mockResolvedValue({ id: 1 });
});

/**
 * Complete is the storyline's own status, and it alone closes the storyline:
 * the storyline service does not also write the placement space. So this runs
 * the real space resolver under the real submission, and nothing but the
 * status changes between the two halves.
 */
describe('a Complete storyline takes no continuations', () => {
  it('refuses while Complete and accepts again once Ongoing', async () => {
    givenStoryline('Complete');
    await expect(submit()).rejects.toThrow(STORYLINE_REFUSALS.notOpen);
    expect(dbMock.dbWrite.placement.create).not.toHaveBeenCalled();

    givenStoryline('Ongoing');
    await expect(submit()).resolves.toEqual({ id: 1 });
    expect(dbMock.dbWrite.placement.create).toHaveBeenCalledTimes(1);
  });
});
