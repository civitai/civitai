import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NotificationService from '~/server/services/notification.service';
import type * as PlacementService from '~/server/services/placement.service';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';
import { createFakeDb, type FakeDb } from './storyline-loop.fake-db';

/**
 * A post drafted from the storyline flow becoming its chapter as it is published, through the
 * real publish step, placement and chapter code over the in-memory database
 * (./storyline-loop.fake-db), which rolls back and enforces the unique keys and the link's lock.
 * Only Buzz, the Redis lock, the creator's price cap and the notification send are replaced.
 */

const createMultiAccountBuzzTransaction = vi.fn();
vi.mock('~/server/services/buzz.service', () => ({
  createMultiAccountBuzzTransaction,
  createBuzzTransaction: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
}));
vi.mock('~/server/utils/distributed-lock', () => ({
  withDistributedLock: async (_options: unknown, operation: () => Promise<unknown>) => operation(),
}));
vi.mock('~/server/services/placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementService>()),
  placementPriceRange: async () => ({ min: 0, max: 10_000, freeSlotCap: 0 }),
}));
vi.mock('~/server/events/points/hooks', () => ({
  onPlacementApproved: async () => undefined,
  onPlacementsTakenDown: async () => undefined,
}));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  getAllHiddenForUser: async () => ({ hiddenImages: [], hiddenTags: [] }),
}));
vi.mock('~/server/rewards/active/stickerPlacementAccepted.reward', () => ({
  stickerPlacementAcceptedReward: { apply: async () => undefined },
}));
const createNotification = vi.fn();
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));

const {
  prepareStorylinePublish,
  finishStorylinePublish,
  promotePendingChapter,
  promoteReadyPendingChapters,
} = await import('~/server/services/storyline-publish.service');
const { dbMock } = await import('~/__tests__/mocks');

const OWNER = 10;
const STRANGER = 20;
const COLLABORATOR = 30;
const MODERATOR = 40;
/** Storyline 1 has chapter 1 (post 100); storyline 2 was started with no post yet. */
const STORY = 1;
const EMPTY_STORY = 2;
const ROOT_CHAPTER = 1;
const ROOT_POST = 100;
const DRAFT = 500;
const PG = 1;
const PG13 = 2;
const R = 4;

let db: FakeDb;

const post = (
  id: number,
  userId: number,
  { nsfwLevel = PG, publishedAt = null as Date | null, image = {} as Record<string, unknown> } = {}
) => {
  db.insert('post', {
    id,
    userId,
    title: `post ${id}`,
    nsfwLevel,
    publishedAt,
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
    ...image,
  });
};

/** The draft as `post.create` linked it, then published as the publish step's write would. */
const draft = (
  userId: number,
  link: { storylineId: number; parentChapterId?: number },
  options: Parameters<typeof post>[2] = {}
) => {
  post(DRAFT, userId, { publishedAt: new Date(Date.now() - 1_000), ...options });
  db.insert('storylinePendingChapter', {
    postId: DRAFT,
    userId,
    parentChapterId: null,
    ...link,
  });
};

const link = () => db.row('storylinePendingChapter', { postId: DRAFT });
const chapterOf = (postId: number) => db.row('storylineChapter', { postId });

const publish = async (
  actorId: number,
  context: {
    expectedPrice?: number;
    submitRefusal?: string;
    canSpend?: boolean;
    spendType?: 'yellow' | 'green';
  } = {}
) => {
  const prepared = await prepareStorylinePublish({
    postId: DRAFT,
    actorId,
    context: { spendType: 'yellow', canSpend: true, ...context },
  });
  return prepared ? finishStorylinePublish(prepared) : null;
};

const charge = (price: number) =>
  db.insert('placementSpace', {
    surface: 'storyline',
    entityType: 'storyline',
    entityId: STORY,
    mode: 'review',
    price,
    freeSlots: null,
    settings: null,
  });

