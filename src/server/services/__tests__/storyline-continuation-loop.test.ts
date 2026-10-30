import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PlacementService from '~/server/services/placement.service';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';
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
// The reader's hidden images and tags, read for chapter images: none, and not this loop's subject.
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  getAllHiddenForUser: async () => ({ hiddenImages: [], hiddenTags: [] }),
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTags: async () => ({ emptyResult: false }),
}));
vi.mock('~/server/rewards/active/stickerPlacementAccepted.reward', () => ({
  stickerPlacementAcceptedReward: { apply: async () => undefined },
}));

const {
  createStorylinePlacement,
  actOnStorylineContinuation,
  getPendingStorylineContinuations,
  settleOrphanedContinuations,
} = await import('~/server/services/storyline-placement.service');
const { removePlacementByModerator, declinePlacementsOnBlock } = await import(
  '~/server/services/placement-moderation.service'
);
const { expirePlacements } = await import('~/server/services/placement-escrow.service');
const { getStorylineChildren } = await import('~/server/services/storyline.service');
const { tombstoneChaptersForPlacements } = await import(
  '~/server/services/storyline-chapter-removal.service'
);
const { dbMock } = await import('~/__tests__/mocks');

const OWNER = 10;
const STRANGER = 20;
const COLLABORATOR = 30;
const MODERATOR = 40;
const STORYLINE = 1;
const ROOT_CHAPTER = 1;
const ROOT_POST = 100;
const STRANGER_POST = 200;
const COLLABORATOR_POST = 300;
const STRANGER_X_POST = 400;
// The storyline's ceiling is PG.
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
  db.insert('storylineCollaborator', {
    storylineId: STORYLINE,
    userId: COLLABORATOR,
    acceptedAt: new Date(),
  });
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

  // While the title scan holds a storyline as about a minor, its chapters are held to
  // `storylineCeiling` whatever the owner set, at submission, at approval and when read.
  // Hold and mark, decided for the takedown: it can lift (an appeal, a clean rescan), so a
  // continuation in a taken-down storyline is kept, not refunded early, and the owner's queue shows
  // it as not answerable until the takedown lifts. Its own deadline still refunds it.
  describe('in a storyline that is taken down', () => {
    const setTakenDown = (tosViolation: boolean) =>
      db.update('storyline', { id: STORYLINE }, { tosViolation });
    const queueMarks = async () =>
      (
        await getPendingStorylineContinuations({ ownerId: OWNER, domainLevels: ALL_LEVELS })
      ).items.map((item) => [item.id, item.storyline.takenDown]);

    // The fake answers the queue and the orphan sweep from their clauses on the chapter alone, so
    // it cannot see a takedown filter added to either. Hold and mark was decided (no early refund,
    // no hidden rows): if you are adding the storyline's takedown to either statement, that decision
    // has to change first. The takedown lives on "Storyline"; neither statement reads that table.
    it('reads no storyline takedown in the queue or the orphan sweep, so neither hides nor refunds a held row', async () => {
      await submit(STRANGER, STRANGER_POST);
      setTakenDown(true);
      await getPendingStorylineContinuations({ ownerId: OWNER, domainLevels: ALL_LEVELS });
      await settleOrphanedContinuations();
      const statements = [
        ...dbMock.dbRead.$queryRaw.mock.calls,
        ...dbMock.dbWrite.$queryRaw.mock.calls,
      ]
        .map(([strings, ...values]) =>
          (Array.isArray(strings)
            ? Prisma.sql(strings as never, ...values)
            : (strings as Prisma.Sql)
          ).text.replace(/\s+/g, ' ')
        )
        .filter((text) => text.includes('FROM "Placement" pl'));
      const queue = statements.filter((text) => text.includes('JOIN "Post" p'));
      const sweep = statements.filter((text) => text.includes('pl.amount = 0 OR'));
      expect([queue.length > 0, sweep.length > 0]).toEqual([true, true]);
      expect([...queue, ...sweep].filter((text) => text.includes('"Storyline"'))).toEqual([]);
    });

    it('stays in the queue marked, refused and unrefunded, and is answerable once the takedown lifts', async () => {
      charge(100);
      const { id } = await submit(STRANGER, STRANGER_POST, 100);
      expect(await queueMarks()).toEqual([[id, false]]);

      setTakenDown(true);
      expect(await queueMarks()).toEqual([[id, true]]);
      for (const action of ['approve', 'decline'] as const)
        await expect(
          actOnStorylineContinuation({ placementId: id, ownerId: OWNER, action })
        ).rejects.toThrow(STORYLINE_REFUSALS.notAChapter);
      await expect(settleOrphanedContinuations()).resolves.toMatchObject({ settled: 0 });
      expect(db.row('placement', { id })).toMatchObject({ status: 'pending' });
      expect(moneyCalls().refunds).toEqual([]);

      setTakenDown(false);
      expect(await queueMarks()).toEqual([[id, false]]);
      await expect(
        actOnStorylineContinuation({ placementId: id, ownerId: OWNER, action: 'approve' })
      ).resolves.toEqual({ settled: true, status: 'approved' });
    });
  });

  describe('a storyline the title scan holds as about a minor', () => {
    const PG13 = 2;
    const R = 4;
    const R_POST = 500;
    const PG13_POST = 600;
    const holdAsMinor = (minorByScan: boolean) =>
      db.update('storyline', { id: STORYLINE }, { minorByScan });
    const approve = (placementId: number) =>
      actOnStorylineContinuation({ placementId, ownerId: OWNER, action: 'approve' });

    beforeEach(() => {
      db.update('storyline', { id: STORYLINE }, { maxNsfwLevel: X });
      publishedPost(R_POST, STRANGER, R);
      publishedPost(PG13_POST, STRANGER, PG13);
    });

    // The control: under the owner's X ceiling alone, the same R continuation goes in.
    it('takes an R continuation when only the owner’s ceiling applies', async () => {
      const { id } = await submit(STRANGER, R_POST);
      await expect(approve(id)).resolves.toEqual({ settled: true, status: 'approved' });
      expect(chapterFor(id)).toMatchObject({ postId: R_POST });
    });

    it('refuses an R continuation at submission, and takes a PG-13 one', async () => {
      holdAsMinor(true);
      await expect(submit(STRANGER, R_POST)).rejects.toThrow(STORYLINE_REFUSALS.aboveRating);
      expect(db.rows('placement')).toEqual([]);

      const { id } = await submit(STRANGER, PG13_POST);
      await expect(approve(id)).resolves.toEqual({ settled: true, status: 'approved' });
      expect(chapterFor(id)).toMatchObject({ postId: PG13_POST });
    });

    it('refuses at approval an R continuation sent before the title was flagged', async () => {
      const { id } = await submit(STRANGER, R_POST);
      holdAsMinor(true);
      await expect(approve(id)).rejects.toThrow(/above the storyline's maximum rating/);
      expect(chapterFor(id)).toBeUndefined();
      expect(db.row('placement', { id })).toMatchObject({ status: 'pending' });
    });

    // The queue marks a row above the ceiling approval would refuse it at.
    it("shows the owner's queue the ceiling approval holds the row to", async () => {
      await submit(STRANGER, R_POST);
      const ceilingOf = async () =>
        (await getPendingStorylineContinuations({ ownerId: OWNER, domainLevels: ALL_LEVELS }))
          .items[0].storyline.maxNsfwLevel;
      expect(await ceilingOf()).toBe(X);
      holdAsMinor(true);
      expect(await ceilingOf()).toBe(PG13);
    });

    it('hides an R chapter already in it, and gives it back when a clean rescan clears the flag', async () => {
      const { id } = await submit(STRANGER, R_POST);
      await approve(id);
      const chapterId = chapterFor(id)!.id;
      const tombstoneOf = async () =>
        (await children()).find((c) => c.chapterId === chapterId)?.tombstone;

      expect(await tombstoneOf()).toBeNull();
      holdAsMinor(true);
      expect(await tombstoneOf()).toBe('aboveStoryRating');
      holdAsMinor(false);
      expect(await tombstoneOf()).toBeNull();
    });
  });

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

    // A moderator takes the collaborator's chapter down. The stranger's pending
    // continuation of it can never be accepted, so it is refunded in full and
    // the owner earns nothing for it.
    describe('when a moderator takes it down', () => {
      const collaboratorPlacement = () =>
        db.row('placement', { placerId: COLLABORATOR })!.id as number;
      const takeDown = () =>
        removePlacementByModerator({ placementId: collaboratorPlacement(), actorId: MODERATOR });
      const queue = async () =>
        (await getPendingStorylineContinuations({ ownerId: OWNER, domainLevels: ALL_LEVELS }))
          .items;

      const failSettling = () => {
        const real = dbMock.dbWrite.$queryRaw.getMockImplementation()!;
        dbMock.dbWrite.$queryRaw.mockImplementation(
          async (strings: unknown, ...values: unknown[]) => {
            const text = Array.isArray(strings) ? strings.join('?') : String(strings);
            if (text.includes('"StorylineChapter"') && text.includes('pl.amount = 0 OR'))
              throw new Error('outage');
            return real(strings as never, ...values);
          }
        );
        return () => dbMock.dbWrite.$queryRaw.mockImplementation(real);
      };

      it('refunds a priced continuation of it in full, pays the owner nothing, and empties the queue', async () => {
        charge(100);
        const { id } = await submit(STRANGER, STRANGER_SECOND_POST, 100, COLLABORATOR_POST);
        expect((await queue()).map((item) => item.id)).toEqual([id]);

        await takeDown();

        expect(db.row('placement', { id })).toMatchObject({ status: 'expired' });
        expect(moneyCalls().payouts).toEqual([]);
        expect(moneyCalls().refunds.sort()).toEqual([
          `placement-${id}-holdFee`,
          `placement-${id}-holdPrincipal`,
        ]);
        expect(await queue()).toEqual([]);
        await expect(
          actOnStorylineContinuation({ placementId: id, ownerId: OWNER, action: 'decline' })
        ).rejects.toThrow();
        expect(moneyCalls().payouts).toEqual([]);
      });

      // The removed chapter's row keeps holding its post, so the same post
      // cannot come back as a new continuation, of this storyline or any other.
      it('refuses its post as a new continuation, under any chapter', async () => {
        await takeDown();

        await expect(submit(COLLABORATOR, COLLABORATOR_POST)).rejects.toThrow(
          /already in a storyline/
        );
        expect(db.rows('placement').filter((p) => p.placerId === COLLABORATOR)).toHaveLength(1);
      });

      it('expires a free continuation of it, moving no money', async () => {
        const { id } = await submit(STRANGER, STRANGER_SECOND_POST, 0, COLLABORATOR_POST);

        await takeDown();

        expect(db.row('placement', { id })).toMatchObject({ status: 'expired' });
        expect(moneyCalls()).toEqual({ holds: [], payouts: [], refunds: [] });
      });

      // The takedown does not depend on the settle: from its commit, nobody can
      // be paid for the row, whatever happens to the refund.
      it('refuses a decline and hides the row from the instant the takedown commits, even when the refund fails', async () => {
        charge(100);
        const { id } = await submit(STRANGER, STRANGER_SECOND_POST, 100, COLLABORATOR_POST);
        failSettling();

        await expect(takeDown()).resolves.toMatchObject({ removed: true });

        expect(db.row('placement', { id })).toMatchObject({ status: 'pending' });
        expect(await queue()).toEqual([]);
        await expect(
          actOnStorylineContinuation({ placementId: id, ownerId: OWNER, action: 'decline' })
        ).rejects.toThrow(STORYLINE_REFUSALS.notAChapter);
        await expect(
          actOnStorylineContinuation({ placementId: id, ownerId: OWNER, action: 'approve' })
        ).rejects.toThrow(STORYLINE_REFUSALS.notAChapter);
        expect(db.row('placement', { id })).toMatchObject({ status: 'pending' });
        expect(moneyCalls().payouts).toEqual([]);
        expect(moneyCalls().refunds).toEqual([]);
      });

      it('settles what a failed refund left when the takedown is pressed again, and never twice', async () => {
        charge(100);
        const { id } = await submit(STRANGER, STRANGER_SECOND_POST, 100, COLLABORATOR_POST);
        const restore = failSettling();
        await takeDown();
        restore();

        await expect(takeDown()).rejects.toThrow('already removed');
        expect(db.row('placement', { id })).toMatchObject({ status: 'expired' });
        const refunded = [`placement-${id}-holdFee`, `placement-${id}-holdPrincipal`];
        expect(moneyCalls().refunds.sort()).toEqual(refunded);

        await expect(takeDown()).rejects.toThrow('already removed');
        await expect(settleOrphanedContinuations()).resolves.toEqual({
          considered: 0,
          settled: 0,
        });
        expect(moneyCalls().refunds.sort()).toEqual(refunded);
        expect(moneyCalls().payouts).toEqual([]);
      });

      it('settles what a failed refund left on the next run of the job', async () => {
        charge(100);
        const { id } = await submit(STRANGER, STRANGER_SECOND_POST, 100, COLLABORATOR_POST);
        const restore = failSettling();
        await takeDown();
        restore();

        await expect(settleOrphanedContinuations()).resolves.toEqual({
          considered: 1,
          settled: 1,
        });
        expect(db.row('placement', { id })).toMatchObject({ status: 'expired' });
        expect(moneyCalls().payouts).toEqual([]);
        expect(moneyCalls().refunds.sort()).toEqual([
          `placement-${id}-holdFee`,
          `placement-${id}-holdPrincipal`,
        ]);
      });

      it('falls back to its own deadline, refunding in full with no fee, when nothing else settles it', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const submittedAt = Date.now();
        charge(100);
        const { id } = await submit(STRANGER, STRANGER_SECOND_POST, 100, COLLABORATOR_POST);
        failSettling();
        await takeDown();

        vi.setSystemTime(submittedAt + 7 * 24 * 3_600_000 + 60_000);
        await expect(expirePlacements()).resolves.toMatchObject({ expired: 1 });

        expect(db.row('placement', { id })).toMatchObject({ status: 'expired' });
        expect(moneyCalls().payouts).toEqual([]);
        expect(moneyCalls().refunds.sort()).toEqual([
          `placement-${id}-holdFee`,
          `placement-${id}-holdPrincipal`,
        ]);
        expect(
          db
            .rows('placementTransaction')
            .filter((leg) => leg.placementId === id)
            .map((leg) => [leg.kind, leg.amount])
            .sort()
        ).toEqual([
          ['feeToPlacer', 30],
          ['holdFee', 30],
          ['holdPrincipal', 70],
          ['principalToPlacer', 70],
        ]);
      });

      // An answer racing the removal: unless the answer locks the parent row
      // before reading `removedAt`, it can read the row as live, commit after
      // the removal and pay the owner for a chapter that is gone. This fake has
      // no concurrency, so the order of the two statements is what is pinned.
      // If you are removing the lock, the race comes back with it.
      it('locks the parent chapter before reading whether it was removed', async () => {
        const { id } = await submit(STRANGER, STRANGER_SECOND_POST, 0, COLLABORATOR_POST);
        const order: string[] = [];
        const realRaw = dbMock.dbWrite.$queryRaw.getMockImplementation()!;
        dbMock.dbWrite.$queryRaw.mockImplementation(
          async (strings: unknown, ...values: unknown[]) => {
            const text = Array.isArray(strings) ? strings.join('?') : String(strings);
            if (
              text.includes('"StorylineChapter" WHERE "postId" =') &&
              text.includes('FOR NO KEY UPDATE')
            )
              order.push(`lock ${values[0]}`);
            return realRaw(strings as never, ...values);
          }
        );
        const realFind = dbMock.dbWrite.storylineChapter.findUnique.getMockImplementation()!;
        dbMock.dbWrite.storylineChapter.findUnique.mockImplementation(async (args: never) => {
          const where = (args as { where: { postId?: number } }).where;
          if (where.postId === COLLABORATOR_POST) order.push(`read ${where.postId}`);
          return realFind(args);
        });

        await actOnStorylineContinuation({ placementId: id, ownerId: OWNER, action: 'decline' });

        expect(order.slice(0, 2)).toEqual([
          `lock ${COLLABORATOR_POST}`,
          `read ${COLLABORATOR_POST}`,
        ]);
      });

      // Its holds are still landing: a refund now would be planned from the
      // part paid so far. Left for the unfunded sweep, and refused meanwhile.
      it('leaves a continuation whose payment is still landing for the unfunded sweep', async () => {
        charge(100);
        const { id } = await submit(STRANGER, STRANGER_SECOND_POST, 100, COLLABORATOR_POST);
        db.update(
          'placementTransaction',
          { placementId: id, kind: 'holdPrincipal' },
          { transactionId: null }
        );

        await takeDown();

        expect(db.row('placement', { id })).toMatchObject({ status: 'pending' });
        expect(moneyCalls().refunds).toEqual([]);
        expect(await queue()).toEqual([]);
      });

      it('settles the rest when one continuation fails to', async () => {
        charge(100);
        const { id: first } = await submit(STRANGER, STRANGER_SECOND_POST, 100, COLLABORATOR_POST);
        publishedPost(502, STRANGER, PG);
        const { id: second } = await submit(STRANGER, 502, 100, COLLABORATOR_POST);
        refundMultiAccountTransaction.mockImplementation(
          async ({ externalTransactionIdPrefix }: { externalTransactionIdPrefix: string }) => {
            if (externalTransactionIdPrefix.startsWith(`placement-${first}-`))
              throw new Error('buzz down');
            return {
              externalTransactionIdPrefix,
              refundedTransactions: [
                { refundTransactionId: `refund-${externalTransactionIdPrefix}` },
              ],
            };
          }
        );

        await takeDown();

        expect(db.row('placement', { id: second })).toMatchObject({ status: 'expired' });
        expect(
          moneyCalls()
            .refunds.filter((prefix) => prefix.startsWith(`placement-${second}-`))
            .sort()
        ).toEqual([`placement-${second}-holdFee`, `placement-${second}-holdPrincipal`]);
        expect(moneyCalls().payouts).toEqual([]);
      });

      it('falls back to its own deadline for a free continuation too, moving no money', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const submittedAt = Date.now();
        const { id } = await submit(STRANGER, STRANGER_SECOND_POST, 0, COLLABORATOR_POST);
        failSettling();
        await takeDown();

        vi.setSystemTime(submittedAt + 7 * 24 * 3_600_000 + 60_000);
        await expect(expirePlacements()).resolves.toMatchObject({ expired: 1 });

        expect(db.row('placement', { id })).toMatchObject({ status: 'expired' });
        expect(moneyCalls()).toEqual({ holds: [], payouts: [], refunds: [] });
      });

      // Then its post is deleted, which empties the removed chapter's postId:
      // nothing finds the parent by its post any more.
      describe('and its post is then deleted', () => {
        const deleteParentPost = () =>
          db.update('storylineChapter', { postId: COLLABORATOR_POST }, { postId: null });

        it('cannot be declined for a fee, and stays out of the queue', async () => {
          charge(100);
          const { id } = await submit(STRANGER, STRANGER_SECOND_POST, 100, COLLABORATOR_POST);
          failSettling();
          await takeDown();
          deleteParentPost();

          await expect(
            actOnStorylineContinuation({ placementId: id, ownerId: OWNER, action: 'decline' })
          ).rejects.toThrow(STORYLINE_REFUSALS.notAChapter);
          expect(db.row('placement', { id })).toMatchObject({ status: 'pending' });
          expect(moneyCalls().payouts).toEqual([]);
          expect(await queue()).toEqual([]);
        });

        it('is refunded in full by the job, once', async () => {
          charge(100);
          const { id } = await submit(STRANGER, STRANGER_SECOND_POST, 100, COLLABORATOR_POST);
          const restore = failSettling();
          await takeDown();
          restore();
          deleteParentPost();

          await expect(settleOrphanedContinuations()).resolves.toEqual({
            considered: 1,
            settled: 1,
          });
          await expect(settleOrphanedContinuations()).resolves.toEqual({
            considered: 0,
            settled: 0,
          });

          expect(db.row('placement', { id })).toMatchObject({ status: 'expired' });
          expect(moneyCalls().payouts).toEqual([]);
          expect(moneyCalls().refunds.sort()).toEqual([
            `placement-${id}-holdFee`,
            `placement-${id}-holdPrincipal`,
          ]);
          expect(
            db
              .rows('placementTransaction')
              .filter((leg) => leg.placementId === id)
              .map((leg) => [leg.kind, leg.amount])
              .sort()
          ).toEqual([
            ['feeToPlacer', 30],
            ['holdFee', 30],
            ['holdPrincipal', 70],
            ['principalToPlacer', 70],
          ]);
        });
      });
    });

    // Refunded rather than declined for a fee: the owner could never have accepted it. Restoring
    // the old decline brings the fee back.
    it('refunds a continuation whose parent post was deleted, rather than letting it be declined for a fee', async () => {
      charge(100);
      const { id } = await submit(STRANGER, STRANGER_SECOND_POST, 100, COLLABORATOR_POST);
      db.update('storylineChapter', { postId: COLLABORATOR_POST }, { postId: null });

      expect(await queueOf(OWNER)).toEqual([]);
      await expect(
        actOnStorylineContinuation({ placementId: id, ownerId: OWNER, action: 'decline' })
      ).rejects.toThrow(STORYLINE_REFUSALS.notAChapter);

      await expect(settleOrphanedContinuations()).resolves.toEqual({ considered: 1, settled: 1 });
      expect(db.row('placement', { id })).toMatchObject({ status: 'expired' });
      expect(moneyCalls().payouts).toEqual([]);
      expect(moneyCalls().refunds.sort()).toEqual([
        `placement-${id}-holdFee`,
        `placement-${id}-holdPrincipal`,
      ]);
    });
  });
});

