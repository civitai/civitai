import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as Entities from '~/server/services/rating-review.entities';
import type * as Derived from '~/server/services/rating-review.derived';
import type * as Helpers from '~/server/services/article-rating-review.helpers';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as JobQueue from '~/server/services/job-queue.service';
import type * as Notifications from '~/server/services/notification.service';
import type * as Flipt from '~/server/flipt/client';

const { loadSubject, getScan, tryAutoApprove, staleSignal, overrideGate, enqueue, notify, flipt } =
  vi.hoisted(() => ({
    loadSubject: vi.fn(),
    getScan: vi.fn(),
    tryAutoApprove: vi.fn(),
    staleSignal: vi.fn(),
    overrideGate: vi.fn(),
    enqueue: vi.fn(),
    notify: vi.fn(),
    flipt: vi.fn(),
  }));

vi.mock('~/server/services/rating-review.entities', async (importOriginal) => ({
  ...(await importOriginal<typeof Entities>()),
  loadRatingReviewSubject: loadSubject,
  getRatingReviewScan: getScan,
}));
vi.mock('~/server/services/rating-review.derived', async (importOriginal) => ({
  ...(await importOriginal<typeof Derived>()),
  getStaleOverrideSignal: staleSignal,
  evaluateOverrideAutoApprove: overrideGate,
}));
vi.mock('~/server/services/article-rating-review.helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof Helpers>()),
  tryAutoApproveArticleDispute: tryAutoApprove,
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  throwOnBlockedUserContent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/job-queue.service', async (importOriginal) => ({
  ...(await importOriginal<typeof JobQueue>()),
  enqueueJobs: enqueue,
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  createNotification: notify,
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof Flipt>()),
  isFlipt: flipt,
}));

const {
  createRatingReview,
  getRatingReviewForOwner,
  maybeAutoResolveRatingDisputeAfterScan,
  textChangedSinceResolution,
} = await import('~/server/services/rating-review.service');

const OWNER = 3;
const edited = new Date('2026-09-10T00:00:00Z');
const subject = (
  over: Partial<Entities.RatingReviewSubject> = {}
): Entities.RatingReviewSubject => ({
  ownerId: OWNER,
  currentLevel: 4,
  updatedAt: edited,
  title: 't',
  parentId: null,
  override: null,
  overrideBasis: null,
  ...over,
});
const scan = (over: Partial<Entities.RatingReviewScan> = {}): Entities.RatingReviewScan => ({
  raised: true,
  level: 4,
  reason: 'fake reason',
  textHash: 'h-now',
  pending: false,
  ...over,
});
const lastResolved = (row: { resolvedAt: Date; resolvedTextHash: string | null }) =>
  dbMock.dbRead.ratingReview.findFirst.mockImplementation(
    async (args: { where: { status: unknown } }) =>
      typeof args.where.status === 'object' ? row : null
  );

const file = (over: Partial<Parameters<typeof createRatingReview>[0]> = {}) =>
  createRatingReview({
    entityType: 'Post',
    entityId: 7,
    suggestedLevel: 2,
    userId: OWNER,
    ...over,
  });

const scanRow = (textHash: string) => ({ result: { version: 1, textHash, labels: {} } });

beforeEach(() => {
  vi.clearAllMocks();
  loadSubject.mockResolvedValue(subject());
  getScan.mockResolvedValue(scan());
  tryAutoApprove.mockResolvedValue(null);
  overrideGate.mockResolvedValue({ eligible: false, reason: 'no-override', derivedLevel: null });
  staleSignal.mockResolvedValue({ derivedLevel: null, derivedRatingDroppedBelowOverride: false });
  enqueue.mockResolvedValue(undefined);
  notify.mockResolvedValue(undefined);
  redisMock.redis.incr.mockResolvedValue(1);
  dbMock.dbRead.ratingReview.findFirst.mockResolvedValue(null);
  dbMock.dbWrite.ratingReview.create.mockImplementation(async ({ data }: { data: object }) => ({
    id: 1,
    ...data,
  }));
  dbMock.dbWrite.$transaction.mockImplementation(
    async (fn: (tx: typeof dbMock.dbWrite) => unknown) => fn(dbMock.dbWrite)
  );
  dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue(scanRow('h-now'));
  dbMock.dbWrite.ratingReview.updateMany.mockResolvedValue({ count: 1 });
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
  flipt.mockResolvedValue(true);
});

