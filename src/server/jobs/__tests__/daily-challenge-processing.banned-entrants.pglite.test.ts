import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as EngineRegistry from '~/server/games/daily-challenge/challenge-engine-registry';
import type * as ChallengeHelpers from '~/server/games/daily-challenge/challenge-helpers';
import type * as ChallengeRewards from '~/server/games/daily-challenge/challenge-rewards';
import type * as DailyChallengeUtils from '~/server/games/daily-challenge/daily-challenge.utils';
import type * as GenerativeContent from '~/server/games/daily-challenge/generative-content';
import type * as Flipt from '~/server/flipt/client';
import type * as BuzzService from '~/server/services/buzz.service';
import { ChallengeSource } from '~/shared/utils/prisma/enums';
import '~/__tests__/mocks/logging.mock';

// A ban leaves the user's entries ACCEPTED in the challenge collection. These run the job's real
// entry queries against PGlite to show a banned entrant is neither reviewed nor in the judged field,
// and that lifting the ban before completion makes them eligible again.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const {
  mockCreateBuzzTransactionMany,
  mockGenerateReview,
  mockGetActiveChallenges,
  mockSaveReviewState,
} = vi.hoisted(() => ({
  mockCreateBuzzTransactionMany: vi.fn(),
  mockGenerateReview: vi.fn(),
  mockGetActiveChallenges: vi.fn(),
  mockSaveReviewState: vi.fn(),
}));

