import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import type * as CommentModeration from '~/server/services/commentv3/moderation.service';
import type * as JobLock from '~/server/jobs/job-lock';
import type * as DailyChallengeUtils from '~/server/games/daily-challenge/daily-challenge.utils';
import { ChallengeStatus } from '~/shared/utils/prisma/enums';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const JUDGE_USER = 999;
const JUDGED_TAG = 11;
const REVIEW_ME_TAG = 12;

const { mockBulkDeleteComments, mockAcquireJobLock } = vi.hoisted(() => ({
  mockBulkDeleteComments: vi.fn<typeof CommentModeration.bulkDeleteComments>(async () => ({
    deleted: 0,
  })),
  mockAcquireJobLock: vi.fn(),
}));
vi.mock('~/server/jobs/job-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof JobLock>()),
  acquireJobLock: mockAcquireJobLock,
}));
vi.mock('~/server/services/commentv3/moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentModeration>()),
  bulkDeleteComments: mockBulkDeleteComments,
}));
vi.mock('~/server/games/daily-challenge/daily-challenge.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof DailyChallengeUtils>()),
  getChallengeConfig: vi.fn(async () => ({
    judgedTagId: JUDGED_TAG,
    reviewMeTagId: REVIEW_ME_TAG,
    defaultJudgeId: 1,
    defaultJudge: { judgeId: 1, userId: JUDGE_USER },
  })),
}));

const { rejudgeChallenge } = await import('~/server/services/challenge.service');
const { saveReviewState } = await import('~/server/games/daily-challenge/challenge-helpers');