describe('a continuation of a taken-down storyline', () => {
  // Its chapters stay, but none can take a continuation while it is down:
  // declining would pay the owner for something they could not accept.
  it('cannot be declined for a fee', async () => {
    charge(100);
    const { id } = await submit(STRANGER, STRANGER_POST, 100);
    db.update('storyline', { id: STORYLINE }, { tosViolation: true });

    await expect(
      actOnStorylineContinuation({ placementId: id, ownerId: OWNER, action: 'decline' })
    ).rejects.toThrow(STORYLINE_REFUSALS.notAChapter);
    expect(db.row('placement', { id })).toMatchObject({ status: 'pending' });
    expect(moneyCalls().payouts).toEqual([]);
  });

  // Accepted, not an oversight: the orphaned-continuation job selects by the
  // chapter, and a taken-down storyline's chapters stay live. Such a row is
  // refused above and refunded in full at its own deadline instead.
  it('is left to its deadline, which refunds it in full', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const submittedAt = Date.now();
    charge(100);
    const { id } = await submit(STRANGER, STRANGER_POST, 100);
    db.update('storyline', { id: STORYLINE }, { tosViolation: true });

    await expect(settleOrphanedContinuations()).resolves.toEqual({ considered: 0, settled: 0 });
    vi.setSystemTime(submittedAt + 7 * 24 * 3_600_000 + 60_000);
    await expect(expirePlacements()).resolves.toMatchObject({ expired: 1 });

    expect(db.row('placement', { id })).toMatchObject({ status: 'expired' });
    expect(moneyCalls().payouts).toEqual([]);
    expect(moneyCalls().refunds.sort()).toEqual([
      `placement-${id}-holdFee`,
      `placement-${id}-holdPrincipal`,
    ]);
  });
});

