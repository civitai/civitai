import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PlacementService from '~/server/services/placement.service';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';
import { createFakeDb, type FakeDb } from './storyline-loop.fake-db';

/**
 * The storyline continuation loop, end to end, through the real services:
 * submit (createStorylinePlacement), the owner's queue, approval
 * (actOnStorylineContinuation -> settlePlacement -> writeChapterEdgeForPlacement),
 * the expiry sweep, and the chapter's children as a reader sees them.
 *
 * Only the edges are replaced: the database (an in-memory fake that rolls back
 * and enforces unique keys, ./storyline-loop.fake-db), Buzz itself, the Redis
 * lock, the creator's price cap, and two hooks that do nothing for a storyline.
 * Every rule about who may continue, what it costs and what gets written is the
 * production code's.
 */

const createMultiAccountBuzzTransaction = vi.fn();
const createBuzzTransaction = vi.fn();
const refundMultiAccountTransaction = vi.fn();
vi.mock('~/server/services/buzz.service', () => ({
  createMultiAccountBuzzTransaction,
  createBuzzTransaction,
  refundMultiAccountTransaction,
}));
vi.mock('~/server/utils/distributed-lock', () => ({
  withDistributedLock: async (_options: unknown, operation: () => Promise<unknown>) => operation(),
}));
// The creator's cap from score and membership: high enough for the priced cases.
vi.mock('~/server/services/placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementService>()),
  placementPriceRange: async () => ({ min: 0, max: 10_000, freeSlotCap: 0 }),
}));
// Event points and the sticker reward: neither runs for a storyline, both load heavy modules.
vi.mock('~/server/events/points/hooks', () => ({
  onPlacementApproved: async () => undefined,
  onPlacementsTakenDown: async () => undefined,
}));
vi.mock('~/server/rewards/active/stickerPlacementAccepted.reward', () => ({
  stickerPlacementAcceptedReward: { apply: async () => undefined },
}));

const { createStorylinePlacement, actOnStorylineContinuation, getPendingStorylineContinuations } =
  await import('~/server/services/storyline-placement.service');
const { expirePlacements } = await import('~/server/services/placement-escrow.service');
const { getStorylineChildren } = await import('~/server/services/storyline.service');
const { tombstoneChaptersForPlacements } = await import(
  '~/server/services/storyline-chapter-removal.service'
);
const { dbMock } = await import('~/__tests__/mocks');

const OWNER = 10;
const STRANGER = 20;
const COLLABORATOR = 30;
const STORYLINE = 1;
const ROOT_CHAPTER = 1;
const ROOT_POST = 100;
const STRANGER_POST = 200;
const COLLABORATOR_POST = 300;
const STRANGER_X_POST = 400;
// NsfwLevel flags: PG = 1, X = 8. The storyline's ceiling is PG.
const PG = 1;
const X = 8;
const ALL_LEVELS = 31;

let db: FakeDb;

const publishedPost = (id: number, userId: number, nsfwLevel: number) => {
  db.insert('post', {
    id,
    userId,
    title: `post ${id}`,
    nsfwLevel,
    publishedAt: new Date(Date.now() - 60_000),
    tosViolation: false,
  });
  db.insert('image', {
    id: id * 10,
    postId: id,
    index: 0,
    url: `img-${id}`,
    type: 'image',
    hash: null,
    width: 832,
    height: 1216,
    nsfwLevel,
    ingestion: 'Scanned',
    tosViolation: false,
    minor: false,
    poi: false,
    needsReview: null,
  });
};

const submit = (placerId: number, postId: number, expectedPrice = 0, parentPostId = ROOT_POST) =>
  createStorylinePlacement({
    placerId,
    parentPostId,
    postId,
    expectedPrice,
    spendType: 'yellow',
  });

const children = () =>
  getStorylineChildren({
    chapterId: ROOT_CHAPTER,
    viewer: undefined,
    browsingLevel: ALL_LEVELS,
    readersByChapterId: new Map(),
  });