let db: PGlite;
const run = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) => {
  const sql = Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);
  return db.query(sql.text, sql.values as unknown[]);
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Challenge" (id int PRIMARY KEY, metadata jsonb);
    CREATE TABLE "CollectionItem" (
      "collectionId" int, "imageId" int, status text, "tagId" int, note text
    );
    CREATE TABLE "CommentV3" (
      id int PRIMARY KEY, "entityType" text, "entityId" int, "parentId" int,
      "deletedAt" timestamp, "userId" int
    );
    CREATE TABLE "ChallengeEntryStanding" ("challengeId" int, "imageId" int);
    CREATE TABLE "ChallengeEntryComparison" ("challengeId" int);
  `);
});
afterAll(() => db.close());

const active = {
  status: ChallengeStatus.Active,
  endsAt: new Date(Date.now() + 3_600_000),
  collectionId: 100,
  judgeId: null,
};

beforeEach(async () => {
  vi.clearAllMocks();
  await db.exec(`
    TRUNCATE "Challenge", "CollectionItem", "CommentV3", "ChallengeEntryStanding",
      "ChallengeEntryComparison";
    INSERT INTO "Challenge" VALUES (1, '{"reviewedAt": 5, "pendingReview": {"50": 1}}');
    INSERT INTO "CollectionItem" VALUES
      (100, 1, 'ACCEPTED', ${JUDGED_TAG}, '{"score":{}}'),  -- judged
      (100, 2, 'ACCEPTED', NULL, NULL),                     -- judge commented, tag since reset
      (100, 3, 'ACCEPTED', NULL, NULL),                     -- never sampled
      (100, 4, 'ACCEPTED', ${REVIEW_ME_TAG}, 'challenge-review-1-4'), -- paid, not yet judged
      (100, 5, 'REJECTED', ${JUDGED_TAG}, '{"score":{}}'),
      (200, 6, 'ACCEPTED', ${JUDGED_TAG}, '{"score":{}}'),  -- another challenge
      (100, 7, 'ACCEPTED', ${JUDGED_TAG}, NULL);             -- tagged by hand, never judged
    INSERT INTO "CommentV3" VALUES
      (10, 'image', 1, NULL, NULL, ${JUDGE_USER}),
      (11, 'image', 2, NULL, NULL, ${JUDGE_USER}),
      (12, 'image', 1, 10, NULL, ${JUDGE_USER}),  -- the judge's reply, not a review
      (13, 'image', 3, NULL, NULL, 7),            -- someone else's comment
      (14, 'image', 6, NULL, NULL, ${JUDGE_USER}),
      (15, 'image', 3, NULL, now(), ${JUDGE_USER}),  -- deleted
      (16, 'article', 3, NULL, NULL, ${JUDGE_USER});
    INSERT INTO "ChallengeEntryStanding" VALUES (1, 1), (2, 6);
    INSERT INTO "ChallengeEntryComparison" VALUES (1), (2);
  `);
  dbMock.dbWrite.challenge.findUnique.mockResolvedValue(active as never);
  mockAcquireJobLock.mockResolvedValue({ release: vi.fn(async () => undefined) });
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(
    (async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
      (await run(first, values)).rows) as never
  );
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(
    (async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
      (await run(first, values)).affectedRows ?? 0) as never
  );
});

const items = async () =>
  (
    await db.query<{ imageId: number; tagId: number | null; note: string | null }>(
      `SELECT "imageId", "tagId", note FROM "CollectionItem" ORDER BY "imageId"`
    )
  ).rows;
const metadata = async () =>
  (await db.query<{ metadata: Record<string, unknown> }>(`SELECT metadata FROM "Challenge"`))
    .rows[0].metadata;

describe('rejudgeChallenge', () => {
  it('owes a review to each judged entry, and only those', async () => {
    expect(await rejudgeChallenge({ id: 1, moderatorId: 2 })).toEqual({ entries: 2 });

    expect(await metadata()).toEqual({
      reviewedAt: 5,
      pendingReview: { '1': 0, '2': 0, '50': 1 },
    });
  });

  it("asks for the judge's top-level comments and reactions to go, and clears its tag and score", async () => {
    await rejudgeChallenge({ id: 1, moderatorId: 2 });

    expect(mockBulkDeleteComments).toHaveBeenCalledWith({
      ids: expect.arrayContaining([10, 11]),
    });
    expect(mockBulkDeleteComments.mock.calls[0]?.[0].ids).toHaveLength(2);
    expect(dbMock.dbWrite.imageReaction.deleteMany).toHaveBeenCalledWith({
      where: { imageId: { in: expect.arrayContaining([1, 2]) }, userId: JUDGE_USER },
    });
    expect(await items()).toEqual([
      { imageId: 1, tagId: null, note: null },
      { imageId: 2, tagId: null, note: null },
      { imageId: 3, tagId: null, note: null },
      { imageId: 4, tagId: REVIEW_ME_TAG, note: 'challenge-review-1-4' },
      { imageId: 5, tagId: JUDGED_TAG, note: '{"score":{}}' },
      { imageId: 6, tagId: JUDGED_TAG, note: '{"score":{}}' },
      { imageId: 7, tagId: JUDGED_TAG, note: null },
    ]);
  });

  it("clears this challenge's ladder and leaves other challenges' alone", async () => {
    await rejudgeChallenge({ id: 1, moderatorId: 2 });

    expect((await db.query(`SELECT "challengeId" FROM "ChallengeEntryStanding"`)).rows).toEqual([
      { challengeId: 2 },
    ]);
    expect((await db.query(`SELECT "challengeId" FROM "ChallengeEntryComparison"`)).rows).toEqual([
      { challengeId: 2 },
    ]);
  });

  it('refuses while a review tick holds the job lock, and changes nothing', async () => {
    mockAcquireJobLock.mockResolvedValue(null);

    await expect(rejudgeChallenge({ id: 1, moderatorId: 2 })).rejects.toThrow(
      'The review job is running'
    );
    expect(mockBulkDeleteComments).not.toHaveBeenCalled();
    expect(await metadata()).toEqual({ reviewedAt: 5, pendingReview: { '50': 1 } });
  });

  it.each([
    ['a completed challenge', { ...active, status: ChallengeStatus.Completed }],
    ['a challenge past its end time', { ...active, endsAt: new Date(Date.now() - 1000) }],
  ])('refuses %s and changes nothing', async (_label, challenge) => {
    dbMock.dbWrite.challenge.findUnique.mockResolvedValue(challenge as never);

    await expect(rejudgeChallenge({ id: 1, moderatorId: 2 })).rejects.toThrow(
      'Only an active challenge can be re-judged'
    );
    expect(mockBulkDeleteComments).not.toHaveBeenCalled();
    expect((await items())[0]).toEqual({ imageId: 1, tagId: JUDGED_TAG, note: '{"score":{}}' });
  });
});

describe('saveReviewState', () => {
  it('stamps the tick and settles only the owed keys the tick read', async () => {
    await db.exec(
      `UPDATE "Challenge" SET metadata = '{"reviewedAt": 5, "pendingReview": {"7": 0, "8": 1, "9": 1}}'`
    );

    await saveReviewState({
      challengeId: 1,
      reviewedAt: 20,
      resolved: ['7', '8'],
      retry: { '8': 2 },
    });

    // 9 stands for an entry a re-judge queued after the tick read the list.
    expect(await metadata()).toEqual({ reviewedAt: 20, pendingReview: { '8': 2, '9': 1 } });
  });
});