// The block cascade declines the blocker's pending placements on the person
// they blocked, keeping the fee for the owner. A continuation the owner could
// never accept is refunded in full instead, as it would be without the block.
describe('a placer blocking the owner', () => {
  const blockOwner = () => {
    db.block(STRANGER, OWNER);
    return declinePlacementsOnBlock({ ownerId: OWNER, placerId: STRANGER, waiveFee: false });
  };

  it('still pays the owner the fee for a continuation they could have accepted', async () => {
    charge(100);
    const { id } = await submit(STRANGER, STRANGER_POST, 100);

    await blockOwner();

    expect(db.row('placement', { id })).toMatchObject({ status: 'declined' });
    expect(moneyCalls().payouts).toEqual([[OWNER, 30]]);
  });

  it.each([
    [
      'removed',
      () => db.update('storylineChapter', { postId: ROOT_POST }, { removedAt: new Date() }),
    ],
    [
      'whose post was deleted',
      () => db.update('storylineChapter', { postId: ROOT_POST }, { postId: null }),
    ],
    [
      'in a taken-down storyline',
      () => db.update('storyline', { id: STORYLINE }, { tosViolation: true }),
    ],
  ])('refunds in full, with no fee, a continuation of a chapter %s', async (_, orphan) => {
    charge(100);
    const { id } = await submit(STRANGER, STRANGER_POST, 100);
    orphan();

    await blockOwner();

    expect(db.row('placement', { id })).toMatchObject({ status: 'expired' });
    expect(moneyCalls().payouts).toEqual([]);
    expect(moneyCalls().refunds.sort()).toEqual([
      `placement-${id}-holdFee`,
      `placement-${id}-holdPrincipal`,
    ]);
  });
});

const queueOf = async (ownerId: number) =>
  (await getPendingStorylineContinuations({ ownerId, domainLevels: ALL_LEVELS })).items;

afterAll(() => vi.useRealTimers());
