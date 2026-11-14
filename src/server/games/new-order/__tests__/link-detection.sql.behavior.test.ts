import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: vi.fn() } }));
vi.mock('~/server/games/new-order/utils', () => ({ getVotingRateLimitConfig: vi.fn() }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import type { LinkDetectionConfig } from '~/server/games/new-order/link-detection';
import { loadV2Earners } from '~/server/games/new-order/link-detection.service';

// Runs the v2 earner query against real Postgres.
vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const config = { lookbackDays: 7, maxEarners: 100 } as LinkDetectionConfig;

const SETUP = `
CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp);
CREATE TABLE "KnightsVote" ("playerId" int, gold int, "createdAt" timestamptz DEFAULT now());
CREATE TABLE "KnightsAcolyteLevelGold" ("playerId" int, level int, gold int, "createdAt" timestamptz DEFAULT now());
CREATE TABLE "KnightsPlayerDay" ("playerId" int, day date, "bonusGold" int DEFAULT 0);
INSERT INTO "User"(id, "bannedAt") VALUES (1, NULL), (2, NULL), (3, NULL), (4, NULL), (5, NULL), (6, NULL), (7, now()), (8, NULL), (9, NULL);

-- 1: votes only, 30 gold. 2: acolyte level gold only, 50. 3: watch bonus only, 40.
-- 4: a zero-gold vote and a vote outside the window, so not an earner.
-- 5: 10 + 15 + 20 = 45 across all three sources. 6: 5 gold only.
-- 7: banned, 1000 gold. 8: bonus gold older than the window. 9: nothing.
INSERT INTO "KnightsVote"("playerId", gold, "createdAt") VALUES
  (1, 10, now()), (1, 20, now() - interval '3 days'),
  (4, 0, now()), (4, 500, now() - interval '30 days'),
  (5, 10, now()), (6, 5, now()), (7, 1000, now());
INSERT INTO "KnightsAcolyteLevelGold"("playerId", level, gold, "createdAt") VALUES
  (2, 2, 50, now()), (5, 2, 15, now()), (2, 3, 500, now() - interval '30 days');
INSERT INTO "KnightsPlayerDay"("playerId", day, "bonusGold") VALUES
  (3, current_date, 40), (5, current_date - 2, 20), (8, current_date - 30, 99), (9, current_date, 0);
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

describe('loadV2Earners query', () => {
  it('ranks earners by total gold across votes, acolyte levels and watch bonus', async () => {
    expect(await loadV2Earners(config)).toEqual([2, 5, 3, 1, 6]);
  });

  it('leaves out zero-gold votes, votes outside the window and banned players', async () => {
    const ids = await loadV2Earners(config);

    expect(ids).not.toContain(4);
    expect(ids).not.toContain(7);
    expect(ids).not.toContain(8);
    expect(ids).not.toContain(9);
  });

  it('counts a longer window only when it reaches the older gold', async () => {
    expect(await loadV2Earners({ ...config, lookbackDays: 60 })).toEqual([2, 4, 8, 5, 3, 1, 6]);
  });

  it('keeps the highest earners when maxEarners is smaller than the candidates', async () => {
    expect(await loadV2Earners({ ...config, maxEarners: 2 })).toEqual([2, 5]);
  });
});
