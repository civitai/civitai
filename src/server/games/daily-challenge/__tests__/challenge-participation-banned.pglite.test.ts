import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

// Participation Buzz is paid straight to the account, not held like a winner prize, so a banned
// entrant must be left out of the earner query itself.

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

const { distributeParticipationPrizes } = await import(
  '~/server/games/daily-challenge/challenge-rewards'
);

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp);
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int);
    CREATE TABLE "CollectionItem" ("collectionId" int, "imageId" int, status text);
    INSERT INTO "User" VALUES (10, NULL), (20, NULL);
    INSERT INTO "Image" VALUES (1, 10), (2, 20);
    INSERT INTO "CollectionItem" VALUES (100, 1, 'ACCEPTED'), (100, 2, 'ACCEPTED');
  `);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    const { rows } = await db.query(sql.text, sql.values as unknown[]);
    return rows;
  }) as never);
  mockCreateBuzzTransactionMany.mockResolvedValue({ transactions: [], conflicts: [] });
});
afterAll(() => db.close());

const pay = () =>
  distributeParticipationPrizes({
    challengeId: 1,
    collectionId: 100,
    title: 't',
    entryPrize: { buzz: 50, points: 0 },
    entryPrizeRequirement: 1,
    excludeUserIds: [],
    notificationKey: 'k',
  });

it('pays participation Buzz to every earner except a banned one', async () => {
  expect((await pay()).sort()).toEqual([10, 20]);

  await db.query(`UPDATE "User" SET "bannedAt" = now() WHERE id = 20`);
  expect(await pay()).toEqual([10]);
});
