import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loadV2AbuseSuspects } from '../v2-suspects';

// Runs the v2 suspect query against real Postgres.
vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const thresholds = {
  minTotalRatings: 20,
  havingDominantPct: 90,
  havingAvgPerMinute: 10,
  smiteMaxUniqueRatings: 1,
};

// Each player is `n` votes, one per `step` apart, ending `ago` before now.
const SETUP = `
CREATE TABLE "KnightsVote" ("playerId" int, "createdAt" timestamp, "questionKey" text, answer text);

-- 1: 28 of 30 votes are '1', spread over 30 minutes: dominant-answer spammer.
INSERT INTO "KnightsVote" SELECT 1, now() - interval '2 hours' + n * interval '1 minute', 'knights.image.nsfwLevel',
  CASE WHEN n < 28 THEN '1' ELSE '2' END FROM generate_series(0, 29) n;
-- 2: 25 votes all '4' spread over 25 minutes: a single distinct value.
INSERT INTO "KnightsVote" SELECT 2, now() - interval '3 hours' + n * interval '1 minute', 'knights.image.nsfwLevel', '4'
  FROM generate_series(0, 24) n;
-- 3: 40 votes over five answers evenly (20% each) inside two minutes: fast but varied.
INSERT INTO "KnightsVote" SELECT 3, now() - interval '1 hour' + n * interval '3 seconds', 'knights.image.nsfwLevel',
  ((ARRAY['1','2','4','8','16'])[1 + n % 5]) FROM generate_series(0, 39) n;
-- 4: honest: 30 votes over five answers, one a minute.
INSERT INTO "KnightsVote" SELECT 4, now() - interval '4 hours' + n * interval '1 minute', 'knights.image.nsfwLevel',
  ((ARRAY['1','2','4','8','16'])[1 + n % 5]) FROM generate_series(0, 29) n;
-- 5: only 10 votes, all '1' and fast: under the volume floor.
INSERT INTO "KnightsVote" SELECT 5, now() - interval '1 hour' + n * interval '1 second', 'knights.image.nsfwLevel', '1'
  FROM generate_series(0, 9) n;
-- 6: a spammer's votes, all 30 hours old: outside the window.
INSERT INTO "KnightsVote" SELECT 6, now() - interval '30 hours' + n * interval '1 minute', 'knights.image.nsfwLevel', '1'
  FROM generate_series(0, 29) n;
-- 7: a spammer on some other question.
INSERT INTO "KnightsVote" SELECT 7, now() - interval '2 hours' + n * interval '1 minute', 'knights.other.question', '1'
  FROM generate_series(0, 29) n;
`;

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SETUP);
  dbMock.dbRead.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values) => {
    const text = strings.reduce((sql, part, i) => sql + (i ? `$${i}` : '') + part, '');
    return (await pg.query(text, values)).rows;
  });
});

afterAll(async () => {
  await pg.close();
});

describe('loadV2AbuseSuspects query', () => {
  it('flags the dominant-answer spammer, the one-value rater and the fast rater, largest first', async () => {
    const suspects = await loadV2AbuseSuspects(thresholds);

    expect(suspects.map((s) => s.userId)).toEqual([3, 1, 2]);
  });

  it('reports the same signals the v1 scan does, as plain numbers', async () => {
    const byUser = new Map((await loadV2AbuseSuspects(thresholds)).map((s) => [s.userId, s]));

    expect(byUser.get(1)).toMatchObject({
      totalRatings: 30,
      uniqueRatings: 2,
      dominantRating: 1,
      source: 'v2',
    });
    expect(byUser.get(1)!.dominantPct).toBeCloseTo(93.33, 1);
    expect(byUser.get(2)).toMatchObject({ totalRatings: 25, uniqueRatings: 1, dominantRating: 4 });
    expect(byUser.get(2)!.dominantPct).toBe(100);
    expect(byUser.get(3)).toMatchObject({ totalRatings: 40, uniqueRatings: 5 });
    expect(byUser.get(3)!.dominantPct).toBeCloseTo(20, 5);
    expect(byUser.get(3)!.avgPerMinute).toBeGreaterThan(10);
    expect(typeof byUser.get(3)!.avgPerMinute).toBe('number');
  });

  it('leaves out an honest varied rater', async () => {
    expect((await loadV2AbuseSuspects(thresholds)).map((s) => s.userId)).not.toContain(4);
  });

  it('leaves out a player under minTotalRatings however fast or uniform', async () => {
    expect((await loadV2AbuseSuspects(thresholds)).map((s) => s.userId)).not.toContain(5);
  });

  it('ignores votes outside the window and on other questions', async () => {
    const ids = (await loadV2AbuseSuspects(thresholds)).map((s) => s.userId);

    expect(ids).not.toContain(6);
    expect(ids).not.toContain(7);
  });
});
