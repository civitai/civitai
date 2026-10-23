import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as PlacementModeration from '~/server/services/placement-moderation.service';
import type * as PlacementSpaceService from '~/server/services/placement-space.service';
import type * as StorylineService from '~/server/services/storyline.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';
import { PLACER, placementCaller } from './placement.router.test-utils';

const { resolvePlacementSpaceFor, assertCanContinueStoryline, assertCanPlace } = vi.hoisted(() => ({
  resolvePlacementSpaceFor: vi.fn(),
  assertCanContinueStoryline: vi.fn(),
  assertCanPlace: vi.fn(),
}));

vi.mock('~/server/services/placement-space.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementSpaceService>()),
  resolvePlacementSpaceFor,
}));
vi.mock('~/server/services/storyline.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StorylineService>()),
  assertCanContinueStoryline,
}));
vi.mock('~/server/services/placement-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementModeration>()),
  assertCanPlace,
}));

const OWNER = 10;

const refusal = (message: string) => {
  try {
    throwBadRequestError(message);
  } catch (error) {
    return error;
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  // Open, free, and owned by someone else: the space lets everyone through, so
  // a refusal below can only come from the storyline service's assert.
  resolvePlacementSpaceFor.mockResolvedValue({ ownerId: OWNER, mode: 'review', price: 0 });
  assertCanContinueStoryline.mockResolvedValue({
    isCollaborator: false,
    parent: { storyline: { maxNsfwLevel: 4, whoCanContinue: 'Anyone' } },
  });
  assertCanPlace.mockResolvedValue(undefined);
  // Past the assert, the first thing a submission reads is the post. Null
  // refuses it by name, which is how the positive arms see they got this far.
  dbMock.dbWrite.post.findUnique.mockResolvedValue(null);
});

/**
 * The chapter check, at the router entry, through the real storyline
 * placement service with the storyline service's assert replaced. What this
 * pins is that both routes taking a chapter ask that assert, with this caller,
 * and stop on its refusal; what the assert refuses is tested beside it. A post
 * that is not a chapter must be refused by both, or a surface that opens at 0
 * by default would open every post on the site.
 */
describe('storyline routes refuse a post that is not a chapter', () => {
  // Braced: a function returned from beforeEach is run as its teardown.
  beforeEach(() => {
    assertCanContinueStoryline.mockRejectedValue(refusal(STORYLINE_REFUSALS.notAChapter));
  });

  it('on submit', async () => {
    await expect(
      placementCaller().submitStorylineContinuation({
        parentPostId: 11,
        postId: 12,
        expectedPrice: 0,
      })
    ).rejects.toThrow(STORYLINE_REFUSALS.notAChapter);
    expect(assertCanContinueStoryline).toHaveBeenCalledWith({ parentPostId: 11, placerId: PLACER });
    expect(dbMock.dbWrite.post.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('on the price read', async () => {
    await expect(placementCaller().getStorylineContinuePrice({ parentPostId: 11 })).rejects.toThrow(
      STORYLINE_REFUSALS.notAChapter
    );
    expect(assertCanContinueStoryline).toHaveBeenCalledWith({ parentPostId: 11, placerId: PLACER });
  });
});

// The controls: the same calls on a chapter get past the check.
describe('storyline routes on a chapter', () => {
  it('submit goes on to read the post', async () => {
    await expect(
      placementCaller().submitStorylineContinuation({
        parentPostId: 11,
        postId: 12,
        expectedPrice: 0,
      })
    ).rejects.toThrow(STORYLINE_REFUSALS.notYourPost);
    expect(dbMock.dbWrite.post.findUnique).toHaveBeenCalledTimes(1);
  });

  it('the price read answers open', async () => {
    await expect(
      placementCaller().getStorylineContinuePrice({ parentPostId: 11 })
    ).resolves.toEqual({ open: true, closedReason: null, price: 0 });
  });

  it('the price read says collaborators only to a stranger the assert refuses', async () => {
    assertCanContinueStoryline.mockRejectedValue(refusal(STORYLINE_REFUSALS.collaboratorsOnly));
    await expect(
      placementCaller().getStorylineContinuePrice({ parentPostId: 11 })
    ).resolves.toEqual({ open: false, closedReason: 'collaboratorsOnly', price: 0 });
  });

  it('the price read says closed on a closed storyline, to a collaborator too', async () => {
    resolvePlacementSpaceFor.mockResolvedValue({ ownerId: OWNER, mode: 'off', price: 0 });
    assertCanContinueStoryline.mockResolvedValue({
      isCollaborator: true,
      parent: { storyline: { maxNsfwLevel: 4, whoCanContinue: 'Anyone' } },
    });
    await expect(
      placementCaller().getStorylineContinuePrice({ parentPostId: 11 })
    ).resolves.toEqual({ open: false, closedReason: 'closed', price: 0 });
  });

  it('the price read says closed to the storyline owner', async () => {
    resolvePlacementSpaceFor.mockResolvedValue({ ownerId: PLACER, mode: 'review', price: 0 });
    await expect(
      placementCaller().getStorylineContinuePrice({ parentPostId: 11 })
    ).resolves.toEqual({ open: false, closedReason: 'closed', price: 0 });
  });

  // A transient failure is not an answer: it must not read as closed.
  it('the price read fails on a transient error rather than answering', async () => {
    assertCanContinueStoryline.mockRejectedValue(new Error('connection reset'));
    await expect(placementCaller().getStorylineContinuePrice({ parentPostId: 11 })).rejects.toThrow(
      /connection reset/
    );
  });
});