describe('textChangedSinceResolution', () => {
  const at = new Date('2026-09-05T00:00:00Z');
  it('compares the scan text hash when the resolution recorded one, ignoring updatedAt', () => {
    expect(
      textChangedSinceResolution({ resolvedAt: at, resolvedTextHash: 'h1' }, edited, 'h2')
    ).toBe(true);
    expect(
      textChangedSinceResolution({ resolvedAt: at, resolvedTextHash: 'h1' }, edited, 'h1')
    ).toBe(false);
    expect(
      textChangedSinceResolution({ resolvedAt: at, resolvedTextHash: 'h1' }, edited, null)
    ).toBe(false);
  });

  it('falls back to updatedAt for a hashless (copied) resolution', () => {
    expect(
      textChangedSinceResolution({ resolvedAt: at, resolvedTextHash: null }, edited, 'h')
    ).toBe(true);
    expect(
      textChangedSinceResolution({ resolvedAt: edited, resolvedTextHash: null }, edited, 'h')
    ).toBe(false);
    expect(textChangedSinceResolution(null, null, null)).toBe(true);
  });
});

describe('createRatingReview', () => {
  it('files a Pending review snapshotting the normalized current level', async () => {
    await file();
    expect(dbMock.dbWrite.ratingReview.create).toHaveBeenCalledWith({
      data: {
        entityType: 'Post',
        entityId: 7,
        userId: OWNER,
        currentLevel: 4,
        suggestedLevel: 2,
        userComment: null,
        status: 'Pending',
      },
    });
  });

  it('refuses a non-owner and an ownerless system challenge', async () => {
    await expect(file({ userId: 99 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    loadSubject.mockResolvedValue(subject({ ownerId: null }));
    await expect(file({ entityType: 'Challenge', suggestedLevel: 1 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses a flag-restricted model even though the scan raised it, and inserts nothing', async () => {
    loadSubject.mockResolvedValue(subject({ disputeRestriction: 'flag stands' }));
    await expect(file({ entityType: 'Model', suggestedLevel: 1 })).rejects.toThrow('flag stands');
    expect(dbMock.dbWrite.ratingReview.create).not.toHaveBeenCalled();
  });

  it('refuses a collection with a forced level with the restriction message', async () => {
    loadSubject.mockResolvedValue(
      subject({ currentLevel: 4, disputeRestriction: "the level is fixed, can't be disputed" })
    );
    await expect(file({ entityType: 'Collection', suggestedLevel: 1 })).rejects.toThrow(
      /can't be disputed/
    );
    expect(dbMock.dbWrite.ratingReview.create).not.toHaveBeenCalled();
  });

  it('refuses a non-Article rating the scan never raised, unless it was disputed before', async () => {
    getScan.mockResolvedValue(scan({ raised: false, level: null, reason: null }));
    await expect(file()).rejects.toThrow(/raised by our text scan/);

    lastResolved({ resolvedAt: new Date('2026-09-01T00:00:00Z'), resolvedTextHash: 'h-then' });
    await expect(file()).resolves.toMatchObject({ status: 'Pending' });
  });

  it('files an Article whatever the scan says, including an unrated one', async () => {
    getScan.mockResolvedValue(null);
    await expect(file({ entityType: 'Article' })).resolves.toMatchObject({ status: 'Pending' });
    loadSubject.mockResolvedValueOnce(subject({ currentLevel: 0 }));
    await expect(file({ entityType: 'Article', suggestedLevel: 1 })).resolves.toMatchObject({
      currentLevel: 0,
    });
  });

  it('refuses a non-Article unrated, a no-op, a Model half-level and an upward challenge', async () => {
    loadSubject.mockResolvedValueOnce(subject({ currentLevel: 0 }));
    await expect(file()).rejects.toThrow(/no rating/);
    await expect(file({ suggestedLevel: 4 })).rejects.toThrow(/matches the current rating/);
    loadSubject.mockResolvedValueOnce(subject({ currentLevel: 4 }));
    await expect(file({ entityType: 'Model', suggestedLevel: 2 })).rejects.toThrow(
      /offered ratings/
    );
    loadSubject.mockResolvedValueOnce(subject({ currentLevel: 4 }));
    await expect(file({ entityType: 'Challenge', suggestedLevel: 8 })).rejects.toThrow(
      /offered ratings/
    );
  });

  it('refuses a second Pending review and translates the unique-index race', async () => {
    dbMock.dbRead.ratingReview.findFirst.mockImplementation(
      async (args: { where: { status: unknown } }) =>
        args.where.status === 'Pending' ? { id: 5 } : null
    );
    await expect(file()).rejects.toThrow(/already pending/);

    dbMock.dbRead.ratingReview.findFirst.mockResolvedValue(null);
    dbMock.dbWrite.ratingReview.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' })
    );
    await expect(file()).rejects.toThrow(/already pending/);
  });

  it('re-files only once the scanned text changed, however recently the entity was saved', async () => {
    lastResolved({ resolvedAt: new Date('2026-09-01T00:00:00Z'), resolvedTextHash: 'h-now' });
    await expect(file()).rejects.toThrow(/Edit it before/);

    lastResolved({ resolvedAt: edited, resolvedTextHash: 'h-then' });
    await expect(file()).resolves.toMatchObject({ status: 'Pending' });
  });

  it('keeps the gate closed after an edit until a new scan lands, since a skipped or in-flight scan keeps the old hash', async () => {
    lastResolved({ resolvedAt: new Date('2026-09-01T00:00:00Z'), resolvedTextHash: 'h-now' });
    getScan.mockResolvedValue(scan({ textHash: 'h-now', pending: true }));
    await expect(file()).rejects.toThrow(/Edit it before/);
  });

  it('shares one 3-per-day budget across entity types, and moderators bypass it', async () => {
    redisMock.redis.incr.mockResolvedValue(4);
    await expect(file({ entityType: 'Model', suggestedLevel: 1 })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(redisMock.redis.incr).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`rating-review:rate:${OWNER}$`))
    );
    redisMock.redis.incr.mockClear();
    await expect(file({ isModerator: true })).resolves.toBeDefined();
    expect(redisMock.redis.incr).not.toHaveBeenCalled();
  });

  it('returns the auto-approved Article review without inserting another', async () => {
    tryAutoApprove.mockResolvedValue({ id: 9, status: 'Actioned' });
    await expect(file({ entityType: 'Article' })).resolves.toMatchObject({
      id: 9,
      status: 'Actioned',
    });
    expect(dbMock.dbWrite.ratingReview.create).not.toHaveBeenCalled();
  });

  it('auto-approves a stale Post override: clears the pair, stamps the hash, queues the recompute, notifies', async () => {
    loadSubject.mockResolvedValue(subject({ currentLevel: 8, override: 8, overrideBasis: 8 }));
    overrideGate.mockResolvedValue({ eligible: true, derivedLevel: 2 });
    dbMock.dbWrite.ratingReview.create.mockResolvedValue({ id: 21 });
    dbMock.dbWrite.ratingReview.findUniqueOrThrow.mockResolvedValue({
      id: 21,
      status: 'Actioned',
      appliedLevel: 2,
    });

    await expect(file({ suggestedLevel: 2 })).resolves.toMatchObject({
      id: 21,
      status: 'Actioned',
    });

    expect(dbMock.dbWrite.ratingReview.updateMany).toHaveBeenCalledWith({
      where: { id: 21, status: 'Pending' },
      data: expect.objectContaining({
        status: 'Actioned',
        appliedLevel: 2,
        resolvedBy: -1,
        resolvedTextHash: 'h-now',
      }),
    });
    const sqlAt = (i: number) => (dbMock.dbWrite.$executeRaw.mock.calls[i][0] as Prisma.Sql).sql;
    expect(sqlAt(0)).toMatch(
      /UPDATE "Post" SET "moderatorNsfwLevel" = NULL, "moderatorNsfwLevelBasis" = NULL/
    );
    expect(sqlAt(1)).toMatch(/UPDATE "Post" e SET "nsfwLevel" = /);
    expect(enqueue).toHaveBeenCalledWith([
      { entityId: 7, entityType: 'Post', type: 'UpdateNsfwLevel' },
    ]);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'rating-review-approved', key: 'rating-review-approved:21' })
    );
  });

  it('locks a bounty nsfw flag the auto-approve sets, so the owner cannot untick a system rating', async () => {
    loadSubject.mockResolvedValue(subject({ currentLevel: 8, override: 8, overrideBasis: 8 }));
    overrideGate.mockResolvedValue({ eligible: true, derivedLevel: 4 });
    dbMock.dbWrite.ratingReview.create.mockResolvedValue({ id: 23 });
    dbMock.dbWrite.ratingReview.findUniqueOrThrow.mockResolvedValue({ id: 23, status: 'Actioned' });

    await file({ entityType: 'Bounty', suggestedLevel: 4 });

    const clear = dbMock.dbWrite.$executeRaw.mock.calls[0][0] as Prisma.Sql;
    expect(clear.sql).toMatch(/UPDATE "Bounty" SET .*"nsfw" = \?,\s+"lockedProperties" = ARRAY\(/s);
    expect(clear.sql).toMatch(/ARRAY\['nsfw'\]::text\[\]/);
    expect(clear.values).toContain(true);
  });

  it('rolls an auto-approve back when the entity row is gone, leaving the review Pending', async () => {
    loadSubject.mockResolvedValue(subject({ currentLevel: 8, override: 8, overrideBasis: 8 }));
    overrideGate.mockResolvedValue({ eligible: true, derivedLevel: 2 });
    dbMock.dbWrite.ratingReview.create.mockResolvedValue({ id: 22 });
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0);

    await expect(file({ suggestedLevel: 2 })).rejects.toThrow(/no longer exists/);
    expect(enqueue).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([
    ['Challenge', 8, 2],
    ['Crucible', 8, 2],
    ['Collection', 4, 1],
  ] as const)(
    'sends a %s dispute to a moderator without asking the gate',
    async (entityType, currentLevel, suggestedLevel) => {
      loadSubject.mockResolvedValue(
        subject({ currentLevel, override: currentLevel, overrideBasis: currentLevel })
      );
      overrideGate.mockResolvedValue({ eligible: true, derivedLevel: 1 });
      await expect(file({ entityType, suggestedLevel })).resolves.toMatchObject({
        status: 'Pending',
      });
      expect(overrideGate).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.ratingReview.updateMany).not.toHaveBeenCalled();
    }
  );
});

describe('maybeAutoResolveRatingDisputeAfterScan', () => {
  const pending = { id: 31, suggestedLevel: 2, userId: OWNER, currentLevel: 8 };

  beforeEach(() => {
    dbMock.dbRead.ratingReview.findFirst.mockResolvedValue(pending);
    loadSubject.mockResolvedValue(subject({ currentLevel: 8, override: 8, overrideBasis: 8 }));
    overrideGate.mockResolvedValue({ eligible: true, derivedLevel: 2 });
    dbMock.dbWrite.ratingReview.findUniqueOrThrow.mockResolvedValue({ id: 31, status: 'Actioned' });
  });

  it('resolves the pending dispute the scan made eligible, notifying with the level it was filed at', async () => {
    await maybeAutoResolveRatingDisputeAfterScan('BountyEntry', 7);

    expect(overrideGate).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'BountyEntry', suggestedLevel: 2 })
    );
    expect(dbMock.dbWrite.ratingReview.updateMany).toHaveBeenCalledWith({
      where: { id: 31, status: 'Pending' },
      data: expect.objectContaining({
        status: 'Actioned',
        appliedLevel: 2,
        resolvedTextHash: 'h-now',
      }),
    });
    expect(dbMock.dbWrite.ratingReview.create).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'rating-review-approved:31',
        details: expect.objectContaining({ previousLevel: 'X', appliedLevel: 'PG-13' }),
      })
    );
  });

  it('reads the subject and scan from the primary, which the scan callback just wrote', async () => {
    await maybeAutoResolveRatingDisputeAfterScan('Post', 7);
    expect(loadSubject).toHaveBeenCalledWith('Post', 7, dbMock.dbWrite);
    expect(getScan).toHaveBeenCalledWith('Post', 7, dbMock.dbWrite);
  });

  it.each(['Challenge', 'Crucible', 'Collection'] as const)(
    'leaves a %s dispute Pending for a moderator, even after a raising scan',
    async (entityType) => {
      getScan.mockResolvedValue(scan({ raised: true }));
      await maybeAutoResolveRatingDisputeAfterScan(entityType, 7);
      expect(dbMock.dbRead.ratingReview.findFirst).not.toHaveBeenCalled();
      expect(overrideGate).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.ratingReview.updateMany).not.toHaveBeenCalled();
    }
  );

  it('does nothing without a pending dispute, with the flag off for the owner, or when the gate refuses', async () => {
    dbMock.dbRead.ratingReview.findFirst.mockResolvedValueOnce(null);
    await maybeAutoResolveRatingDisputeAfterScan('Post', 7);
    flipt.mockResolvedValueOnce(false);
    await maybeAutoResolveRatingDisputeAfterScan('Post', 7);
    overrideGate.mockResolvedValueOnce({
      eligible: false,
      reason: 'images-not-clean',
      derivedLevel: null,
    });
    await maybeAutoResolveRatingDisputeAfterScan('Post', 7);

    expect(flipt).toHaveBeenCalledWith('rating-dispute', String(OWNER));
    expect(dbMock.dbWrite.ratingReview.updateMany).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('writes nothing when a moderator resolved the dispute first', async () => {
    dbMock.dbWrite.ratingReview.updateMany.mockResolvedValue({ count: 0 });
    await maybeAutoResolveRatingDisputeAfterScan('Post', 7);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    dbMock.dbRead.ratingReview.findFirst.mockRejectedValueOnce(new Error('db down'));
    await expect(maybeAutoResolveRatingDisputeAfterScan('Post', 7)).resolves.toBeUndefined();
  });
});