beforeEach(() => {
  vi.clearAllMocks();
  createMultiAccountBuzzTransaction.mockResolvedValue({ transactionCount: 1 });
  db = createFakeDb();
  db.install();
  for (const [id, username] of [
    [OWNER, 'storyteller'],
    [STRANGER, 'stranger'],
    [COLLABORATOR, 'collaborator'],
  ] as const)
    db.insert('user', {
      id,
      username,
      image: null,
      bannedAt: null,
      deletedAt: null,
      muted: false,
      emailVerified: new Date(0),
      meta: {},
    });
  const story = {
    userId: OWNER,
    status: 'Ongoing',
    whoCanContinue: 'Anyone',
    maxNsfwLevel: PG,
    tosViolation: false,
    createdAt: new Date(0),
  };
  db.insert('storyline', { ...story, id: STORY, title: 'The Long Road' });
  db.insert('storyline', { ...story, id: EMPTY_STORY, title: 'Not Yet Begun' });
  post(ROOT_POST, OWNER, { publishedAt: new Date(0) });
  db.insert('storylineChapter', {
    id: ROOT_CHAPTER,
    storylineId: STORY,
    postId: ROOT_POST,
    userId: OWNER,
    depth: 0,
  });
  db.insert('storylineCollaborator', { storylineId: STORY, userId: COLLABORATOR });
});

afterEach(() => vi.useRealTimers());

