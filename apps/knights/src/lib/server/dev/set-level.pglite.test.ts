import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { getLevelProgression } from '@civitai/shared/new-order-levels';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedGradedVotes, seedPlayer } from '../../../test/seed';
import { ensureVotePartitions } from '../queue/queue.service';
import { MAX_LEVEL } from '../progression/levels';
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

  it('forgets the original game counter of the player once the level is saved', async () => {
    await seedPlayer(pg, 1);
    const forget = vi.fn(async () => undefined);

    await setPlayerLevel(db, 1, 5, forget);

    expect(forget).toHaveBeenCalledWith(1);
  });

  it('still succeeds when the counter cannot be reached', async () => {
    await seedPlayer(pg, 1);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await setPlayerLevel(db, 1, 5, async () => Promise.reject(new Error('down')));

    expect(result).toMatchObject({ ok: true });
    expect(log).toHaveBeenCalled();
  });

  it('refuses a level whose XP would not fit the column', async () => {
    await seedPlayer(pg, 1);
    expect(await setPlayerLevel(db, 1, MAX_LEVEL + 1)).toEqual({ ok: false, reason: 'bad-level' });
    expect(await setPlayerLevel(db, 1, MAX_LEVEL)).toMatchObject({ ok: true });
    expect((await row(1)).exp).toBeLessThanOrEqual(2147483647);
  });

  it('refuses a player who has not joined, and a level below 1', async () => {
    expect(await setPlayerLevel(db, 1, 5)).toEqual({ ok: false, reason: 'no-player' });
    await seedPlayer(pg, 2);
    expect(await setPlayerLevel(db, 2, 0)).toEqual({ ok: false, reason: 'bad-level' });
  });
});