describe('getRatingReviewForOwner', () => {
  it('opens resubmit only after the scanned text changed, and passes the scan reason through', async () => {
    dbMock.dbRead.ratingReview.findFirst.mockResolvedValue({
      id: 1,
      status: 'Unactioned',
      resolvedAt: new Date('2026-09-09T00:00:00Z'),
      resolvedTextHash: 'h-then',
    });
    const res = await getRatingReviewForOwner({ entityType: 'Post', entityId: 7, userId: OWNER });
    expect(res).toMatchObject({
      canResubmit: true,
      canDispute: true,
      currentLevel: 4,
      scanReason: 'fake reason',
    });
    expect(res.review).not.toHaveProperty('resolvedTextHash');

    dbMock.dbRead.ratingReview.findFirst.mockResolvedValue({
      id: 1,
      status: 'Unactioned',
      resolvedAt: edited,
      resolvedTextHash: 'h-now',
    });
    expect(
      (await getRatingReviewForOwner({ entityType: 'Post', entityId: 7, userId: OWNER }))
        .canResubmit
    ).toBe(false);
  });

  it('offers no dispute on a flag-restricted model, though the scan raised its rating', async () => {
    loadSubject.mockResolvedValue(subject({ currentLevel: 1, disputeRestriction: 'flag stands' }));
    const res = await getRatingReviewForOwner({ entityType: 'Model', entityId: 7, userId: OWNER });
    expect(res.canDispute).toBe(false);
  });

  it('asks for the stale-override signal for any overridable entity, and never for Model', async () => {
    loadSubject.mockResolvedValue(subject({ override: 8, overrideBasis: 8 }));
    staleSignal.mockResolvedValue({ derivedLevel: 2, derivedRatingDroppedBelowOverride: true });
    expect(
      (await getRatingReviewForOwner({ entityType: 'Bounty', entityId: 7, userId: OWNER }))
        .staleOverride
    ).toEqual({
      derivedLevel: 2,
      derivedRatingDroppedBelowOverride: true,
    });
    staleSignal.mockClear();
    expect(
      (await getRatingReviewForOwner({ entityType: 'Model', entityId: 7, userId: OWNER }))
        .staleOverride
    ).toBeNull();
    expect(staleSignal).not.toHaveBeenCalled();
  });

  it('hides the control on a non-Article nobody scanned up and nobody disputed', async () => {
    getScan.mockResolvedValue(null);
    const res = await getRatingReviewForOwner({ entityType: 'Bounty', entityId: 7, userId: OWNER });
    expect(res.canDispute).toBe(false);
  });

  it('refuses a non-owner', async () => {
    await expect(
      getRatingReviewForOwner({ entityType: 'Post', entityId: 7, userId: 99 })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