describe("the owner's chapter 1", () => {
  it('is written as the post is published and rated, and the link goes with it', async () => {
    draft(OWNER, { storylineId: EMPTY_STORY });

    const outcome = await publish(OWNER);

    const chapter = chapterOf(DRAFT);
    expect(chapter).toMatchObject({ storylineId: EMPTY_STORY, depth: 0, userId: OWNER });
    expect(outcome).toEqual({
      storylineId: EMPTY_STORY,
      status: 'chapterWritten',
      chapterId: chapter!.id,
      ceilingRaisedTo: undefined,
    });
    expect(link()).toBeUndefined();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it.each([
    ['not rated yet', { nsfwLevel: 0 }],
    ['still scanning', { image: { ingestion: 'Pending' } }],
    ['in review', { image: { needsReview: 'minor' } }],
    ['scheduled for later', { publishedAt: new Date(Date.now() + 3_600_000) }],
  ])('waits while the post is %s: no chapter, and the link stays', async (_name, options) => {
    draft(OWNER, { storylineId: EMPTY_STORY }, options);

    await expect(publish(OWNER)).resolves.toEqual({
      storylineId: EMPTY_STORY,
      status: 'waiting',
      reason: 'notReady',
    });
    expect(chapterOf(DRAFT)).toBeUndefined();
    expect(link()).toMatchObject({ storylineId: EMPTY_STORY });
  });

  it('is written once a scheduled post goes live, with no publish of its own', async () => {
    draft(OWNER, { storylineId: EMPTY_STORY }, { publishedAt: new Date(Date.now() + 3_600_000) });
    await publish(OWNER);
    expect(chapterOf(DRAFT)).toBeUndefined();

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * 3_600_000 });
    await expect(promotePendingChapter(DRAFT)).resolves.toMatchObject({ status: 'written' });
    expect(chapterOf(DRAFT)).toMatchObject({ depth: 0 });
  });

  it('is not written when the scan refuses the post, and the link stays', async () => {
    draft(OWNER, { storylineId: EMPTY_STORY }, { image: { tosViolation: true } });

    await expect(publish(OWNER)).resolves.toMatchObject({
      status: 'waiting',
      reason: 'cannotSubmit',
    });
    expect(chapterOf(DRAFT)).toBeUndefined();
    expect(link()).toBeDefined();
  });

  it('raises the ceiling to fit a chapter 1 rated above it, and tells the owner', async () => {
    draft(OWNER, { storylineId: EMPTY_STORY }, { nsfwLevel: R });

    await expect(publish(OWNER)).resolves.toMatchObject({
      status: 'chapterWritten',
      ceilingRaisedTo: R,
    });
    expect(db.row('storyline', { id: EMPTY_STORY })).toMatchObject({ maxNsfwLevel: R });
    expect(chapterOf(DRAFT)).toMatchObject({ depth: 0 });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: OWNER,
        type: 'storyline-ceiling-raised',
        key: `storyline-ceiling-raised:${EMPTY_STORY}`,
        details: { storylineId: EMPTY_STORY, storylineTitle: 'Not Yet Begun', maxNsfwLevel: R },
      })
    );
  });

  it('still caps a minor-flagged title at safe for work, and refuses the chapter above it', async () => {
    db.update('storyline', { id: EMPTY_STORY }, { minorByScan: true });
    draft(OWNER, { storylineId: EMPTY_STORY }, { nsfwLevel: R });

    await expect(publish(OWNER)).resolves.toMatchObject({
      status: 'waiting',
      reason: 'aboveRating',
    });
    expect(db.row('storyline', { id: EMPTY_STORY })).toMatchObject({ maxNsfwLevel: PG });
    expect(chapterOf(DRAFT)).toBeUndefined();
    expect(link()).toBeDefined();
  });

  it('raises the ceiling to the highest rating among a mixed post', async () => {
    draft(OWNER, { storylineId: EMPTY_STORY }, { nsfwLevel: R | PG });

    await expect(publish(OWNER)).resolves.toMatchObject({ ceilingRaisedTo: R });
    expect(db.row('storyline', { id: EMPTY_STORY })).toMatchObject({ maxNsfwLevel: R });
  });

  it('reports the chapter written when the notice of the raise fails to send', async () => {
    createNotification.mockRejectedValueOnce(new Error('notifications down'));
    draft(OWNER, { storylineId: EMPTY_STORY }, { nsfwLevel: R });

    await expect(publish(OWNER)).resolves.toMatchObject({
      status: 'chapterWritten',
      ceilingRaisedTo: R,
    });
    expect(chapterOf(DRAFT)).toBeDefined();
  });

  it.each([
    ['muted', { muted: true }],
    [
      'required to verify their email',
      { emailVerified: null, meta: { emailVerificationRequired: true } },
    ],
  ])(
    'waits, keeping the link, while the owner is %s, whoever publishes',
    async (_name, standing) => {
      db.update('user', { id: OWNER }, standing);
      draft(OWNER, { storylineId: EMPTY_STORY });

      for (const actorId of [OWNER, MODERATOR])
        await expect(publish(actorId)).resolves.toMatchObject({
          status: 'waiting',
          reason: 'restricted',
        });
      expect(chapterOf(DRAFT)).toBeUndefined();
      expect(link()).toBeDefined();

      db.update('user', { id: OWNER }, { muted: false, emailVerified: new Date() });
      await expect(promotePendingChapter(DRAFT)).resolves.toMatchObject({ status: 'written' });
    }
  );

  it("is judged on the owner's standing, not the publisher's", async () => {
    draft(OWNER, { storylineId: EMPTY_STORY });

    await expect(
      publish(OWNER, { submitRefusal: 'Verify your email address to do this' })
    ).resolves.toMatchObject({ status: 'chapterWritten' });
  });

  it('keeps the link, for the readiness pass, when the write fails for a reason that may pass', async () => {
    draft(OWNER, { storylineId: EMPTY_STORY });
    dbMock.dbWrite.storyline.findUnique.mockRejectedValueOnce(new Error('connection reset'));

    await expect(publish(OWNER)).resolves.toMatchObject({ status: 'waiting', reason: 'notReady' });
    expect(chapterOf(DRAFT)).toBeUndefined();
    expect(link()).toBeDefined();
  });

  it('raises a minor-flagged title only as far as safe for work', async () => {
    db.update('storyline', { id: EMPTY_STORY }, { minorByScan: true });
    draft(OWNER, { storylineId: EMPTY_STORY }, { nsfwLevel: PG13 });

    await expect(publish(OWNER)).resolves.toMatchObject({ ceilingRaisedTo: PG13 });
    expect(db.row('storyline', { id: EMPTY_STORY })).toMatchObject({ maxNsfwLevel: PG13 });
  });

  // Before the post is ready too: the readiness pass leaves a taken-down storyline's drafts alone,
  // so a link kept here would never be written or dropped.
  it.each([
    ['ready', {}],
    ['still scanning', { image: { ingestion: 'Pending' } }],
  ])(
    'is dropped, with the reason, when the storyline was taken down (post %s)',
    async (_n, options) => {
      db.update('storyline', { id: EMPTY_STORY }, { tosViolation: true });
      draft(OWNER, { storylineId: EMPTY_STORY }, options);

      await expect(publish(OWNER)).resolves.toEqual({
        storylineId: EMPTY_STORY,
        status: 'dropped',
        reason: 'This storyline was taken down',
      });
      expect(chapterOf(DRAFT)).toBeUndefined();
      expect(link()).toBeUndefined();
    }
  );
});