const JUDGED_TAG = 11;
const REVIEW_ME_TAG = 12;
const OTHER_TAG = 13;

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
  saveReviewState: mockSaveReviewState,
}));
vi.mock('~/server/games/daily-challenge/challenge-rewards', () => ({
  distributeParticipationPrizes: vi.fn().mockResolvedValue([]),
  refundBannedEntrantReviews: vi.fn().mockResolvedValue([]),
  promoteChallengeEntries: vi.fn().mockResolvedValue(0),
}));
vi.mock('~/server/games/daily-challenge/generative-content', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerativeContent>()),
  estimateBuzzCost: vi.fn().mockReturnValue(0),
  generateReview: mockGenerateReview,
}));
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  createBuzzTransactionMany: mockCreateBuzzTransactionMany,
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
const { getChallengeConfig } = await import('~/server/games/daily-challenge/daily-challenge.utils');
const { withFreshnessCriteria } = await import('~/server/games/daily-challenge/recent-winners');

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
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int, url text, "nsfwLevel" int,
      "modelRestricted" boolean NOT NULL DEFAULT false,
      ingestion text DEFAULT 'Scanned', "blockedFor" text
    );
    CREATE TABLE "CollectionItem" (
      "collectionId" int, "imageId" int, "tagId" int, note text, status text,
      "reviewedAt" timestamp
    );
    CREATE TABLE "Challenge" ("collectionId" int, "modelVersionIds" int[] NOT NULL DEFAULT '{}');
    CREATE TABLE "CommentV3" (
      "entityType" text, "entityId" int, "parentId" int, "deletedAt" timestamp, "userId" int
    );
    INSERT INTO "User" VALUES (${CLEAN}, 'clean', NULL), (${BANNED}, 'banned', NULL);
    -- Odd image ids belong to the clean entrant, even ones to the banned entrant.
    INSERT INTO "Image" SELECT n, CASE WHEN n % 2 = 1 THEN ${CLEAN} ELSE ${BANNED} END, 'img-' || n, 1
      FROM generate_series(1, 8) n;
    -- Already scored: in the judged field.
    INSERT INTO "CollectionItem" VALUES
      (100, 1, ${JUDGED_TAG}, '${note}', 'ACCEPTED', now()),
      (100, 2, ${JUDGED_TAG}, '${note}', 'ACCEPTED', now());
    -- Asked for review, not yet reviewed.
    INSERT INTO "CollectionItem" VALUES
      (100, 3, ${REVIEW_ME_TAG}, NULL, 'ACCEPTED', now()),
      (100, 4, ${REVIEW_ME_TAG}, NULL, 'ACCEPTED', now());
    -- Accepted since the last tick, untagged: the random sample.
    INSERT INTO "CollectionItem" VALUES
      (100, 5, NULL, NULL, 'ACCEPTED', now()),
      (100, 6, NULL, NULL, 'ACCEPTED', now());
    -- Owed a review from an earlier tick; outside the sample window.
    INSERT INTO "CollectionItem" VALUES
      (100, 7, ${OTHER_TAG}, NULL, 'ACCEPTED', now() - interval '1 day'),
      (100, 8, ${OTHER_TAG}, NULL, 'ACCEPTED', now() - interval '1 day');
  `);
});
afterAll(() => db.close());

async function runOnPglite(strings: TemplateStringsArray, ...values: unknown[]) {
  const sql = Prisma.sql(strings, ...(values as never[]));
  const { rows } = await db.query(sql.text, sql.values as unknown[]);
  return rows;
}

let challengeRecordOverrides: Record<string, unknown> = {};
const winnerQueries: string[] = [];

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
          metadata: { pendingReview: { '7': 0, '8': 0 } },
          source: ChallengeSource.System,
          entryFee: 0,
          prizeMode: 'Fixed',
          ...challengeRecordOverrides,
        },
      ];
    if (sql.includes('"ChallengeWinner"')) {
      winnerQueries.push(Prisma.sql(strings, ...(values as never[])).text);
      return [{ reason: 'a past winning idea' }];
    }
    if (sql.includes('JOIN "User" u') || sql.includes('"ImageResourceNew"'))
      return runOnPglite(strings, ...values);
    return [];
  }) as never);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = strings.join('?');
    if (
      sql.includes('JOIN "User" u') ||
      sql.includes('HAVING COUNT(*) >=') ||
      sql.includes('"ImageResourceNew"') ||
      sql.includes("status = 'REVIEW'")
    )
      return runOnPglite(strings, ...values);
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

async function reviewedImageIds() {
  mockGenerateReview.mockClear();
  mockSaveReviewState.mockClear();
  await reviewEntries();
  return mockGenerateReview.mock.calls
    .map(([args]) => Number(/img-(\d+)/.exec((args as { imageUrl: string }).imageUrl)?.[1]))
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
    // The sample window opens at the challenge start.
    {
      challengeId: 1,
      collectionId: 100,
      date: new Date(0),
      theme: 't',
      modelVersionIds: [],
      // Out of reach in collection 100, so these cases never pay the entry prize.
      entryPrizeRequirement: 99,
      entryPrize: { buzz: 50, points: 0 },
    },
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

  it('are left out when the primary has the ban and the replica does not yet', async () => {
    await setBanned(null);
    // The replica (PGlite here) still reads the entrant as unbanned; the primary already has it.
    dbMock.dbWrite.user.findMany.mockResolvedValueOnce([{ id: BANNED }] as never);
    expect(await judgedUserIds()).toEqual([CLEAN]);
  });

  it('are not reviewed while banned: requested, sampled or owed', async () => {
    await setBanned(null);
    expect(await reviewedImageIds()).toEqual([3, 4, 5, 6, 7, 8]);

    await setBanned(new Date());
    expect(await reviewedImageIds()).toEqual([3, 5, 7]);
    // A banned entrant's owed review is settled, not kept, so it can't hold completion back.
    expect(mockSaveReviewState.mock.calls[0][0].resolved).toContain('8');
  });

  it('get a requested review on the next tick once the ban is lifted', async () => {
    await setBanned(new Date());
    expect(await reviewedImageIds()).not.toContain(4);

    await setBanned(null);
    expect(await reviewedImageIds()).toContain(4);
  });
});

// A mature image made with a base model that restricts mature images is visible only to its
// uploader, so it must not be judged, place, or be promoted into the field. Each case pairs a
// restricted mature entry with an unrestricted mature control that does go through.
describe('model-restricted mature entries', () => {
  const R = 4;
  const setImage = (ids: number[], nsfwLevel: number, modelRestricted: boolean) =>
    db.query(
      `UPDATE "Image" SET "nsfwLevel" = $1, "modelRestricted" = $2 WHERE id = ANY($3::int[])`,
      [nsfwLevel, modelRestricted, ids]
    );

  beforeEach(async () => {
    await setBanned(null);
    await setImage([1, 2, 3, 4, 5, 6, 7, 8], 1, false);
  });

  it('are left out of the judged field; an unrestricted R entry stays in', async () => {
    await setImage([1], R, true);
    await setImage([2], R, false);
    expect(await judgedUserIds()).toEqual([BANNED]);
  });

  it('are not handed to the judge: requested, sampled or owed', async () => {
    // Odd ids (requested 3, sampled 5, owed 7) restricted; even ids are the unrestricted controls.
    await setImage([3, 5, 7], R, true);
    await setImage([4, 6, 8], R, false);
    expect(await reviewedImageIds()).toEqual([4, 6, 8]);
  });

  it('are still judged when SFW, whatever the flag', async () => {
    await setImage([3, 5, 7], 1, true);
    expect(await reviewedImageIds()).toEqual([3, 4, 5, 6, 7, 8]);
  });

  describe('promoteChallengeEntries', () => {
    const PROMOTE_COLLECTION = 200;
    const RESTRICTED_R = 21;
    const UNRESTRICTED_R = 22;
    const RESTRICTED_SFW = 23;

    beforeAll(async () => {
      await db.exec(`
        CREATE TYPE "CollectionItemStatus" AS ENUM ('ACCEPTED', 'REVIEW', 'REJECTED');
        ALTER TABLE "Image" ADD COLUMN "createdAt" timestamp NOT NULL DEFAULT now();
        ALTER TABLE "CollectionItem" ADD COLUMN "reviewedById" int;
        INSERT INTO "Image" (id, "userId", url, "nsfwLevel", "modelRestricted") VALUES
          (${RESTRICTED_R}, ${CLEAN}, 'img-${RESTRICTED_R}', ${R}, true),
          (${UNRESTRICTED_R}, ${CLEAN}, 'img-${UNRESTRICTED_R}', ${R}, false),
          (${RESTRICTED_SFW}, ${CLEAN}, 'img-${RESTRICTED_SFW}', 1, true);
        INSERT INTO "CollectionItem" ("collectionId", "imageId", status) VALUES
          (${PROMOTE_COLLECTION}, ${RESTRICTED_R}, 'REVIEW'),
          (${PROMOTE_COLLECTION}, ${UNRESTRICTED_R}, 'REVIEW'),
          (${PROMOTE_COLLECTION}, ${RESTRICTED_SFW}, 'REVIEW');
      `);
    });

    it('rejects a restricted R entry the challenge level allows; promotes the controls', async () => {
      vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(
        (async (strings: TemplateStringsArray, ...values: unknown[]) =>
          (await runOnPglite(strings, ...values)).length) as never
      );
      const { promoteChallengeEntries } = await vi.importActual<typeof ChallengeRewards>(
        '~/server/games/daily-challenge/challenge-rewards'
      );

      await promoteChallengeEntries({
        collectionId: PROMOTE_COLLECTION,
        allowedNsfwLevel: 1 | R,
        modelVersionIds: [],
        challengeDate: new Date(0),
        reviewerId: 1,
      });

      const { rows } = await db.query<{ imageId: number; status: string }>(
        `SELECT "imageId", status FROM "CollectionItem" WHERE "collectionId" = $1 ORDER BY "imageId"`,
        [PROMOTE_COLLECTION]
      );
      expect(rows).toEqual([
        { imageId: RESTRICTED_R, status: 'REJECTED' },
        { imageId: UNRESTRICTED_R, status: 'ACCEPTED' },
        { imageId: RESTRICTED_SFW, status: 'ACCEPTED' },
      ]);
    });
  });

  describe('hourly entry-prize payout', () => {
    const PAYOUT_COLLECTION = 300;
    const PAID = 30;
    const MIXED = 40;
    const ALL_RESTRICTED = 50;

    beforeAll(async () => {
      // Every entry is recent and untagged. MIXED reaches the earner query through its one
      // unrestricted entry; ALL_RESTRICTED has no unrestricted entry to get there at all.
      await db.exec(`
        INSERT INTO "User" VALUES
          (${PAID}, 'paid', NULL), (${MIXED}, 'mixed', NULL), (${ALL_RESTRICTED}, 'restricted', NULL);
        INSERT INTO "Image" (id, "userId", url, "nsfwLevel", "modelRestricted") VALUES
          (31, ${PAID}, 'img-31', 1, false), (32, ${PAID}, 'img-32', ${R}, false),
          (41, ${MIXED}, 'img-41', 1, false), (42, ${MIXED}, 'img-42', ${R}, true),
          (51, ${ALL_RESTRICTED}, 'img-51', ${R}, true), (52, ${ALL_RESTRICTED}, 'img-52', ${R}, true);
        INSERT INTO "CollectionItem" ("collectionId", "imageId", status, "reviewedAt")
          SELECT ${PAYOUT_COLLECTION}, id, 'ACCEPTED', now() FROM "Image" WHERE id BETWEEN 31 AND 52;
      `);
    });

    it('pays only the entrant whose two counted entries are both unrestricted', async () => {
      mockCreateBuzzTransactionMany.mockResolvedValue({ transactions: [], conflicts: [] });
      mockGetActiveChallenges.mockResolvedValue([
        {
          challengeId: 3,
          collectionId: PAYOUT_COLLECTION,
          date: new Date(0),
          theme: 't',
          title: 't',
          modelVersionIds: [],
          entryPrizeRequirement: 2,
          entryPrize: { buzz: 50, points: 0 },
        },
      ]);

      await reviewEntries();

      expect(mockCreateBuzzTransactionMany).toHaveBeenCalledTimes(1);
      const paidTo = (
        mockCreateBuzzTransactionMany.mock.calls[0][0] as { toAccountId: number }[]
      ).map((tx) => tx.toAccountId);
      expect(paidTo).toEqual([PAID]);
    });
  });
});

// The featured resource has to be able to run on the entry's checkpoint. Entries submitted before
// the rule existed are still in collections: they cannot place, but they are not rejected.
describe('entries whose featured resource cannot run on their checkpoint', () => {
  const JUDGE_COLLECTION = 400;
  const PROMOTE_COLLECTION = 401;
  const PONY_LORA = 653;
  const KREA_CHECKPOINT = 701;
  const SDXL_CHECKPOINT = 702;
  const ON_KREA = 61;
  const ON_SDXL = 62;
  const NO_CHECKPOINT = 63;
  // SDXL only on a hand-credited (detected: false) row, which cannot rescue it.
  const ON_KREA_SDXL_CREDITED = 64;

  beforeAll(async () => {
    await db.exec(`
      DO $$ BEGIN
        CREATE TYPE "CollectionItemStatus" AS ENUM ('ACCEPTED', 'REVIEW', 'REJECTED');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "createdAt" timestamp NOT NULL DEFAULT now();
      ALTER TABLE "CollectionItem" ADD COLUMN IF NOT EXISTS "reviewedById" int;
      CREATE TABLE "Model" (id int PRIMARY KEY, type text);
      CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int, "baseModel" text);
      CREATE TABLE "ImageResourceNew" ("imageId" int, "modelVersionId" int, detected boolean);
      INSERT INTO "Model" VALUES (1, 'LORA'), (2, 'Checkpoint'), (3, 'Checkpoint');
      INSERT INTO "ModelVersion" VALUES
        (${PONY_LORA}, 1, 'Pony'),
        (${KREA_CHECKPOINT}, 2, 'Krea 2 Turbo'),
        (${SDXL_CHECKPOINT}, 3, 'SDXL 1.0');
      INSERT INTO "Image" (id, "userId", url, "nsfwLevel") VALUES
        (${ON_KREA}, ${CLEAN}, 'img-${ON_KREA}', 1),
        (${ON_SDXL}, ${CLEAN}, 'img-${ON_SDXL}', 1),
        (${NO_CHECKPOINT}, ${CLEAN}, 'img-${NO_CHECKPOINT}', 1),
        (${ON_KREA_SDXL_CREDITED}, ${CLEAN}, 'img-${ON_KREA_SDXL_CREDITED}', 1);
      INSERT INTO "ImageResourceNew" VALUES
        (${ON_KREA}, ${PONY_LORA}, true), (${ON_KREA}, ${KREA_CHECKPOINT}, true),
        (${ON_SDXL}, ${PONY_LORA}, true), (${ON_SDXL}, ${SDXL_CHECKPOINT}, true),
        (${NO_CHECKPOINT}, ${PONY_LORA}, true),
        (${ON_KREA_SDXL_CREDITED}, ${PONY_LORA}, true),
        (${ON_KREA_SDXL_CREDITED}, ${KREA_CHECKPOINT}, true),
        (${ON_KREA_SDXL_CREDITED}, ${SDXL_CHECKPOINT}, false);
      INSERT INTO "Challenge" VALUES
        (${JUDGE_COLLECTION}, '{${PONY_LORA}}'), (${PROMOTE_COLLECTION}, '{${PONY_LORA}}');
      INSERT INTO "CollectionItem" ("collectionId", "imageId", "tagId", note, status)
        SELECT ${JUDGE_COLLECTION}, id, ${JUDGED_TAG}, '${note}', 'ACCEPTED' FROM "Image"
        WHERE id IN (${ON_KREA}, ${ON_SDXL}, ${NO_CHECKPOINT}, ${ON_KREA_SDXL_CREDITED});
      INSERT INTO "CollectionItem" ("collectionId", "imageId", status)
        SELECT ${PROMOTE_COLLECTION}, id, 'REVIEW' FROM "Image"
        WHERE id IN (${ON_KREA}, ${ON_SDXL}, ${NO_CHECKPOINT}, ${ON_KREA_SDXL_CREDITED});
    `);
  });

  it('cannot place, even though it was accepted', async () => {
    const entries = await getJudgedEntries(
      JUDGE_COLLECTION,
      { judgedTagId: JUDGED_TAG, finalReviewAmount: 10 } as never,
      undefined,
      ChallengeSource.User,
      undefined,
      { limit: Infinity, perUserBest: false }
    );

    expect(entries.map((e) => e.imageId).sort()).toEqual([ON_SDXL, NO_CHECKPOINT]);
  });

  // Deliberate: an entry still in REVIEW may have paid an entry fee under the old rule, and fees are
  // not refunded. Promotion must not reject it; getJudgedEntries keeps it from placing. Do not add
  // the compatibility check back to promotion without a refund path.
  it('is still accepted at promotion, so a fee paid before the rule is not forfeited', async () => {
    vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(
      (async (strings: TemplateStringsArray, ...values: unknown[]) =>
        (await runOnPglite(strings, ...values)).length) as never
    );
    const { promoteChallengeEntries } = await vi.importActual<typeof ChallengeRewards>(
      '~/server/games/daily-challenge/challenge-rewards'
    );

    await promoteChallengeEntries({
      collectionId: PROMOTE_COLLECTION,
      allowedNsfwLevel: 1,
      modelVersionIds: [PONY_LORA],
      challengeDate: new Date(0),
      reviewerId: 1,
    });

    const { rows } = await db.query<{ imageId: number; status: string }>(
      `SELECT "imageId", status FROM "CollectionItem" WHERE "collectionId" = $1 ORDER BY "imageId"`,
      [PROMOTE_COLLECTION]
    );
    expect(rows).toEqual([
      { imageId: ON_KREA, status: 'ACCEPTED' },
      { imageId: ON_SDXL, status: 'ACCEPTED' },
      { imageId: NO_CHECKPOINT, status: 'ACCEPTED' },
      { imageId: ON_KREA_SDXL_CREDITED, status: 'ACCEPTED' },
    ]);
  });
});

describe('the judge-model shadow', () => {
  const SHADOW_MODEL = 'shadow/model';
  const shadowConfig = (provider?: object) => ({
    judgedTagId: JUDGED_TAG,
    reviewMeTagId: REVIEW_ME_TAG,
    reviewAmount: { min: 6, max: 12 },
    maxScoredPerUser: 5,
    defaultJudgeId: 1,
    defaultJudge: null,
    reviewShadow: { model: SHADOW_MODEL, sampleRate: 1, provider },
  });
  const pinned = { order: ['wafer/us'], allowFallbacks: false, dataCollection: 'deny' };

  async function shadowedImageIds() {
    await reviewedImageIds();
    return mockGenerateReview.mock.calls
      .filter(([args]) => (args as { model?: string }).model === SHADOW_MODEL)
      .map(([args]) => Number(/img-(\d+)/.exec((args as { imageUrl: string }).imageUrl)?.[1]))
      .sort();
  }

  beforeEach(async () => {
    await setBanned(null);
    await db.query(
      `UPDATE "Image" SET "nsfwLevel" = 1, "modelRestricted" = false, ingestion = 'Scanned'`
    );
  });
  // Back to a config that never shadows, for any case after this block.
  afterEach(() => vi.mocked(getChallengeConfig).mockResolvedValue(shadowConfig() as never));

  it('never gets a mature or unscanned entry; gets the scanned SFW ones', async () => {
    vi.mocked(getChallengeConfig).mockResolvedValue(shadowConfig(pinned) as never);
    await db.query(`UPDATE "Image" SET "nsfwLevel" = 4 WHERE id = 4`);
    await db.query(`UPDATE "Image" SET ingestion = 'Pending' WHERE id = 6`);

    expect(await shadowedImageIds()).toEqual([3, 5, 7, 8]);
  });

  it('never runs without a pin that denies data collection', async () => {
    vi.mocked(getChallengeConfig).mockResolvedValue(shadowConfig() as never);

    expect(await shadowedImageIds()).toEqual([]);
  });

  it('never sees the entrant username', async () => {
    vi.mocked(getChallengeConfig).mockResolvedValue(shadowConfig(pinned) as never);
    await shadowedImageIds();

    const creators = mockGenerateReview.mock.calls
      .filter(([args]) => (args as { model?: string }).model === SHADOW_MODEL)
      .map(([args]) => (args as { creator: string }).creator);
    expect(creators.length).toBeGreaterThan(0);
    expect(creators.every((c) => /^entry \d+$/.test(c))).toBe(true);
    const primaryCreators = mockGenerateReview.mock.calls
      .filter(([args]) => (args as { model?: string }).model !== SHADOW_MODEL)
      .map(([args]) => (args as { creator: string }).creator);
    expect(primaryCreators.length).toBeGreaterThan(0);
    expect(primaryCreators.every((c) => c === 'clean' || c === 'banned')).toBe(true);
  });
});

describe('recent winner ideas', () => {
  const disclosedRubric = withFreshnessCriteria([
    { key: 'theme', label: 'Theme', criteria: 'On theme.', weight: 50 },
    { key: 'wordplay', label: 'Wordplay', criteria: 'A visual pun.', weight: 50 },
  ]);
  const ideasSent = () =>
    mockGenerateReview.mock.calls.map(
      ([args]) => (args as { recentWinnerIdeas?: string[] }).recentWinnerIdeas
    );

  beforeEach(async () => {
    await setBanned(null);
    await db.query(
      `UPDATE "Image" SET "nsfwLevel" = 1, "modelRestricted" = false, ingestion = 'Scanned'`
    );
    winnerQueries.length = 0;
  });
  afterEach(() => {
    challengeRecordOverrides = {};
  });

  it('reach the judge on an SFW System daily whose rubric discloses them, from SFW winners only', async () => {
    challengeRecordOverrides = { judgingCategories: disclosedRubric };
    await reviewedImageIds();

    expect(ideasSent().length).toBeGreaterThan(0);
    expect(ideasSent().every((ideas) => ideas?.[0] === 'a past winning idea')).toBe(true);
    expect(winnerQueries).toHaveLength(1);
    expect(winnerQueries[0]).toContain('"allowedNsfwLevel" <> 0');
  });

  it('read every System winner on a mature daily', async () => {
    challengeRecordOverrides = { judgingCategories: disclosedRubric, allowedNsfwLevel: 1 | 4 };
    await reviewedImageIds();

    expect(winnerQueries[0]).not.toContain('"allowedNsfwLevel" <> 0');
  });

  it.each([
    ['a user challenge', { judgingCategories: disclosedRubric, source: ChallengeSource.User }],
    [
      'a rubric that does not disclose them',
      { judgingCategories: disclosedRubric.map((c) => ({ ...c, criteria: 'x' })) },
    ],
    ['no rubric', {}],
  ])('never reach the judge for %s', async (_, overrides) => {
    challengeRecordOverrides = overrides;
    await reviewedImageIds();

    expect(ideasSent().length).toBeGreaterThan(0);
    expect(ideasSent().every((ideas) => ideas === undefined)).toBe(true);
    expect(winnerQueries).toHaveLength(0);
  });
});
