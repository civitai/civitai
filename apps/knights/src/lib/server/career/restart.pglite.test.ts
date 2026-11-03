import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedPlayer, setGold } from '../../../test/seed';
import { hasUnseenReset } from '../smites/smites.service';
import { restartCareer } from './restart.service';

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
});
afterAll(() => pg.close());
beforeEach(() =>
  pg.exec(`TRUNCATE "KnightsPlayer","NewOrderPlayer","NewOrderSmite" RESTART IDENTITY CASCADE`)
);

const player = async (id: number) =>
  (
    await pg.query<{
      rankType: string;
      exp: number;
      fervor: number;
      startAt: Date;
      goldPending: number;
      goldEarned: number;
      goldConverted: number;
    }>(`SELECT * FROM "NewOrderPlayer" WHERE "userId"=$1`, [id])
  ).rows[0];

describe('restartCareer', () => {
  it('returns the player to Acolyte with no XP and starts a new career', async () => {
    await seedPlayer(pg, 7, 'Templar');
    await pg.query(`UPDATE "NewOrderPlayer" SET "exp"=900, "fervor"=40 WHERE "userId"=7`);
    const before = await player(7);

    expect(await restartCareer(db, 7, new Date())).toEqual({ reset: true });

    const after = await player(7);
    expect(after).toMatchObject({ rankType: 'Acolyte', exp: 0 });
    // The column is the original game's: a v2 restart never writes it.
    expect(after.fervor).toBe(40);
    expect(after.startAt.getTime()).toBeGreaterThan(before.startAt.getTime());
  });

  it('forfeits unconverted gold and keeps what was converted or reserved', async () => {
    await seedPlayer(pg, 7);
    await setGold(pg, 7, { pending: 30, earned: 100, converted: 60 });

    await restartCareer(db, 7, new Date());

    expect(await player(7)).toMatchObject({ goldPending: 0, goldEarned: 60, goldConverted: 60 });
  });

  it('cleanses active smites and leaves other players alone', async () => {
    await seedPlayer(pg, 7);
    await seedPlayer(pg, 8, 'Paladin');
    await pg.query(`INSERT INTO "NewOrderSmite" ("targetPlayerId") VALUES (7),(7),(8)`);

    await restartCareer(db, 7, new Date());

    const smites = (
      await pg.query<{ targetPlayerId: number; cleansed: boolean }>(
        `SELECT "targetPlayerId", "cleansedAt" IS NOT NULL AS cleansed FROM "NewOrderSmite" ORDER BY id`
      )
    ).rows;
    expect(smites.map((s) => s.cleansed)).toEqual([true, true, false]);
    expect((await player(8)).rankType).toBe('Paladin');
  });

  it('does not tell the player about a reset they just asked for', async () => {
    await seedPlayer(pg, 7);
    expect(await hasUnseenReset(db, 7, new Date())).toBe(false);

    await restartCareer(db, 7, new Date());

    expect(await hasUnseenReset(db, 7, new Date())).toBe(false);
  });

  it('does nothing for a user who has not joined', async () => {
    expect(await restartCareer(db, 7, new Date())).toEqual({ reset: false });
    expect((await pg.query(`SELECT 1 FROM "NewOrderPlayer"`)).rows).toHaveLength(0);
  });
});