describe('the owner continuing their own story', () => {
  it('writes the chapter under its parent, canon, as the post is published', async () => {
    draft(OWNER, { storylineId: STORY, parentChapterId: ROOT_CHAPTER });

    await expect(publish(OWNER)).resolves.toMatchObject({ status: 'chapterWritten' });
    const chapter = chapterOf(DRAFT);
    expect(chapter).toMatchObject({ storylineId: STORY, depth: 1 });
    expect(db.row('storylineChapterEdge', { chapterId: chapter!.id })).toMatchObject({
      parentChapterId: ROOT_CHAPTER,
      canon: true,
    });
    expect(link()).toBeUndefined();
  });

  it('leaves a continuation rated above the ceiling waiting, and raises nothing', async () => {
    draft(OWNER, { storylineId: STORY, parentChapterId: ROOT_CHAPTER }, { nsfwLevel: R });

    await expect(publish(OWNER)).resolves.toMatchObject({ reason: 'aboveRating' });
    expect(db.row('storyline', { id: STORY })).toMatchObject({ maxNsfwLevel: PG });
    expect(chapterOf(DRAFT)).toBeUndefined();
  });

  it.each([
    ['ready', {}],
    ['still scanning', { image: { ingestion: 'Pending' } }],
  ])('is dropped, with the reason, when the parent was removed (post %s)', async (_n, options) => {
    db.update('storylineChapter', { id: ROOT_CHAPTER }, { removedAt: new Date() });
    draft(OWNER, { storylineId: STORY, parentChapterId: ROOT_CHAPTER }, options);

    await expect(publish(OWNER)).resolves.toEqual({
      storylineId: STORY,
      status: 'dropped',
      reason: STORYLINE_REFUSALS.notAChapter,
    });
    expect(chapterOf(DRAFT)).toBeUndefined();
    expect(link()).toBeUndefined();
  });
});

describe('writing the chapter once', () => {
  it('writes nothing the second time the step runs', async () => {
    draft(OWNER, { storylineId: EMPTY_STORY });

    await expect(promotePendingChapter(DRAFT)).resolves.toMatchObject({ status: 'written' });
    await expect(promotePendingChapter(DRAFT)).resolves.toEqual({ status: 'gone' });
    expect(db.rows('storylineChapter').filter((c) => c.postId === DRAFT)).toHaveLength(1);
  });

  it('gives way to a writer that wrote the chapter between its checks and its insert', async () => {
    draft(OWNER, { storylineId: EMPTY_STORY });
    const create = dbMock.dbWrite.storylineChapter.create.getMockImplementation()!;
    dbMock.dbWrite.storylineChapter.create.mockImplementationOnce(async (args) => {
      // The other writer's commit: chapter 1 of this storyline, from the same post.
      db.insert('storylineChapter', {
        storylineId: EMPTY_STORY,
        postId: DRAFT,
        userId: OWNER,
        depth: 0,
      });
      return create(args);
    });

    // Gives way rather than failing the publish or the readiness pass. (The fake's rollback also
    // takes the other writer's row, so the rows are not this test's to count.)
    await expect(promotePendingChapter(DRAFT)).resolves.toEqual({ status: 'gone' });
  });

  it('reports the chapter the other writer wrote to the editor', async () => {
    draft(OWNER, { storylineId: EMPTY_STORY });
    const prepared = await prepareStorylinePublish({
      postId: DRAFT,
      actorId: OWNER,
      context: { spendType: 'yellow', canSpend: true },
    });
    await promotePendingChapter(DRAFT);

    await expect(finishStorylinePublish(prepared!)).resolves.toEqual({
      storylineId: EMPTY_STORY,
      status: 'chapterWritten',
      chapterId: chapterOf(DRAFT)!.id,
    });
  });
});

