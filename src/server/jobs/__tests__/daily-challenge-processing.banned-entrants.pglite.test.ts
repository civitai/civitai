import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as EngineRegistry from '~/server/games/daily-challenge/challenge-engine-registry';
import type * as ChallengeHelpers from '~/server/games/daily-challenge/challenge-helpers';
import type * as DailyChallengeUtils from '~/server/games/daily-challenge/daily-challenge.utils';
import type * as GenerativeContent from '~/server/games/daily-challenge/generative-content';
import type * as Flipt from '~/server/flipt/client';
import { ChallengeSource } from '~/shared/utils/prisma/enums';
import '~/__tests__/mocks/logging.mock';

// A ban leaves the user's entries ACCEPTED in the challenge collection. These run the job's real
// entry queries against PGlite to show a banned entrant is neither reviewed nor in the judged field,
// and that lifting the ban before completion makes them eligible again.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { mockGenerateReview, mockGetActiveChallenges } = vi.hoisted(() => ({
  mockGenerateReview: vi.fn(),
  mockGetActiveChallenges: vi.fn(),
}));

const JUDGED_TAG = 11;
const REVIEW_ME_TAG = 12;

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof Flipt>()),
  isFlipt: vi.fn().mockResolvedValue(true),
}));
vi.mock('~/server/games/daily-challenge/challenge-engine-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof EngineRegistry>()),
  resolveJudgingEngine: vi.fn().mockResolvedValue({ key: 'absolute', recordEntry: vi.fn() }),
}));
vi.mock('~/server/games/daily-challenge/daily-challenge.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof DailyChallengeUtils>()),
  getActiveChallenges: mockGetActiveChallenges,
  getChallengeConfig: vi.fn().mockResolvedValue({
    judgedTagId: JUDGED_TAG,
    reviewMeTagId: REVIEW_ME_TAG,
    reviewAmount: { min: 6, max: 12 },
    maxScoredPerUser: 5,
    defaultJudgeId: 1,
    defaultJudge: null,
  }),
  getJudgingConfig: vi.fn().mockResolvedValue({ judgeId: 1, userId: 999, prompts: {} }),
}));
vi.mock('~/server/games/daily-challenge/challenge-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof ChallengeHelpers>()),
  incrementOperationSpent: vi.fn().mockResolvedValue(undefined),
  saveReviewState: vi.fn(),
}));
vi.mock('~/server/games/daily-challenge/challenge-rewards', () => ({
  distributeParticipationPrizes: vi.fn().mockResolvedValue([]),
  promoteChallengeEntries: vi.fn().mockResolvedValue(0),
}));
vi.mock('~/server/games/daily-challenge/generative-content', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerativeContent>()),
  estimateBuzzCost: vi.fn().mockReturnValue(0),
  generateReview: mockGenerateReview,
}));
vi.mock('~/server/services/commentv3/comment-write.service', () => ({
  writeJudgeComment: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/reaction.service', () => ({
  toggleReaction: vi.fn().mockResolvedValue('created'),
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/events', () => ({
  eventEngine: { processEngagement: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('~/utils/logging', () => ({ createLogger: vi.fn(() => vi.fn()) }));

const { getJudgedEntries, reviewEntries } = await import(
  '~/server/jobs/daily-challenge-processing'
);

const CLEAN = 10;
const BANNED = 20;
const note = JSON.stringify({
  score: { theme: 8, aesthetic: 8, humor: 8, wittiness: 8 },
  summary: 's',
});

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, username text, "bannedAt" timestamp);
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int, url text, "nsfwLevel" int);
    CREATE TABLE "CollectionItem" (
      "collectionId" int, "imageId" int, "tagId" int, note text, status text,
      "reviewedAt" timestamp
    );
    CREATE TABLE "CommentV3" (
      "entityType" text, "entityId" int, "parentId" int, "deletedAt" timestamp, "userId" int
    );
    INSERT INTO "User" VALUES (${CLEAN}, 'clean', NULL), (${BANNED}, 'banned', NULL);
    INSERT INTO "Image" VALUES
      (1, ${CLEAN}, 'u1', 1), (2, ${BANNED}, 'u2', 1),
      (3, ${CLEAN}, 'u3', 1), (4, ${BANNED}, 'u4', 1);
    -- Already scored: in the judged field.
    INSERT INTO "CollectionItem" VALUES
      (100, 1, ${JUDGED_TAG}, '${note}', 'ACCEPTED', now()),
      (100, 2, ${JUDGED_TAG}, '${note}', 'ACCEPTED', now());
    -- Asked for review, not yet reviewed.
    INSERT INTO "CollectionItem" VALUES
      (100, 3, ${REVIEW_ME_TAG}, NULL, 'ACCEPTED', now()),
      (100, 4, ${REVIEW_ME_TAG}, NULL, 'ACCEPTED', now());
  `);
});
afterAll(() => db.close());

async function runOnPglite(strings: TemplateStringsArray, ...values: unknown[]) {
  const sql = Prisma.sql(strings, ...(values as never[]));
  const { rows } = await db.query(sql.text, sql.values as unknown[]);
  return rows;
}

/** Entry reads (every one joins User) go to PGlite; the job's other reads get inert answers. */
function routeQueries() {
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = strings.join('?');
    if (sql.includes('"judgingEngine"'))
      return [
        {
          allowedNsfwLevel: 1,
          judgeId: null,
          metadata: null,
          source: ChallengeSource.System,
          entryFee: 0,
          prizeMode: 'Fixed',
        },
      ];
    if (sql.includes('JOIN "User" u')) return runOnPglite(strings, ...values);
    return [];
  }) as never);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = strings.join('?');
    if (sql.includes('JOIN "User" u')) return runOnPglite(strings, ...values);
    if (sql.includes('AS "exists"')) return [{ exists: false }];
    return [];
  }) as never);
}

const setBanned = (bannedAt: Date | null) =>
  db.query(`UPDATE "User" SET "bannedAt" = $1 WHERE id = ${BANNED}`, [bannedAt]);

const judgedUserIds = async () =>
  (
    await getJudgedEntries(
      100,
      { judgedTagId: JUDGED_TAG, finalReviewAmount: 10 } as never,
      undefined,
      // User-sourced: no winner cooldown lookup, so the field is exactly what the query returns.
      ChallengeSource.User
    )
  )
    .map((entry) => entry.userId)
    .sort();

async function reviewedCreators() {
  mockGenerateReview.mockClear();
  await reviewEntries();
  return mockGenerateReview.mock.calls
    .map(([args]) => (args as { creator: string }).creator)
    .sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGenerateReview.mockResolvedValue({
    score: { theme: 8 },
    summary: 's',
    comment: 'nice',
    reaction: 'Like',
  });
  mockGetActiveChallenges.mockResolvedValue([
    { challengeId: 1, collectionId: 100, date: new Date(), theme: 't', modelVersionIds: [] },
  ]);
  routeQueries();
});

describe('banned entrants', () => {
  it('are left out of the judged field, and are back in once the ban is lifted', async () => {
    await setBanned(null);
    expect(await judgedUserIds()).toEqual([CLEAN, BANNED]);

    await setBanned(new Date());
    expect(await judgedUserIds()).toEqual([CLEAN]);

    await setBanned(null);
    expect(await judgedUserIds()).toEqual([CLEAN, BANNED]);
  });

  it('are not reviewed while banned, and are reviewed on the next tick once the ban is lifted', async () => {
    await setBanned(new Date());
    expect(await reviewedCreators()).toEqual(['clean']);

    await setBanned(null);
    expect(await reviewedCreators()).toEqual(['banned', 'clean']);
  });
});
