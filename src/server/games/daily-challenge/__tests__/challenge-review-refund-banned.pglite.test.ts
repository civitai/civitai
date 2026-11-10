import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

// A banned entrant's paid review is skipped while the ban stands; at completion it is refunded.

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

const { refundBannedEntrantReviews } = await import(
  '~/server/games/daily-challenge/challenge-rewards'
);

const REVIEW_ME_TAG = 12;
const JUDGED_TAG = 11;
const CLEAN = 10;
const BANNED = 20;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp);
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int);
    CREATE TABLE "CollectionItem" (
      "collectionId" int, "imageId" int, "tagId" int, note text, status text
    );
    INSERT INTO "User" VALUES (${CLEAN}, NULL), (${BANNED}, now());
    INSERT INTO "Image" VALUES
      (1, ${BANNED}), (2, ${BANNED}), (3, ${BANNED}), (4, ${CLEAN}), (5, ${BANNED});
    INSERT INTO "CollectionItem" VALUES
      -- Paid per entry, still waiting: the one refund.
      (100, 1, ${REVIEW_ME_TAG}, 'challenge-review-1-1', 'ACCEPTED'),
      -- Flat-rate purchase: not refunded per entry.
      (100, 2, ${REVIEW_ME_TAG}, 'challenge-review-flat-1-2', 'ACCEPTED'),
      -- Already reviewed before the ban: delivered.
      (100, 3, ${JUDGED_TAG}, '{"score":{}}', 'ACCEPTED'),
      -- A clean entrant's paid entry still gets its review.
      (100, 4, ${REVIEW_ME_TAG}, 'challenge-review-1-4', 'ACCEPTED'),
      -- Another challenge's collection.
      (200, 5, ${REVIEW_ME_TAG}, 'challenge-review-2-5', 'ACCEPTED');
  `);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    const { rows } = await db.query(sql.text, sql.values as unknown[]);
    return rows;
  }) as never);
});
afterAll(() => db.close());

beforeEach(() => {
  mockCreateBuzzTransactionMany.mockReset();
  mockCreateBuzzTransactionMany.mockResolvedValue({ transactions: [], conflicts: [] });
  dbMock.dbWrite.challenge.findUnique.mockResolvedValue({ reviewCost: 25 } as never);
});

const refund = () =>
  refundBannedEntrantReviews({ challengeId: 1, collectionId: 100, reviewMeTagId: REVIEW_ME_TAG });

const refundKeys = () =>
  mockCreateBuzzTransactionMany.mock.calls.flatMap(([txs]) =>
    (txs as { externalTransactionId: string }[]).map((tx) => tx.externalTransactionId)
  );

it("refunds a banned entrant's paid review that is still waiting at completion", async () => {
  expect(await refund()).toEqual([1]);
  expect(mockCreateBuzzTransactionMany).toHaveBeenCalledWith([
    expect.objectContaining({
      fromAccountId: 0,
      toAccountId: BANNED,
      amount: 25,
      externalTransactionId: 'challenge-review-refund-1-1',
    }),
  ]);
});

it('re-runs under the same transaction id, so the ledger records the refund once', async () => {
  await refund();
  await refund();
  // Same key as the rejected-entry refund: the Buzz ledger dedupes on it.
  expect(refundKeys()).toEqual(['challenge-review-refund-1-1', 'challenge-review-refund-1-1']);
});