describe("a contributor's continuation", () => {
  it('is submitted at publish, at the price shown, holding the Buzz then and not before', async () => {
    charge(100);
    draft(STRANGER, { storylineId: STORY, parentChapterId: ROOT_CHAPTER });
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();

    const outcome = await publish(STRANGER, { expectedPrice: 100 });

    const [placement] = db.rows('placement');
    expect(outcome).toEqual({ storylineId: STORY, status: 'submitted', placementId: placement.id });
    expect(placement).toMatchObject({
      placerId: STRANGER,
      ownerId: OWNER,
      targetId: ROOT_POST,
      amount: 100,
      status: 'pending',
      data: { postId: DRAFT },
    });
    expect(
      createMultiAccountBuzzTransaction.mock.calls.map((c) => [c[0].fromAccountId, c[0].amount])
    ).toEqual([
      [STRANGER, 30],
      [STRANGER, 70],
    ]);
    // A placement, not a chapter: the owner answers it.
    expect(chapterOf(DRAFT)).toBeUndefined();
    expect(link()).toBeUndefined();
  });

  it('refuses the publish when the price changed, writing nothing, so it can be retried', async () => {
    charge(100);
    draft(STRANGER, { storylineId: STORY, parentChapterId: ROOT_CHAPTER });

    await expect(publish(STRANGER, { expectedPrice: 50 })).rejects.toThrow(
      `${STORYLINE_REFUSALS.priceChanged}: now 100 Buzz`
    );
    await expect(publish(STRANGER, {})).rejects.toThrow(STORYLINE_REFUSALS.priceChanged);
    expect(db.rows('placement')).toEqual([]);
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    expect(link()).toBeDefined();

    await expect(publish(STRANGER, { expectedPrice: 100 })).resolves.toMatchObject({
      status: 'submitted',
    });
  });

  it("holds the Buzz in the request's own currency", async () => {
    charge(100);
    draft(STRANGER, { storylineId: STORY, parentChapterId: ROOT_CHAPTER });

    await publish(STRANGER, { expectedPrice: 100, spendType: 'green' });

    expect(db.rows('placement')[0]).toMatchObject({ spendType: 'green' });
    expect(createMultiAccountBuzzTransaction.mock.calls.map((c) => c[0].fromAccountTypes)).toEqual([
      ['green'],
      ['green'],
    ]);
  });

  it('publishes as a post of its own, with a generic reason, when the hold fails', async () => {
    charge(100);
    draft(STRANGER, { storylineId: STORY, parentChapterId: ROOT_CHAPTER });
    createMultiAccountBuzzTransaction.mockRejectedValue(new Error('buzz service down'));

    await expect(publish(STRANGER, { expectedPrice: 100 })).resolves.toEqual({
      storylineId: STORY,
      status: 'dropped',
      reason:
        'Your post was published, but it could not be sent to the storyline. Submit it from the storyline instead',
    });
    expect(db.rows('placement')[0]).toMatchObject({ status: 'expired' });
    expect(link()).toBeUndefined();
  });

  it('writes no placement when the link went before the submit landed', async () => {
    draft(STRANGER, { storylineId: STORY, parentChapterId: ROOT_CHAPTER });
    const prepared = await prepareStorylinePublish({
      postId: DRAFT,
      actorId: STRANGER,
      context: { expectedPrice: 0, spendType: 'yellow', canSpend: true },
    });
    // Detached by its author, or taken by another publish step, in between.
    await dbMock.dbWrite.storylinePendingChapter.deleteMany({ where: { postId: DRAFT } });

    await expect(finishStorylinePublish(prepared!)).resolves.toMatchObject({
      status: 'dropped',
      reason: STORYLINE_REFUSALS.alreadySubmitted,
    });
    expect(db.rows('placement')).toEqual([]);
  });

  it('waits for an unfinished post as a placement, as "Use a post you made" does', async () => {
    draft(
      STRANGER,
      { storylineId: STORY, parentChapterId: ROOT_CHAPTER },
      { image: { ingestion: 'Pending' } }
    );

    await expect(publish(STRANGER, { expectedPrice: 0 })).resolves.toMatchObject({
      status: 'submitted',
    });
    expect(db.rows('placement')[0].data).toEqual({ postId: DRAFT, awaitingReadiness: true });
  });

  it("puts an endorsed collaborator's chapter straight into the story", async () => {
    draft(COLLABORATOR, { storylineId: STORY, parentChapterId: ROOT_CHAPTER });

    await expect(publish(COLLABORATOR, { expectedPrice: 0 })).resolves.toMatchObject({
      status: 'submitted',
    });
    expect(db.rows('placement')[0]).toMatchObject({ status: 'approved' });
    expect(chapterOf(DRAFT)).toMatchObject({ storylineId: STORY, depth: 1, userId: COLLABORATOR });
  });

  it.each([
    [
      'a block between them',
      () => db.block(OWNER, STRANGER),
      'Continuations are not available on this chapter',
    ],
    [
      'a collaborators-only setting',
      () => db.update('storyline', { id: STORY }, { whoCanContinue: 'Collaborators' }),
      STORYLINE_REFUSALS.collaboratorsOnly,
    ],
    [
      'a removed parent',
      () => db.update('storylineChapter', { id: ROOT_CHAPTER }, { removedAt: new Date() }),
      STORYLINE_REFUSALS.notAChapter,
    ],
    [
      'a taken-down storyline',
      () => db.update('storyline', { id: STORY }, { tosViolation: true }),
      STORYLINE_REFUSALS.notAChapter,
    ],
  ])(
    'publishes as a post of its own, the link dropped and the reason returned, after %s',
    async (_name, arrange, reason) => {
      charge(100);
      draft(STRANGER, { storylineId: STORY, parentChapterId: ROOT_CHAPTER });
      arrange();

      // A price that is wrong as well: the closed storyline is the reason, not the price.
      await expect(publish(STRANGER, { expectedPrice: 50 })).resolves.toEqual({
        storylineId: STORY,
        status: 'dropped',
        reason,
      });
      expect(db.rows('placement')).toEqual([]);
      expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
      expect(link()).toBeUndefined();
    }
  );

  it('is dropped, with the reason, for an account that may not submit', async () => {
    draft(STRANGER, { storylineId: STORY, parentChapterId: ROOT_CHAPTER });

    await expect(
      publish(STRANGER, { expectedPrice: 0, submitRefusal: 'Verify your email address to do this' })
    ).resolves.toMatchObject({ status: 'dropped', reason: 'Verify your email address to do this' });
    expect(db.rows('placement')).toEqual([]);
  });

  it('is submitted once when the step runs twice', async () => {
    draft(STRANGER, { storylineId: STORY, parentChapterId: ROOT_CHAPTER });
    const first = await prepareStorylinePublish({
      postId: DRAFT,
      actorId: STRANGER,
      context: { expectedPrice: 0, spendType: 'yellow', canSpend: true },
    });
    const second = await prepareStorylinePublish({
      postId: DRAFT,
      actorId: STRANGER,
      context: { expectedPrice: 0, spendType: 'yellow', canSpend: true },
    });

    await expect(finishStorylinePublish(first!)).resolves.toMatchObject({ status: 'submitted' });
    await expect(finishStorylinePublish(second!)).resolves.toMatchObject({ status: 'dropped' });
    expect(db.rows('placement')).toHaveLength(1);
  });

  it.each([
    ['a moderator publishes it', MODERATOR, { expectedPrice: 0 }],
    // `post.update` takes a MediaWrite token; a continuation spends Buzz.
    ['the credential may not spend Buzz', STRANGER, { expectedPrice: 0, canSpend: false }],
  ])('is left alone, and nothing is charged, when %s', async (_name, actorId, context) => {
    draft(STRANGER, { storylineId: STORY, parentChapterId: ROOT_CHAPTER });

    await expect(publish(actorId, context)).resolves.toBeNull();
    expect(db.rows('placement')).toEqual([]);
    expect(link()).toBeDefined();
  });

  it('is never written as a chapter by the readiness pass', async () => {
    draft(STRANGER, { storylineId: STORY, parentChapterId: ROOT_CHAPTER });

    await expect(promotePendingChapter(DRAFT)).rejects.toThrow(
      "is not its storyline owner's draft"
    );
    expect(chapterOf(DRAFT)).toBeUndefined();
  });
});

