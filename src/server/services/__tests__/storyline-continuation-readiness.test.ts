import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as PlacementEscrow from '~/server/services/placement-escrow.service';
import type * as PlacementSpaceService from '~/server/services/placement-space.service';
import type * as StorylineService from '~/server/services/storyline.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { PLACEMENT_SURFACES } from '~/shared/utils/placement';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';

const resolveSpace = vi.fn();
const settlePlacement = vi.fn();
const assertCanContinueStoryline = vi.fn();

vi.mock('~/server/services/placement-space.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementSpaceService>()),
  resolvePlacementSpaceFor: resolveSpace,
}));
vi.mock('~/server/services/placement-escrow.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementEscrow>()),
  settlePlacement,
}));
vi.mock('~/server/services/storyline.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StorylineService>()),
  assertCanContinueStoryline,
}));

const { startReadyStorylineContinuations } = await import(
  '~/server/services/storyline-placement.service'
);

const PLACER = 20;
const CHAPTER = 77;
const POST = 78;
const ROW = 501;

const SCANNED = {
  ingestion: 'Scanned',
  tosViolation: false,
  minor: false,
  poi: false,
  needsReview: null as string | null,
};

const givenRow = () => {
  dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: ROW }]);
  dbMock.dbWrite.placement.findMany.mockResolvedValue([
    {
      id: ROW,
      targetId: CHAPTER,
      placerId: PLACER,
      data: { postId: POST, awaitingReadiness: true },
    },
  ]);
};

const givenPost = (overrides: Record<string, unknown> = {}) =>
  dbMock.dbWrite.post.findMany.mockResolvedValue([
    {
      id: POST,
      userId: PLACER,
      publishedAt: new Date('2026-01-01'),
      nsfwLevel: 1,
      tosViolation: false,
      storylineChapter: null,
      images: [SCANNED],
      ...overrides,
    },
  ]);

const givenAccess = ({ isCollaborator = false, maxNsfwLevel = 4 } = {}) =>
  assertCanContinueStoryline.mockResolvedValue({
    isCollaborator,
    parent: { storyline: { maxNsfwLevel, whoCanContinue: 'Anyone' } },
  });

beforeEach(() => {
  vi.clearAllMocks();
  givenRow();
  givenPost();
  givenAccess();
  resolveSpace.mockResolvedValue({ ownerId: 10, mode: 'review', price: 0 });
  dbMock.dbWrite.placement.updateMany.mockResolvedValue({ count: 1 });
  // `settleStorylineContinuation` reads the surface before it settles.
  dbMock.dbWrite.placement.findUnique.mockResolvedValue({ surface: 'storyline' });
  settlePlacement.mockResolvedValue({ settled: true, placement: { status: 'expired' } });
});

describe('startReadyStorylineContinuations', () => {
  it('admits a finished post: clears the marker and restarts the clock, once', async () => {
    const before = Date.now();
    await expect(startReadyStorylineContinuations()).resolves.toEqual({
      considered: 1,
      started: 1,
      refunded: 0,
    });

    expect(dbMock.dbWrite.placement.updateMany).toHaveBeenCalledTimes(1);
    const { where, data } = dbMock.dbWrite.placement.updateMany.mock.calls[0][0];
    // The marker is in the WHERE, so a second pass cannot extend the deadline.
    expect(where).toEqual({
      id: ROW,
      status: 'pending',
      data: { path: ['awaitingReadiness'], equals: true },
    });
    expect(data.data).toEqual({ postId: POST });
    const hours = (data.expiresAt.getTime() - before) / 3_600_000;
    expect(hours).toBeGreaterThanOrEqual(PLACEMENT_SURFACES.storyline.expiryHours - 0.01);
    expect(settlePlacement).not.toHaveBeenCalled();
  });

  it('approves an endorsed collaborator once the post is admitted', async () => {
    givenAccess({ isCollaborator: true });
    await startReadyStorylineContinuations();

    expect(settlePlacement).toHaveBeenCalledTimes(1);
    expect(settlePlacement).toHaveBeenCalledWith(
      expect.objectContaining({ placementId: ROW, action: 'approve' })
    );
  });

  // A second pass that loses the claim must not approve a second time.
  it('approves nothing when another pass already admitted the row', async () => {
    givenAccess({ isCollaborator: true });
    dbMock.dbWrite.placement.updateMany.mockResolvedValue({ count: 0 });
    await expect(startReadyStorylineContinuations()).resolves.toMatchObject({ started: 0 });
    expect(settlePlacement).not.toHaveBeenCalled();
  });

  it.each([
    ['a taken-down post', { tosViolation: true }],
    ['a blocked image', { images: [{ ...SCANNED, ingestion: 'Blocked' }] }],
    ['a minor image', { images: [{ ...SCANNED, minor: true }] }],
  ])('refunds %s', async (_, post) => {
    givenPost(post);
    await expect(startReadyStorylineContinuations()).resolves.toMatchObject({ refunded: 1 });
    expect(settlePlacement).toHaveBeenCalledWith({ placementId: ROW, action: 'expire' });
    expect(dbMock.dbWrite.placement.updateMany).not.toHaveBeenCalled();
  });

  it('refunds a post that was deleted', async () => {
    dbMock.dbWrite.post.findMany.mockResolvedValue([]);
    await startReadyStorylineContinuations();
    expect(settlePlacement).toHaveBeenCalledWith({ placementId: ROW, action: 'expire' });
  });

  it('refunds a post rated above the storyline once it has a rating', async () => {
    givenAccess({ maxNsfwLevel: 1 });
    givenPost({ nsfwLevel: 4 });
    await startReadyStorylineContinuations();
    expect(settlePlacement).toHaveBeenCalledWith({ placementId: ROW, action: 'expire' });
    expect(dbMock.dbWrite.placement.updateMany).not.toHaveBeenCalled();
  });

  it('refunds when the storyline now refuses this placer', async () => {
    assertCanContinueStoryline.mockRejectedValue(
      (() => {
        try {
          throwBadRequestError(STORYLINE_REFUSALS.collaboratorsOnly);
        } catch (error) {
          return error;
        }
      })()
    );
    await startReadyStorylineContinuations();
    expect(settlePlacement).toHaveBeenCalledWith({ placementId: ROW, action: 'expire' });
  });

  // A transient failure is not a verdict: refunding on it would turn a blip
  // into an irreversible "we could not deliver".
  it('leaves the row for the next tick on a transient failure', async () => {
    assertCanContinueStoryline.mockRejectedValue(new Error('connection reset'));
    await expect(startReadyStorylineContinuations()).resolves.toEqual({
      considered: 1,
      started: 0,
      refunded: 0,
    });
    expect(settlePlacement).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.placement.updateMany).not.toHaveBeenCalled();
  });

  // The SQL should not have selected it; this is the check a unit test can see.
  it.each([
    ['still scanning', { images: [{ ...SCANNED, ingestion: 'Pending' }] }],
    ['unpublished', { publishedAt: null }],
    ['under review', { images: [{ ...SCANNED, needsReview: 'poi' }] }],
  ])('leaves a post %s alone', async (_, post) => {
    givenPost(post);
    await startReadyStorylineContinuations();
    expect(settlePlacement).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.placement.updateMany).not.toHaveBeenCalled();
  });

  it('does nothing when nothing is selected', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    await expect(startReadyStorylineContinuations()).resolves.toEqual({
      considered: 0,
      started: 0,
      refunded: 0,
    });
    expect(dbMock.dbWrite.placement.findMany).not.toHaveBeenCalled();
  });
});
