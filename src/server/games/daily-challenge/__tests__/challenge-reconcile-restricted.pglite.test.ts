import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ChallengeHelpers from '~/server/games/daily-challenge/challenge-helpers';
import type * as DailyChallengeUtils from '~/server/games/daily-challenge/daily-challenge.utils';
import '~/__tests__/mocks/logging.mock';

// Reconciling a completed challenge back-pays entrants whose late REVIEW entries crossed the
// participation threshold. An entry restricted by its base model counts toward neither the
// pre-run snapshot nor the payout. Runs the real reconcile queries against PGlite.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { mockCreateBuzzTransactionMany } = vi.hoisted(() => ({
  mockCreateBuzzTransactionMany: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: mockCreateBuzzTransactionMany,
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/games/daily-challenge/challenge-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof ChallengeHelpers>()),
  getChallengeById: vi.fn().mockResolvedValue({ allowedNsfwLevel: 31, judgeId: 1, metadata: {} }),
}));
vi.mock('~/server/games/daily-challenge/daily-challenge.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof DailyChallengeUtils>()),
  getJudgingConfig: vi.fn().mockResolvedValue({ judgeId: 1, userId: 999, prompts: {} }),
}));

const { reconcileCompletedChallenge } = await import(
  '~/server/games/daily-challenge/challenge-rewards'
);

const RESTRICTED_ONLY = 10;
const CONTROL = 20;
const MIXED = 30;
const R = 4;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "CollectionItemStatus" AS ENUM ('ACCEPTED', 'REVIEW', 'REJECTED');
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int, "nsfwLevel" int NOT NULL,
      "modelRestricted" boolean NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now()
    );
    CREATE TABLE "CollectionItem" (
      "collectionId" int, "imageId" int, status "CollectionItemStatus",
      "reviewedAt" timestamp, "reviewedById" int
    );
    CREATE TABLE "ChallengeWinner" ("challengeId" int, "userId" int);
    INSERT INTO "User" VALUES (${RESTRICTED_ONLY}, NULL), (${CONTROL}, NULL), (${MIXED}, NULL);
    INSERT INTO "Image" (id, "userId", "nsfwLevel", "modelRestricted") VALUES
      -- Accepted before their base model was restricted: enough to meet the threshold if counted.
      (1, ${RESTRICTED_ONLY}, ${R}, true), (2, ${RESTRICTED_ONLY}, ${R}, true),
      (3, ${CONTROL}, ${R}, false), (4, ${CONTROL}, ${R}, false),
      (5, ${MIXED}, ${R}, true), (6, ${MIXED}, ${R}, false), (7, ${MIXED}, ${R}, false);
    INSERT INTO "CollectionItem" ("collectionId", "imageId", status) VALUES
      (100, 1, 'ACCEPTED'), (100, 2, 'ACCEPTED'),
      (100, 3, 'ACCEPTED'), (100, 4, 'REVIEW'),
      (100, 5, 'ACCEPTED'), (100, 6, 'ACCEPTED'), (100, 7, 'REVIEW');
  `);
  const run = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    const result = await db.query(sql.text, sql.values as unknown[]);
    return result.rows;
  }) as never;
  const exec = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    return (await db.query(sql.text, sql.values as unknown[])).affectedRows ?? 0;
  }) as never;
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation(run);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(run);
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(exec);
  mockCreateBuzzTransactionMany.mockResolvedValue({ transactions: [], conflicts: [] });
});
afterAll(() => db.close());

it('neither snapshots nor pays restricted entries; an unrestricted late crosser is paid', async () => {
  const result = await reconcileCompletedChallenge(
    {
      challengeId: 1,
      collectionId: 100,
      modelVersionIds: [],
      date: new Date(0),
      title: 't',
      entryPrize: { buzz: 50, points: 0 },
      // Two ACCEPTED entries earn the participation prize.
      entryPrizeRequirement: 2,
    } as never,
    { defaultJudgeId: 1 } as never
  );

  const paidTo = mockCreateBuzzTransactionMany.mock.calls
    .flatMap(([txs]) => txs as { toAccountId: number }[])
    .map((t) => t.toAccountId)
    .sort();
  // RESTRICTED_ONLY has two ACCEPTED entries but both are restricted: not paid.
  // MIXED had two ACCEPTED before this run, one restricted, so it was not already at threshold
  // (pre-eligible) and is paid once its REVIEW entry is promoted, like CONTROL.
  expect(paidTo).toEqual([CONTROL, MIXED]);
  expect(result).toEqual({ promoted: 2, paid: 2, buzzGranted: 100 });
});
