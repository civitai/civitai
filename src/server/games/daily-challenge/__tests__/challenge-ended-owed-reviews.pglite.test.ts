import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import {
  getEndedActiveChallengesFromDb,
  OWED_REVIEW_GRACE_HOURS,
} from '~/server/games/daily-challenge/challenge-helpers';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ChallengeStatus" AS ENUM ('Active', 'Completed');
    CREATE TABLE "Challenge" (
      id int PRIMARY KEY, status "ChallengeStatus", "endsAt" timestamp, metadata jsonb
    );
    INSERT INTO "Challenge" VALUES
      (1, 'Active', now() - interval '10 minutes', '{"reviewedAt": 1}'),
      (2, 'Active', now() - interval '10 minutes', '{"pendingReview": {}}'),
      (3, 'Active', now() - interval '10 minutes', '{"pendingReview": {"7": 0}}'),
      (4, 'Active', now() - interval '${OWED_REVIEW_GRACE_HOURS} hours 1 minute',
        '{"pendingReview": {"7": 0}}'),
      (5, 'Active', now() + interval '1 hour', NULL);
  `);
});
afterAll(() => db.close());

it('holds an ended challenge back while it owes reviews, until the grace period runs out', async () => {
  // The first read selects the ids; the hydration read after it is not what this test is about.
  const selected: number[] = [];
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementationOnce((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    const { rows } = await db.query<{ id: number }>(sql.text, sql.values as unknown[]);
    selected.push(...rows.map((r) => r.id));
    return rows;
  }) as never);

  await getEndedActiveChallengesFromDb();

  expect(selected).toEqual([4, 1, 2]);
});
