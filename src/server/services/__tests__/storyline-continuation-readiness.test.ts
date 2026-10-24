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
const isPlacementEscrowFunded = vi.fn();
const assertCanContinueStoryline = vi.fn();

vi.mock('~/server/services/placement-space.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementSpaceService>()),
  resolvePlacementSpaceFor: resolveSpace,
}));
vi.mock('~/server/services/placement-escrow.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementEscrow>()),
  settlePlacement,
  isPlacementEscrowFunded,
}));
vi.mock('~/server/services/storyline.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StorylineService>()),
  assertCanContinueStoryline,
}));

const {
  startReadyStorylineContinuations,
  getPendingStorylineContinuations,
  retractStorylineContinuation,
} = await import('~/server/services/storyline-placement.service');

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
  isPlacementEscrowFunded.mockResolvedValue(true);
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
    expect(data.data).toEqual({ postId: POST, readyAt: expect.any(String) });
    expect(Date.parse(data.data.readyAt)).toBeGreaterThanOrEqual(before);
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

describe('getPendingStorylineContinuations', () => {
  const givenQueue = (cover: { id: number; url: string; nsfwLevel: number }) => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ id: ROW, createdAt: new Date() }]);
    dbMock.dbRead.placement.findMany.mockResolvedValue([
      {
        id: ROW,
        targetId: CHAPTER,
        amount: 0,
        data: { postId: POST },
        createdAt: new Date(),
        expiresAt: new Date(),
        placer: { id: PLACER, username: 'p', image: null },
      },
    ]);
    dbMock.dbRead.post.findMany.mockResolvedValue([
      { id: POST, title: 'next', nsfwLevel: cover.nsfwLevel, images: [cover] },
      { id: CHAPTER, title: 'first', nsfwLevel: 1, images: [{ id: 2, url: 'u2', nsfwLevel: 1 }] },
    ]);
    dbMock.dbRead.storylineChapter.findMany.mockResolvedValue([
      { postId: CHAPTER, storyline: { id: 5, title: 'Tale', maxNsfwLevel: 4 } },
    ]);
  };

  // The owner reviewing is not the image's author: a cover a moderator has
  // flagged, or that is still in review, must not reach them. Prisma is mocked,
  // so this pins the filter the query sends.
  it('asks only for covers that could be shown anywhere', async () => {
    givenQueue({ id: 1, url: 'u1', nsfwLevel: 1 });
    await getPendingStorylineContinuations({ ownerId: 10, domainLevels: 1 });
    const { select } = dbMock.dbRead.post.findMany.mock.calls[0][0];
    expect(select.images.where).toEqual({
      ingestion: 'Scanned',
      tosViolation: false,
      minor: false,
      poi: false,
      needsReview: null,
    });
  });

  // Prisma is mocked, so this pins the fields the query asks for: without `type` a video cover
  // is requested as an image, and without `hash` a blurred one has nothing to draw.
  it('asks for what a cover needs to render: its media type, blurhash and size', async () => {
    givenQueue({ id: 1, url: 'u1', nsfwLevel: 1 });
    await getPendingStorylineContinuations({ ownerId: 10, domainLevels: 1 });
    const { select } = dbMock.dbRead.post.findMany.mock.calls[0][0];
    expect(select.images.select).toEqual({
      id: true,
      url: true,
      nsfwLevel: true,
      type: true,
      hash: true,
      width: true,
      height: true,
    });
  });

  it('passes a video cover through with its type', async () => {
    givenQueue({ id: 1, url: 'u1', nsfwLevel: 1, type: 'video' } as never);
    const page = await getPendingStorylineContinuations({ ownerId: 10, domainLevels: 1 });
    expect(page.items[0].post.coverImage).toMatchObject({ id: 1, type: 'video' });
  });

  it('withholds a cover above what the domain serves, and shows one within it', async () => {
    givenQueue({ id: 1, url: 'u1', nsfwLevel: 4 });
    const page = await getPendingStorylineContinuations({ ownerId: 10, domainLevels: 1 });
    expect(page.items[0].post.coverImage).toBeNull();
    expect(page.items[0].parentPost.coverImage).toEqual({ id: 2, url: 'u2', nsfwLevel: 1 });
    expect(page.items[0].storyline).toEqual({ id: 5, title: 'Tale', maxNsfwLevel: 4 });
  });
});

describe('startReadyStorylineContinuations — a priced row', () => {
  const givenPriced = () =>
    dbMock.dbWrite.placement.findMany.mockResolvedValue([
      {
        id: ROW,
        targetId: CHAPTER,
        placerId: PLACER,
        amount: 100,
        data: { postId: POST, awaitingReadiness: true },
      },
    ]);

  // A refund planned from a partial escrow never returns the hold that lands after it.
  it('neither refunds nor admits while its holds are still landing', async () => {
    givenPriced();
    givenPost({ tosViolation: true });
    isPlacementEscrowFunded.mockResolvedValue(false);

    await expect(startReadyStorylineContinuations()).resolves.toMatchObject({
      started: 0,
      refunded: 0,
    });
    expect(isPlacementEscrowFunded).toHaveBeenCalledWith({ placementId: ROW, amount: 100 });
    expect(settlePlacement).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.placement.updateMany).not.toHaveBeenCalled();
  });

  it('refunds it once funded', async () => {
    givenPriced();
    givenPost({ tosViolation: true });

    await startReadyStorylineContinuations();
    expect(settlePlacement).toHaveBeenCalledWith({ placementId: ROW, action: 'expire' });
  });
});

describe('retractStorylineContinuation', () => {
  const givenOwn = (overrides: Record<string, unknown> = {}) =>
    dbMock.dbWrite.placement.findUnique.mockResolvedValue({
      surface: 'storyline',
      placerId: PLACER,
      status: 'pending',
      amount: 100,
      ...overrides,
    });

  it('refunds a pending one as an expiry, as the placer', async () => {
    givenOwn();
    await expect(
      retractStorylineContinuation({ placementId: ROW, placerId: PLACER })
    ).resolves.toEqual({ retracted: true });
    expect(settlePlacement).toHaveBeenCalledWith({
      placementId: ROW,
      action: 'expire',
      actorId: PLACER,
    });
  });

  it('refuses while the payment is still landing, and settles nothing', async () => {
    givenOwn();
    isPlacementEscrowFunded.mockResolvedValue(false);
    await expect(
      retractStorylineContinuation({ placementId: ROW, placerId: PLACER })
    ).rejects.toThrow('storyline: the payment for this continuation is still processing');
    expect(settlePlacement).not.toHaveBeenCalled();
  });

  it('does not ask about funding for a free one', async () => {
    givenOwn({ amount: 0 });
    isPlacementEscrowFunded.mockResolvedValue(false);
    await retractStorylineContinuation({ placementId: ROW, placerId: PLACER });
    expect(settlePlacement).toHaveBeenCalledTimes(1);
  });

  it('refuses one that is not the placer’s, and one already answered', async () => {
    givenOwn({ placerId: PLACER + 1 });
    await expect(
      retractStorylineContinuation({ placementId: ROW, placerId: PLACER })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    givenOwn({ status: 'approved' });
    await expect(
      retractStorylineContinuation({ placementId: ROW, placerId: PLACER })
    ).rejects.toThrow('already been answered');
    expect(settlePlacement).not.toHaveBeenCalled();
  });
});
