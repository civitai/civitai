import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbReadLong: {}, pgDbWrite: {} }));
vi.mock('~/server/jobs/apply-discord-roles', () => ({ applyDiscordLeaderboardRoles: vi.fn() }));
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: (e: unknown) => Promise<unknown>) => ({
    name,
    cron,
    run: () => fn({ on: vi.fn() }),
  }),
  getJobDate: vi.fn(async () => [new Date(0), vi.fn()]),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import { leaderboardJobs } from '../prepare-leaderboard';

/**
 * UserRank backs the profile rank badge. It is rebuilt from the day's LeaderboardResult rows;
 * on 2026-11-12 the one nightly rebuild missed, and every badge showed 11-11's rank all day
 * while the board list showed 11-12's. These run the real job and the real rebuild SQL.
 */
const SCHEMA = `
  CREATE TABLE "User" (id int PRIMARY KEY, "leaderboardShowcase" text);
  CREATE TABLE "Leaderboard" (id text PRIMARY KEY, title text, query text, active boolean, public boolean);
  CREATE TABLE "LeaderboardResult" (
    "leaderboardId" text, date date, "userId" int, position int, score int DEFAULT 0
  );
  CREATE TABLE "Cosmetic" (id serial PRIMARY KEY, "leaderboardId" text, "leaderboardPosition" int, data jsonb);
  CREATE TABLE "UserRank" (
    "userId" int PRIMARY KEY, "leaderboardRank" int, "leaderboardId" text,
    "leaderboardTitle" text, "leaderboardCosmetic" text
  );
  CREATE TABLE "KeyValue" (key text PRIMARY KEY, value jsonb);
`;

const A_USER = 1; // ranks on board-a: 5 yesterday, 4 today
const B_USER = 2; // ranks on board-b: 7 yesterday, 6 today

let harness: Awaited<ReturnType<typeof startPglitePrisma>>;
const q = (sql: string) => harness.pg.exec(sql);
const job = leaderboardJobs.find((j) => j.name === 'update-user-leaderboard-rank')!;

const rankOf = async (userId: number) => {
  const { rows } = await harness.pg.query<{ leaderboardRank: number }>(
    `SELECT "leaderboardRank" FROM "UserRank" WHERE "userId" = $1`,
    [userId]
  );
  return rows[0]?.leaderboardRank ?? null;
};

/** Board-b without today's rows or marker, as when its population failed. */
const unpopulateB = () =>
  q(`DELETE FROM "LeaderboardResult" WHERE "leaderboardId" = 'board-b' AND date = current_date;
     UPDATE "KeyValue" SET value = to_jsonb((current_date - 1)::text) WHERE key = 'leaderboard:populated:board-b';`);

beforeAll(async () => {
  harness = await startPglitePrisma(SCHEMA);
});
afterAll(async () => {
  await harness?.stop();
});

beforeEach(async () => {
  await q(`
    TRUNCATE "User", "Leaderboard", "LeaderboardResult", "Cosmetic", "UserRank", "KeyValue";
    INSERT INTO "User" (id) VALUES (${A_USER}), (${B_USER});
    INSERT INTO "Leaderboard" VALUES
      ('board-a', 'Board A', 'SELECT 1', true, true),
      ('board-b', 'Board B', 'SELECT 1', true, true);
    INSERT INTO "LeaderboardResult" ("leaderboardId", date, "userId", position) VALUES
      ('board-a', current_date - 1, ${A_USER}, 5), ('board-a', current_date, ${A_USER}, 4),
      ('board-b', current_date - 1, ${B_USER}, 7), ('board-b', current_date, ${B_USER}, 6);
    INSERT INTO "KeyValue" VALUES
      ('leaderboard:populated:board-a', to_jsonb(current_date::text)),
      ('leaderboard:populated:board-b', to_jsonb(current_date::text));
    -- Yesterday's snapshot, as left by the last successful rebuild.
    INSERT INTO "UserRank" ("userId", "leaderboardRank", "leaderboardId", "leaderboardTitle") VALUES
      (${A_USER}, 5, 'board-a', 'Board A'), (${B_USER}, 7, 'board-b', 'Board B');
  `);

  const write = dbMock.dbWrite as unknown as Record<string, ReturnType<typeof vi.fn>>;
  const prisma = harness.prisma as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const method of ['$queryRaw', '$executeRaw', '$transaction'])
    write[method].mockImplementation((...args: unknown[]) => prisma[method](...args));
});

describe('update-user-leaderboard-rank', () => {
  it('rebuilds the other boards when one is not populated, carrying its previous day', async () => {
    await unpopulateB();

    await job.run({});

    expect(await rankOf(A_USER)).toBe(4);
    expect(await rankOf(B_USER)).toBe(7);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'user-rank-partially-populated',
        error: { unpopulated: ['board-b'] },
      })
    );
  });

  it('retries a failed rebuild later the same day', async () => {
    // Hourly, not once a day: a missed run must get another chance before tomorrow.
    expect(job.cron.split(' ')[1]).toBe('*');

    const write = dbMock.dbWrite as unknown as Record<string, ReturnType<typeof vi.fn>>;
    write.$transaction.mockRejectedValueOnce(new Error('connection lost'));
    await expect(job.run({})).rejects.toThrow('connection lost');
    expect(await rankOf(A_USER)).toBe(5);

    await job.run({});
    expect(await rankOf(A_USER)).toBe(4);
  });

  it('does not rebuild again once today is built', async () => {
    await job.run({});
    expect(await rankOf(A_USER)).toBe(4);

    await q(`UPDATE "LeaderboardResult" SET position = 2
             WHERE "userId" = ${A_USER} AND date = current_date`);
    await job.run({});

    expect(await rankOf(A_USER)).toBe(4);
  });

  it('leaves a partial day unmarked, so a board that lands later is picked up', async () => {
    await unpopulateB();
    await job.run({});
    expect(await rankOf(B_USER)).toBe(7);

    await q(`INSERT INTO "LeaderboardResult" ("leaderboardId", date, "userId", position)
               VALUES ('board-b', current_date, ${B_USER}, 6);
             UPDATE "KeyValue" SET value = to_jsonb(current_date::text)
               WHERE key = 'leaderboard:populated:board-b';`);
    await job.run({});

    expect(await rankOf(B_USER)).toBe(6);
  });

  it('keeps the table when no board is populated', async () => {
    // No board has today's rows, and neither day's are there to carry: a rebuild would TRUNCATE
    // and insert nothing, blanking every badge.
    await q(`DELETE FROM "LeaderboardResult";
             UPDATE "KeyValue" SET value = to_jsonb((current_date - 1)::text);`);

    const outcome = await job.run({}).catch((e: Error) => e);

    expect(await rankOf(A_USER)).toBe(5);
    expect(await rankOf(B_USER)).toBe(7);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('Leaderboard not populated');
  });
});