const chapterFor = (placementId: number) => db.row('storylineChapter', { placementId });
const edgeFor = (chapterId: number) => db.row('storylineChapterEdge', { chapterId });

const charge = (price: number) =>
  db.insert('placementSpace', {
    surface: 'storyline',
    entityType: 'storyline',
    entityId: STORYLINE,
    mode: 'review',
    price,
    freeSlots: null,
    settings: null,
  });

const moneyCalls = () => ({
  holds: createMultiAccountBuzzTransaction.mock.calls.map((c) => [c[0].fromAccountId, c[0].amount]),
  payouts: createBuzzTransaction.mock.calls.map((c) => [c[0].toAccountId, c[0].amount]),
  refunds: refundMultiAccountTransaction.mock.calls.map((c) => c[0].externalTransactionIdPrefix),
});

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  createMultiAccountBuzzTransaction.mockResolvedValue({ transactionCount: 1 });
  createBuzzTransaction.mockResolvedValue({ transactionId: 'payout' });
  refundMultiAccountTransaction.mockImplementation(
    async ({ externalTransactionIdPrefix }: { externalTransactionIdPrefix: string }) => ({
      externalTransactionIdPrefix,
      refundedTransactions: [{ refundTransactionId: `refund-${externalTransactionIdPrefix}` }],
    })
  );

  db = createFakeDb();
  db.install();
  for (const [id, username] of [
    [OWNER, 'storyteller'],
    [STRANGER, 'stranger'],
    [COLLABORATOR, 'collaborator'],
  ] as const)
    db.insert('user', { id, username, image: null, bannedAt: null, deletedAt: null });

  db.insert('storyline', {
    id: STORYLINE,
    userId: OWNER,
    title: 'The Long Road',
    status: 'Ongoing',
    whoCanContinue: 'Anyone',
    maxNsfwLevel: PG,
    tosViolation: false,
    createdAt: new Date(0),
  });
  publishedPost(ROOT_POST, OWNER, PG);
  db.insert('storylineChapter', {
    id: ROOT_CHAPTER,
    storylineId: STORYLINE,
    postId: ROOT_POST,
    userId: OWNER,
    depth: 0,
  });
  publishedPost(STRANGER_POST, STRANGER, PG);
  publishedPost(COLLABORATOR_POST, COLLABORATOR, PG);
  publishedPost(STRANGER_X_POST, STRANGER, X);
  db.insert('storylineCollaborator', { storylineId: STORYLINE, userId: COLLABORATOR });
});