describe('the readiness pass', () => {
  const selected = (postIds: number[]) => {
    const raw = dbMock.dbWrite.$queryRaw.getMockImplementation()!;
    dbMock.dbWrite.$queryRaw.mockImplementation(((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) =>
      strings.join('?').includes('FROM "StorylinePendingChapter" pc')
        ? Promise.resolve(postIds.map((postId) => ({ postId })))
        : raw(strings, ...values)) as never);
  };

  it("writes the owner's drafts that are ready, and tells the owner of a raised ceiling", async () => {
    draft(OWNER, { storylineId: EMPTY_STORY }, { nsfwLevel: R });
    selected([DRAFT]);

    await expect(promoteReadyPendingChapters()).resolves.toEqual({
      considered: 1,
      promoted: 1,
      dropped: 0,
    });
    expect(chapterOf(DRAFT)).toMatchObject({ depth: 0 });
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('drops a draft it is refused for, and goes on to the next', async () => {
    // Refused: the chapter's author blocked the owner after the draft was linked.
    draft(OWNER, { storylineId: STORY, parentChapterId: ROOT_CHAPTER });
    db.update('storylineChapter', { id: ROOT_CHAPTER }, { userId: COLLABORATOR });
    db.block(COLLABORATOR, OWNER);
    // Ready, behind it.
    const NEXT = DRAFT + 1;
    post(NEXT, OWNER, { publishedAt: new Date(Date.now() - 1_000) });
    db.insert('storylinePendingChapter', {
      postId: NEXT,
      storylineId: EMPTY_STORY,
      userId: OWNER,
      parentChapterId: null,
    });
    selected([DRAFT, NEXT]);

    await expect(promoteReadyPendingChapters()).resolves.toEqual({
      considered: 2,
      promoted: 1,
      dropped: 1,
    });
    expect(link()).toBeUndefined();
    expect(chapterOf(NEXT)).toMatchObject({ storylineId: EMPTY_STORY, depth: 0 });
  });

  it('keeps the link of a draft whose write failed for a reason that may pass', async () => {
    draft(OWNER, { storylineId: EMPTY_STORY });
    dbMock.dbWrite.storyline.findUnique.mockRejectedValueOnce(new Error('connection reset'));
    selected([DRAFT]);

    await expect(promoteReadyPendingChapters()).resolves.toEqual({
      considered: 1,
      promoted: 0,
      dropped: 0,
    });
    expect(link()).toBeDefined();
  });
});
