import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import type { Kysely } from 'kysely';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_STAGE_RANKS } from '@civitai/shared/new-order';
import { createQueueDb } from '../../test/pglite-kysely';
import { seedGradedVotes, seedPlayer } from '../../test/seed';
import { queryBoard } from './leaderboard';
import { ensureVotePartitions } from './queue/queue.service';

// The main site's /leaderboard/knights-new-order board is a stored query on its "Leaderboard" row, run by the main
// app's prepare-leaderboard job. This pins that the migration makes it score what this app's own board scores.
const MIGRATION = readFileSync(
  path.resolve(
    __dirname,
    '../../../../../packages/civitai-db-schema/prisma/migrations/20271209120000_knights_new_order_site_board_v2/migration.sql'
  ),
  'utf8'
);

const V1_QUERY = `WITH clickhouse_data AS (
  SELECT userId, countIf(status = 'Correct') AS correctJudgments, count() AS allJudgments
  FROM knights_new_order_image_rating FINAL
  WHERE createdAt > subtractDays(now(), 7) AND status IN ('Correct', 'Failed', 'Inconclusive')
  GROUP BY userId
)
SELECT userId, FLOOR(correctJudgments * 100 * greatest(correctJudgments / allJudgments, 0.1)) AS score,
  toJSONString(map('correctJudgments', correctJudgments, 'allJudgments', allJudgments)) AS metrics
FROM clickhouse_data LIMIT 100`;
const V1_DESCRIPTION =
  'FLOOR(correctJudgments * 100 * greatest(correctJudgments / allJudgments, 0.1))\n---\nLast 7 days';

const DAY_MS = 86_400_000;
const sqlTime = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '');

let pg: PGlite;
let db: Kysely<DB>;
let now: Date;
const daysAgo = (n: number) => sqlTime(new Date(now.getTime() - n * DAY_MS));

async function member(
  userId: number,
  rankType: string,
  correct: number,
  {
    failed = 0,
    at,
    banned = false,
    startAt,
  }: { failed?: number; at?: string; banned?: boolean; startAt?: string } = {}
) {
  await pg.query(`INSERT INTO "User" ("id","username","bannedAt") VALUES ($1,$2,$3)`, [
    userId,
    `user${userId}`,
    banned ? new Date() : null,
  ]);
  await seedPlayer(pg, userId, rankType, { startAt });
  await seedGradedVotes(pg, userId, { correct, failed, at: at ?? daysAgo(1) });
}

const boardRow = async () =>
  (
    await pg.query<{ query: string; scoringDescription: string }>(
      `SELECT query, "scoringDescription" FROM "Leaderboard" WHERE id = 'knights-new-order'`
    )
  ).rows[0];

/** The stored query as prepare-leaderboard's defaultLeadboardPopulation wraps it, banned and deleted accounts out. */
async function siteBoard() {
  const { query } = await boardRow();
  expect(query.includes('WITH ')).toBe(false);
  expect(query.includes('clickhouse_')).toBe(false);
  const { rows } = await pg.query<{
    userId: number;
    score: number;
    metrics: { correctJudgments: number; allJudgments: number };
  }>(`WITH scores AS (${query})
    SELECT s."userId", ROUND(s.score)::int AS score, s.metrics
    FROM scores s JOIN "User" u ON u.id = s."userId"
    WHERE u."deletedAt" IS NULL AND u."bannedAt" IS NULL
    ORDER BY score DESC, s."userId"`);
  return rows;
}

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  now = new Date();
  await ensureVotePartitions(db, { now: new Date(now.getTime() - 40 * DAY_MS), monthsAhead: 3 });
  await pg.exec(
    `CREATE TABLE "Leaderboard" (id text PRIMARY KEY, query text NOT NULL, "scoringDescription" text)`
  );
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsVote","NewOrderPlayer","User" RESTART IDENTITY CASCADE; DELETE FROM "Leaderboard";`
  );
  await pg.query(`INSERT INTO "Leaderboard" VALUES ('knights-new-order', $1, $2)`, [
    V1_QUERY,
    V1_DESCRIPTION,
  ]);
});

describe('knights-new-order site board migration', () => {
  it('scores the same players and fervor as the Knights app board, accuracy counted twice', async () => {
    await member(1, 'Knight', 9);
    await member(2, 'Paladin', 40, { failed: 10 });
    await member(3, 'Templar', 7, { failed: 3 });
    // Below the 10% accuracy floor: fervor = correct.
    await member(4, 'Knight', 2, { failed: 30 });
    // 1/3 accuracy: an exact integer floor (100 / 9 = 11.1...), where a float product can land a point short.
    await member(5, 'Knight', 1, { failed: 2 });
    await member(6, 'Acolyte', 50);
    await member(7, 'Knight', 0, { failed: 4 });
    await member(8, 'Knight', 30, { at: daysAgo(8) });
    await member(9, 'Knight', 30, { startAt: daysAgo(0.5) });
    await member(10, 'Knight', 30, { banned: true });
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","verdict","settledAt","xp","gold")
       SELECT 5000000 + n * 10 + k, 1, $1::timestamp, 'knights.image.nsfwLevel', 0, 'Knight', '4', 1, v, s, 0, 0
       FROM generate_series(1, 3) n,
         (VALUES (1, 'correct', NULL::timestamp), (2, 'pending', NULL), (3, 'inconclusive', $1::timestamp)) AS x(k, v, s)`,
      [daysAgo(1)]
    );

    await pg.exec(MIGRATION);
    const site = await siteBoard();
    const app = (await queryBoard(db, now)).rows;

    expect(site.map((r) => [r.userId, r.score])).toEqual(app.map((r) => [r.userId, r.fervor]));
    expect(site.map((r) => [r.userId, r.score])).toEqual([
      [2, 2560],
      [1, 900],
      [3, 343],
      [5, 11],
      [4, 2],
    ]);
    expect(site.find((r) => r.userId === 2)?.metrics).toEqual({
      correctJudgments: 40,
      allJudgments: 50,
    });
  });

  it('limits the board to the Knights app ranks', async () => {
    await pg.exec(MIGRATION);
    const { query } = await boardRow();
    const ranks = query.match(/"rankType" IN \(([^)]*)\)/)?.[1];
    expect(ranks?.split(',').map((r) => r.trim().replace(/'/g, ''))).toEqual([
      ...KNIGHTS_STAGE_RANKS,
    ]);
  });

  it('replaces the pop-up formula and keeps the window line once', async () => {
    await pg.exec(MIGRATION);
    const { scoringDescription } = await boardRow();

    expect(scoringDescription).not.toContain('greatest(');
    expect(scoringDescription).toContain('accuracy × accuracy');
    expect(scoringDescription.split('Last 7 days')).toHaveLength(2);
    expect(scoringDescription.endsWith('---\nLast 7 days')).toBe(true);
  });

  it('is idempotent: a re-run leaves the new query as it is', async () => {
    await pg.exec(MIGRATION);
    const first = await boardRow();
    await pg.exec(MIGRATION);
    expect(await boardRow()).toEqual(first);
  });

  it('refuses, changing nothing, when the live query is not the original game one', async () => {
    await pg.exec(`UPDATE "Leaderboard" SET query = 'SELECT 1' WHERE id = 'knights-new-order'`);
    await expect(pg.exec(MIGRATION)).rejects.toThrow(
      /does not read knights_new_order_image_rating/
    );
    await pg.exec('ROLLBACK').catch(() => undefined);
    expect(await boardRow()).toEqual({ query: 'SELECT 1', scoringDescription: V1_DESCRIPTION });
  });
});
