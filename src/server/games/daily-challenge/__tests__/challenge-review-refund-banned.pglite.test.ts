import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

// A banned entrant's paid review is skipped while the ban stands; at completion it is refunded.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { mockCreateBuzzTransactionMany, mockGetTransactionByExternalId, mockBust } = vi.hoisted(
  () => ({
    mockCreateBuzzTransactionMany: vi.fn(),
    mockGetTransactionByExternalId: vi.fn(),
    mockBust: vi.fn(),
  })
);
vi.mock('~/server/services/contest-collection-items.cache', () => ({
  bustContestCollectionItemsCache: mockBust,
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: mockCreateBuzzTransactionMany,
  getTransactionByExternalId: mockGetTransactionByExternalId,
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

const { refundBannedEntrantReviews } = await import(
  '~/server/games/daily-challenge/challenge-rewards'
);

const REVIEW_ME_TAG = 12;
const JUDGED_TAG = 11;
const CLEAN = 10;
const BANNED = 20;
const PAID = 25;

let db: PGlite | undefined;

async function seed() {
  await db?.close();
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp);
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int);
    CREATE TABLE "CollectionItem" (
      "collectionId" int, "imageId" int, "tagId" int, note text, status text
    );
    INSERT INTO "User" VALUES (${CLEAN}, NULL), (${BANNED}, now());
    INSERT INTO "Image" SELECT n, CASE WHEN n = 4 THEN ${CLEAN} ELSE ${BANNED} END
      FROM generate_series(1, 9) n;
    INSERT INTO "CollectionItem" VALUES
      -- Paid per entry, still waiting: the one refund.
      (100, 1, ${REVIEW_ME_TAG}, 'challenge-review-1-1', 'ACCEPTED'),
      -- Flat-rate purchase: not refunded per entry.
      (100, 2, ${REVIEW_ME_TAG}, 'challenge-review-flat-1-2', 'ACCEPTED'),
      -- Already reviewed before the ban: delivered.
      (100, 3, ${JUDGED_TAG}, '{"score":{}}', 'ACCEPTED'),
      -- A clean entrant's paid entry still gets its review.
      (100, 4, ${REVIEW_ME_TAG}, 'challenge-review-1-4', 'ACCEPTED'),
      -- Another collection.
      (200, 5, ${REVIEW_ME_TAG}, 'challenge-review-1-5', 'ACCEPTED'),
      -- Rejected: the rejected-entry refund handles it.
      (100, 6, ${REVIEW_ME_TAG}, 'challenge-review-1-6', 'REJECTED'),
      -- Tagged and noted, but no purchase on the ledger.
      (100, 7, ${REVIEW_ME_TAG}, 'challenge-review-1-7', 'ACCEPTED'),
      -- Paid, still awaiting its scan: refunded too.
      (100, 8, ${REVIEW_ME_TAG}, 'challenge-review-1-8', 'REVIEW'),
      -- Its purchase on the ledger was paid by someone else.
      (100, 9, ${REVIEW_ME_TAG}, 'challenge-review-1-9', 'ACCEPTED');
  `);
}
afterAll(() => db?.close());

async function runOnPglite(strings: TemplateStringsArray, ...values: unknown[]) {
  const sql = Prisma.sql(strings, ...(values as never[]));
  const result = await db!.query(sql.text, sql.values as unknown[]);
  return result;
}

beforeEach(async () => {
  await seed();
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(
    (async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await runOnPglite(strings, ...values)).rows) as never
  );
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(
    (async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await runOnPglite(strings, ...values)).affectedRows ?? 0) as never
  );
  mockCreateBuzzTransactionMany.mockReset();
  mockCreateBuzzTransactionMany.mockResolvedValue({ transactions: [], conflicts: [] });
  // The ledger holds the entrant's purchase for every entry except 7 (none) and 9 (another payer).
  mockGetTransactionByExternalId.mockReset();
  mockGetTransactionByExternalId.mockImplementation(async (externalId: string) =>
    externalId === 'challenge-review-1-7'
      ? null
      : {
          fromAccountId: externalId.endsWith('-4')
            ? CLEAN
            : externalId.endsWith('-9')
            ? 99
            : BANNED,
          toAccountId: 0,
          amount: PAID,
          externalTransactionId: externalId,
        }
  );
});

const refund = () =>
  refundBannedEntrantReviews({ challengeId: 1, collectionId: 100, reviewMeTagId: REVIEW_ME_TAG });

const refundedEntries = () =>
  mockCreateBuzzTransactionMany.mock.calls.flatMap(([txs]) =>
    (txs as { externalTransactionId: string }[]).map((tx) => tx.externalTransactionId)
  );

it("refunds a banned entrant's waiting paid review, for what the purchase cost", async () => {
  expect(await refund()).toEqual([1, 8]);
  expect(mockCreateBuzzTransactionMany).toHaveBeenCalledWith(
    [1, 8].map((imageId) =>
      expect.objectContaining({
        fromAccountId: 0,
        toAccountId: BANNED,
        amount: PAID,
        externalTransactionId: `challenge-review-refund-1-${imageId}`,
      })
    )
  );
});

it('refunds nothing more on a second completion pass', async () => {
  expect(await refund()).toEqual([1, 8]);
  expect(await refund()).toEqual([]);
  expect(refundedEntries()).toEqual(['challenge-review-refund-1-1', 'challenge-review-refund-1-8']);
});

it('takes a refunded entry out of the paid-review queue, so a lifted ban cannot review it', async () => {
  await refund();
  const { rows } = await db!.query<{ imageId: number }>(
    `SELECT "imageId" FROM "CollectionItem" WHERE "tagId" = ${REVIEW_ME_TAG} ORDER BY 1`
  );
  expect(rows.map((r) => r.imageId)).toEqual([2, 4, 5, 6, 7, 9]);
  expect(mockBust).toHaveBeenCalledWith([1, 8]);
});
