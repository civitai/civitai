import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../test/pglite-kysely';
import { seedGradedVotes, seedPlayer } from '../../test/seed';
import { queryBoard, viewBoard } from './leaderboard';
import { calculateFervor } from './progression/fervor';
import { expForLevel } from './progression/levels';
import { ensureVotePartitions } from './queue/queue.service';

const NOW = new Date('2026-12-15T12:00:00Z');
const RECENT = '2026-12-14 00:00:00';

let pg: PGlite;
let db: Kysely<DB>;

async function member(
  userId: number,
  rankType: string,
  correct: number,
  {
    failed = 0,
    level = 1,
    banned = false,
    deleted = false,
    at = RECENT,
  }: { failed?: number; level?: number; banned?: boolean; deleted?: boolean; at?: string } = {}
) {
  await pg.query(
    `INSERT INTO "User" ("id","username","image","bannedAt","deletedAt") VALUES ($1,$2,$3,$4,$5)`,
    [
      userId,
      `user${userId}`,
      `img-${userId}`,
      banned ? new Date() : null,
      deleted ? new Date() : null,
    ]
  );
  await seedPlayer(pg, userId, rankType);
  await pg.query(`UPDATE "NewOrderPlayer" SET "exp"=$2 WHERE "userId"=$1`, [
    userId,
    expForLevel(level),
  ]);
  await seedGradedVotes(pg, userId, { correct, failed, at });
}

const ids = async (now = NOW) => (await queryBoard(db, now)).rows.map((row) => row.userId);

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsVote","NewOrderPlayer","User","Image","Post","UserCosmetic","Cosmetic" RESTART IDENTITY CASCADE`
  );
});

describe('queryBoard', () => {
  it('orders by fervor from the votes cast in the window, with rank, level and fervor', async () => {
    await member(1, 'Knight', 1, { level: 3 });
    await member(2, 'Paladin', 9, { level: 45 });
    await member(3, 'Templar', 4, { level: 25, failed: 4 });

    const { rows } = await queryBoard(db, NOW);

    expect(rows.map((r) => [r.userId, r.rankType, r.level, r.fervor])).toEqual([
      [2, 'Paladin', 45, calculateFervor({ correct: 9, graded: 9 })],
      [3, 'Templar', 25, calculateFervor({ correct: 4, graded: 8 })],
      [1, 'Knight', 3, 100],
    ]);
    expect(rows[0]).toMatchObject({ username: 'user2', image: 'img-2' });
  });

  it('counts votes by when they were cast: a vote cast 8 days ago is out whenever it settled', async () => {
    await member(1, 'Knight', 3, { at: '2026-12-07 00:00:00' });
    await pg.exec(`UPDATE "KnightsVote" SET "settledAt"='2026-12-14 00:00:00'`);
    await member(2, 'Knight', 1);

    expect(await ids()).toEqual([2]);
  });

  it('drops a player once the window has passed them by, and does not read their stored fervor', async () => {
    await member(1, 'Knight', 2);
    await pg.exec(`UPDATE "NewOrderPlayer" SET "fervor"=99999`);

    expect(await ids()).toEqual([1]);
    expect(await ids(new Date('2026-12-30T00:00:00Z'))).toEqual([]);
  });

  it('leaves out Acolytes, Inquisitors and players with no correct vote', async () => {
    await member(1, 'Acolyte', 5);
    await member(2, 'Inquisitor', 5);
    await member(3, 'Knight', 0, { failed: 5 });
    await member(4, 'Knight', 1);

    expect(await ids()).toEqual([4]);
  });

  it('leaves out banned and deleted accounts', async () => {
    await member(1, 'Knight', 5, { banned: true });
    await member(2, 'Knight', 4, { deleted: true });
    await member(3, 'Knight', 3);

    expect(await ids()).toEqual([3]);
  });

  it('breaks a tie by the lower user id, the same way every time', async () => {
    await member(7, 'Knight', 2);
    await member(3, 'Knight', 2);
    await member(5, 'Knight', 2);

    expect(await ids()).toEqual([3, 5, 7]);
  });

  it('shows the profile picture at any rated level, but not unrated or Blocked', async () => {
    await member(1, 'Knight', 3);
    await member(2, 'Knight', 2);
    await member(3, 'Knight', 1);
    await member(4, 'Knight', 1);
    await member(5, 'Knight', 1);
    await pg.exec(
      `INSERT INTO "Image" ("id","url","nsfwLevel") VALUES (50,'pic-pg',1),(51,'pic-blocked',32),(52,'pic-x',8),(53,'pic-unrated',0)`
    );
    await pg.exec(`UPDATE "User" SET "profilePictureId"=50 WHERE "id"=1`);
    await pg.exec(`UPDATE "User" SET "profilePictureId"=51 WHERE "id"=2`);
    await pg.exec(`UPDATE "User" SET "profilePictureId"=52 WHERE "id"=3`);
    await pg.exec(`UPDATE "User" SET "image"=NULL WHERE "id"=4`);
    await pg.exec(`UPDATE "User" SET "profilePictureId"=53 WHERE "id"=5`);

    const { rows } = await queryBoard(db, NOW);

    expect(rows.map((r) => r.image)).toEqual(['pic-pg', 'img-2', 'pic-x', null, 'img-5']);
  });

  it('reads each rank badge cosmetic image from the Trophy cosmetics, and none for Paladin', async () => {
    await pg.exec(`INSERT INTO "Cosmetic" ("id","source","data") VALUES
      (859,'Trophy','{"url":"knight-key"}'),(860,'Purchase','{"url":"not-a-trophy"}')`);

    expect((await queryBoard(db, NOW)).badges).toEqual({ Knight: 'knight-key' });
  });

  it('is served by the (createdAt, playerId) index, and only the months of the window when sequential scans are off', async () => {
    await member(1, 'Knight', 2);
    await pg.exec('SET enable_seqscan = off');
    const plan = await pg.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT v."playerId", count(*) FROM "KnightsVote" v
       WHERE v."createdAt" >= '2026-12-08' AND v."settledAt" IS NOT NULL AND v."verdict" IN ('correct','failed')
       GROUP BY v."playerId"`
    );
    await pg.exec('RESET enable_seqscan');

    expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toMatch(
      /Index Scan on "KnightsVote_\d+_\d+_createdAt_playerId_verdict_idx"/
    );
  });
});

describe('viewBoard', () => {
  const board = (n: number) => ({
    rows: Array.from({ length: n }, (_, i) => ({
      userId: i + 1,
      username: `u${i + 1}`,
      image: null,
      rankType: 'Knight',
      level: 1,
      fervor: 1000 - i,
    })),
    badges: {},
  });

  it('cuts the list at the size and gives a viewer outside it their own position', () => {
    const view = viewBoard(board(7), 6, { size: 3 });

    expect(view.entries.map((e) => e.userId)).toEqual([1, 2, 3]);
    expect(view.self).toMatchObject({ userId: 6, position: 6 });
  });

  it('gives a viewer inside the list their position, and no self to one who is not on the board', () => {
    expect(viewBoard(board(7), 2, { size: 3 }).self).toMatchObject({ position: 2 });
    expect(viewBoard(board(7), 99).self).toBeNull();
    expect(viewBoard(board(7), null).self).toBeNull();
  });
});
