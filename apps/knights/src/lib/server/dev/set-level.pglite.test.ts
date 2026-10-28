import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { getLevelProgression } from '@civitai/shared/new-order-levels';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedGradedVotes, seedPlayer } from '../../../test/seed';
import { ensureVotePartitions } from '../queue/queue.service';
import { setPlayerLevel } from './set-level';

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: new Date('2026-12-15T12:00:00Z'), monthsAhead: 1 });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(`TRUNCATE "KnightsVote","NewOrderPlayer"`);
});

const row = async (userId: number) =>
  (
    await pg.query<{ rankType: string; exp: number }>(
      `SELECT "rankType","exp" FROM "NewOrderPlayer" WHERE "userId"=$1`,
      [userId]
    )
  ).rows[0];

describe('setPlayerLevel', () => {
  it('moves the player to the first XP of that level', async () => {
    await seedPlayer(pg, 1);
    const result = await setPlayerLevel(db, 1, 30);

    expect(result).toMatchObject({ ok: true });
    expect(getLevelProgression((await row(1)).exp)).toMatchObject({ level: 30, xpIntoLevel: 0 });
  });

  it('applies the rank-up the new level and the recorded accuracy earn', async () => {
    await seedPlayer(pg, 1);
    await seedGradedVotes(pg, 1, { correct: 60 });

    expect(await setPlayerLevel(db, 1, 45)).toMatchObject({ ok: true, rank: 'Paladin' });
    expect((await row(1)).rankType).toBe('Paladin');
  });

  it('leaves the rank alone without the accuracy', async () => {
    await seedPlayer(pg, 1);
    await setPlayerLevel(db, 1, 45);
    expect((await row(1)).rankType).toBe('Knight');
  });

  it('refuses a player who has not joined, and a level below 1', async () => {
    expect(await setPlayerLevel(db, 1, 5)).toEqual({ ok: false, reason: 'no-player' });
    await seedPlayer(pg, 2);
    expect(await setPlayerLevel(db, 2, 0)).toEqual({ ok: false, reason: 'bad-level' });
  });
});
