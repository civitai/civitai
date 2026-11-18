import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

// The add-time entry prize is paid straight to the account. A mature entry its base model restricts
// is visible only to its uploader, so it must not count toward the requirement.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { mockCreateBuzzTransaction } = vi.hoisted(() => ({
  mockCreateBuzzTransaction: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: mockCreateBuzzTransaction,
}));

const { checkAndAwardEntryPrize } = await import('~/server/games/daily-challenge/challenge-prize');

const COLLECTION = 100;
const CONTROL = 10;
const MIXED = 20;
const R = 4;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int, "nsfwLevel" int NOT NULL DEFAULT 1,
      "modelRestricted" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "CollectionItem" (
      "collectionId" int, "imageId" int, "addedById" int, status text
    );
    INSERT INTO "Image" VALUES
      (1, ${CONTROL}, 1, false), (2, ${CONTROL}, ${R}, false),
      (3, ${MIXED}, 1, false), (4, ${MIXED}, ${R}, true);
    INSERT INTO "CollectionItem" VALUES
      (${COLLECTION}, 1, ${CONTROL}, 'ACCEPTED'), (${COLLECTION}, 2, ${CONTROL}, 'ACCEPTED'),
      (${COLLECTION}, 3, ${MIXED}, 'ACCEPTED'), (${COLLECTION}, 4, ${MIXED}, 'ACCEPTED');
  `);
});
afterAll(() => db.close());

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateBuzzTransaction.mockResolvedValue({ transactionId: 't' });
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    if (strings.join('?').includes('FROM "Challenge"'))
      return [{ id: 1, entryPrize: { buzz: 50, points: 0 }, entryPrizeRequirement: 2, title: 't' }];
    const sql = Prisma.sql(strings, ...(values as never[]));
    const { rows } = await db.query(sql.text, sql.values as unknown[]);
    return rows;
  }) as never);
});

it('does not award a user whose second entry is a restricted mature image', async () => {
  expect(await checkAndAwardEntryPrize({ userId: MIXED, collectionId: COLLECTION })).toBe(false);
  expect(mockCreateBuzzTransaction).not.toHaveBeenCalled();
});

it('awards a user with two unrestricted entries, one of them R, exactly once', async () => {
  expect(await checkAndAwardEntryPrize({ userId: CONTROL, collectionId: COLLECTION })).toBe(true);
  expect(mockCreateBuzzTransaction).toHaveBeenCalledTimes(1);
  expect(mockCreateBuzzTransaction.mock.calls[0][0]).toMatchObject({
    toAccountId: CONTROL,
    amount: 50,
  });
});