describe('the storyline continuation loop', () => {
  it("takes a stranger's continuation to the owner's queue, and on approval into the story", async () => {
    const before = Date.now();
    const { id } = await submit(STRANGER, STRANGER_POST);

    expect(db.row('placement', { id })).toMatchObject({
      status: 'pending',
      ownerId: OWNER,
      amount: 0,
    });
    // A zero-priced row takes no hold, so submission alone must give it its
    // seven-day deadline; without one the expiry sweep never selects it.
    expect((db.row('placement', { id })!.expiresAt as Date).getTime()).toBeGreaterThanOrEqual(
      before + 7 * 24 * 3_600_000
    );
    await expect(expirePlacements()).resolves.toEqual({ considered: 0, expired: 0 });
    expect(chapterFor(id)).toBeUndefined();
    const queue = await getPendingStorylineContinuations({
      ownerId: OWNER,
      domainLevels: ALL_LEVELS,
    });
    expect(queue.items.map((item) => [item.id, item.post.id, item.parentPost.id])).toEqual([
      [id, STRANGER_POST, ROOT_POST],
    ]);
    // This fake honours `select`: the cover carries what it needs to render.
    expect(queue.items[0].post.coverImage).toEqual({
      id: STRANGER_POST * 10,
      url: `img-${STRANGER_POST}`,
      nsfwLevel: expect.any(Number),
      type: 'image',
      hash: null,
      width: 832,
      height: 1216,
    });

    await expect(
      actOnStorylineContinuation({ placementId: id, ownerId: OWNER, action: 'approve' })
    ).resolves.toEqual({ settled: true, status: 'approved' });

    const chapter = chapterFor(id);
    expect(chapter).toMatchObject({ storylineId: STORYLINE, postId: STRANGER_POST, depth: 1 });
    expect(edgeFor(chapter!.id as number)).toMatchObject({
      parentChapterId: ROOT_CHAPTER,
      canon: false,
    });
    expect(db.rows('storylineChapterEdge')).toHaveLength(1);
    expect((await children()).map((c) => [c.chapterId, c.rank, c.post?.id])).toEqual([
      [chapter!.id, 'community', STRANGER_POST],
    ]);
    expect(
      (await getPendingStorylineContinuations({ ownerId: OWNER, domainLevels: ALL_LEVELS })).items
    ).toEqual([]);
    expect(moneyCalls()).toEqual({ holds: [], payouts: [], refunds: [] });
  });

  it('writes no second chapter when the approval is answered again', async () => {
    const { id } = await submit(STRANGER, STRANGER_POST);
    await actOnStorylineContinuation({ placementId: id, ownerId: OWNER, action: 'approve' });

    await expect(
      actOnStorylineContinuation({ placementId: id, ownerId: OWNER, action: 'approve' })
    ).rejects.toThrow('already been answered');
    expect(db.rows('storylineChapter')).toHaveLength(2);
    expect(db.rows('storylineChapterEdge')).toHaveLength(1);
  });

  it("puts an endorsed collaborator's continuation straight into the story, with no queue row", async () => {
    const { id } = await submit(COLLABORATOR, COLLABORATOR_POST);

    expect(db.row('placement', { id })).toMatchObject({ status: 'approved', resolvedById: null });
    expect(
      (await getPendingStorylineContinuations({ ownerId: OWNER, domainLevels: ALL_LEVELS })).items
    ).toEqual([]);
    const chapter = chapterFor(id);
    expect(edgeFor(chapter!.id as number)).toMatchObject({ parentChapterId: ROOT_CHAPTER });
    expect((await children()).map((c) => [c.rank, c.post?.id])).toEqual([
      ['endorsed', COLLABORATOR_POST],
    ]);
  });

  it('orders an endorsed chapter before a community one', async () => {
    const stranger = await submit(STRANGER, STRANGER_POST);
    await actOnStorylineContinuation({
      placementId: stranger.id,
      ownerId: OWNER,
      action: 'approve',
    });
    await submit(COLLABORATOR, COLLABORATOR_POST);

    expect((await children()).map((c) => c.rank)).toEqual(['endorsed', 'community']);
  });

  it('refuses a post rated above the storyline, and writes nothing', async () => {
    await expect(submit(STRANGER, STRANGER_X_POST)).rejects.toThrow(STORYLINE_REFUSALS.aboveRating);

    expect(db.rows('placement')).toEqual([]);
    expect(db.rows('storylineChapter')).toHaveLength(1);
  });

  it('refuses a stranger on a collaborators-only storyline, and takes the collaborator', async () => {
    db.update('storyline', { id: STORYLINE }, { whoCanContinue: 'Collaborators' });

    await expect(submit(STRANGER, STRANGER_POST)).rejects.toThrow(
      STORYLINE_REFUSALS.collaboratorsOnly
    );
    const { id } = await submit(COLLABORATOR, COLLABORATOR_POST);
    expect(db.row('placement', { id })).toMatchObject({ status: 'approved' });
  });

  it('refuses everyone, collaborators too, once the storyline is closed', async () => {
    db.insert('placementSpace', {
      surface: 'storyline',
      entityType: 'storyline',
      entityId: STORYLINE,
      mode: 'off',
      price: 0,
      freeSlots: null,
      settings: null,
    });

    await expect(submit(STRANGER, STRANGER_POST)).rejects.toThrow(STORYLINE_REFUSALS.notOpen);
    await expect(submit(COLLABORATOR, COLLABORATOR_POST)).rejects.toThrow(
      STORYLINE_REFUSALS.notOpen
    );
    expect(db.rows('placement')).toEqual([]);
  });

  // Product rule, from the surface config: a declined PRICED continuation keeps
  // the standard 30% decline fee for the owner, as remix galleries do.
  it('keeps the 30% decline fee for the owner, refunds the rest, and writes no chapter', async () => {
    charge(100);
    const { id } = await submit(STRANGER, STRANGER_POST, 100);
    expect(moneyCalls().holds).toEqual([
      [STRANGER, 30],
      [STRANGER, 70],
    ]);

    await actOnStorylineContinuation({ placementId: id, ownerId: OWNER, action: 'decline' });

    expect(db.row('placement', { id })).toMatchObject({ status: 'declined' });
    expect(moneyCalls().payouts).toEqual([[OWNER, 30]]);
    expect(moneyCalls().refunds).toEqual([`placement-${id}-holdPrincipal`]);
    expect(chapterFor(id)).toBeUndefined();
    expect(db.rows('storylineChapterEdge')).toEqual([]);
  });

  it('refunds both holds in full when nobody answers in seven days, and writes no chapter', async () => {
    // Only the clock is faked; promises still resolve normally.
    vi.useFakeTimers({ toFake: ['Date'] });
    const submittedAt = Date.now();
    charge(100);
    const { id } = await submit(STRANGER, STRANGER_POST, 100);
    // Stamped by submission itself, seven days out: a row with no deadline never expires.
    expect((db.row('placement', { id })!.expiresAt as Date).getTime()).toBe(
      submittedAt + 7 * 24 * 3_600_000
    );

    vi.setSystemTime(submittedAt + 7 * 24 * 3_600_000 - 60_000);
    await expect(expirePlacements()).resolves.toEqual({ considered: 0, expired: 0 });
    vi.setSystemTime(submittedAt + 7 * 24 * 3_600_000 + 60_000);
    await expect(expirePlacements()).resolves.toEqual({ considered: 1, expired: 1 });

    expect(db.row('placement', { id })).toMatchObject({ status: 'expired' });
    expect(moneyCalls().payouts).toEqual([]);
    expect(moneyCalls().refunds.sort()).toEqual([
      `placement-${id}-holdFee`,
      `placement-${id}-holdPrincipal`,
    ]);
    expect(chapterFor(id)).toBeUndefined();
  });

  it('pays the owner the full price of an approved priced continuation', async () => {
    charge(100);
    const { id } = await submit(STRANGER, STRANGER_POST, 100);

    await actOnStorylineContinuation({ placementId: id, ownerId: OWNER, action: 'approve' });

    expect(moneyCalls().payouts).toEqual([[OWNER, 100]]);
    expect(moneyCalls().refunds).toEqual([]);
    expect(chapterFor(id)).toMatchObject({ postId: STRANGER_POST });
  });

  // Changed after submission: the chapter edge re-checks blocks, the post and
  // who may continue at approval.
  it.each([
    [
      'the owner blocks the placer',
      () => db.block(OWNER, STRANGER),
      'Continuations are not available on this chapter',
    ],
    [
      'the placer blocks the owner',
      () => db.block(STRANGER, OWNER),
      'Continuations are not available on this chapter',
    ],
    [
      'the storyline becomes collaborators-only',
      () => db.update('storyline', { id: STORYLINE }, { whoCanContinue: 'Collaborators' }),
      STORYLINE_REFUSALS.collaboratorsOnly,
    ],
    [
      'the post is taken down',
      () => db.update('post', { id: STRANGER_POST }, { tosViolation: true }),
      STORYLINE_REFUSALS.cannotSubmit,
    ],
  ])(
    'leaves it pending, unpaid and out of the story when, after submission, %s',
    async (_, change, refusal) => {
      charge(100);
      const { id } = await submit(STRANGER, STRANGER_POST, 100);
      change();

      await expect(
        actOnStorylineContinuation({ placementId: id, ownerId: OWNER, action: 'approve' })
      ).rejects.toThrow(refusal);

      expect(db.row('placement', { id })).toMatchObject({ status: 'pending', resolvedAt: null });
      expect(moneyCalls().payouts).toEqual([]);
      expect(
        db
          .rows('placementTransaction')
          .map((leg) => leg.kind)
          .sort()
      ).toEqual(['holdFee', 'holdPrincipal']);
      expect(chapterFor(id)).toBeUndefined();
    }
  );

  // The chapter being continued has its own author, and a block between them and
  // the placer counts as much as one with the storyline's owner.
  describe("under a collaborator's chapter", () => {
    const STRANGER_SECOND_POST = 500;
    beforeEach(async () => {
      await submit(COLLABORATOR, COLLABORATOR_POST);
      publishedPost(STRANGER_SECOND_POST, STRANGER, PG);
    });

    it("refuses a placer the chapter's author has blocked", async () => {
      db.block(COLLABORATOR, STRANGER);

      await expect(submit(STRANGER, STRANGER_SECOND_POST, 0, COLLABORATOR_POST)).rejects.toThrow(
        'Continuations are not available on this chapter'
      );
      expect(db.rows('placement').filter((p) => p.placerId === STRANGER)).toEqual([]);
    });

    it("refuses the approval once the chapter's author blocks the placer", async () => {
      const { id } = await submit(STRANGER, STRANGER_SECOND_POST, 0, COLLABORATOR_POST);
      db.block(COLLABORATOR, STRANGER);

      await expect(
        actOnStorylineContinuation({ placementId: id, ownerId: OWNER, action: 'approve' })
      ).rejects.toThrow('Continuations are not available on this chapter');
      expect(db.row('placement', { id })).toMatchObject({ status: 'pending' });
      expect(chapterFor(id)).toBeUndefined();
    });

    it('approves a continuation of it into the story at depth two', async () => {
      const { id } = await submit(STRANGER, STRANGER_SECOND_POST, 0, COLLABORATOR_POST);

      await actOnStorylineContinuation({ placementId: id, ownerId: OWNER, action: 'approve' });

      const parent = db.row('storylineChapter', { postId: COLLABORATOR_POST });
      const chapter = chapterFor(id);
      expect(chapter).toMatchObject({ depth: 2, postId: STRANGER_SECOND_POST });
      expect(edgeFor(chapter!.id as number)).toMatchObject({ parentChapterId: parent!.id });
    });

    it('once its placement is removed: a tombstone to readers, and closed to continuations', async () => {
      const removedPlacement = db.row('placement', { placerId: COLLABORATOR })!.id as number;
      const { id: pending } = await submit(STRANGER, STRANGER_SECOND_POST, 0, COLLABORATOR_POST);

      await expect(
        tombstoneChaptersForPlacements(
          { placementIds: [removedPlacement] },
          dbMock.dbWrite as never
        )
      ).resolves.toBe(1);
      // Marked, not deleted: the row still holds the post.
      expect(db.row('storylineChapter', { postId: COLLABORATOR_POST })).toMatchObject({
        placementId: removedPlacement,
        removedAt: expect.any(Date),
      });

      expect((await children()).map((c) => [c.post?.id ?? null, c.tombstone])).toEqual([
        [null, 'removed'],
      ]);
      await expect(
        actOnStorylineContinuation({ placementId: pending, ownerId: OWNER, action: 'approve' })
      ).rejects.toThrow(STORYLINE_REFUSALS.notAChapter);
      expect(chapterFor(pending)).toBeUndefined();

      publishedPost(501, STRANGER, PG);
      await expect(submit(STRANGER, 501, 0, COLLABORATOR_POST)).rejects.toThrow(
        STORYLINE_REFUSALS.notAChapter
      );
    });
  });
});

afterAll(() => vi.useRealTimers());
