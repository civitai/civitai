import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { grantStreakBadges } from './streak-badges';

const IDS = { 7: 7001, 30: 7002, 100: 7003 };

let pg: PGlite;
let db: Kysely<DB>;

const owned = async (userId: number) =>
  (
    await pg.query<{ cosmeticId: number }>(
      `SELECT "cosmeticId" FROM "UserCosmetic" WHERE "userId"=$1 ORDER BY "cosmeticId"`,
      [userId]
    )
  ).rows.map((row) => row.cosmeticId);

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(`TRUNCATE "UserCosmetic","Cosmetic" RESTART IDENTITY CASCADE`);
  await pg.exec(
    `INSERT INTO "Cosmetic" ("id","source") VALUES (${IDS[7]},'Trophy'),(${IDS[30]},'Trophy'),(${IDS[100]},'Trophy')`
  );
});

describe('grantStreakBadges', () => {
  it('grants the 7-day badge on the streak that reaches 7, and nothing before', async () => {
    await grantStreakBadges(db, 1, 6, IDS);
    expect(await owned(1)).toEqual([]);

    await grantStreakBadges(db, 1, 7, IDS);
    expect(await owned(1)).toEqual([IDS[7]]);
  });

  it('grants every milestone a streak has passed, so a jump to 31 grants the 7- and 30-day badges', async () => {
    await grantStreakBadges(db, 1, 31, IDS);
    expect(await owned(1)).toEqual([IDS[7], IDS[30]]);
  });

  it('grants a badge once ever, so reaching 7 again after a reset adds nothing', async () => {
    await grantStreakBadges(db, 1, 7, IDS);
    for (let streak = 1; streak <= 7; streak++) await grantStreakBadges(db, 1, streak, IDS);

    const { rows } = await pg.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "UserCosmetic" WHERE "userId"=1 AND "cosmeticId"=$1`,
      [IDS[7]]
    );
    expect(rows[0].count).toBe(1);
  });

  it('skips a milestone whose id is not set yet', async () => {
    await grantStreakBadges(db, 1, 100, { 7: null, 30: IDS[30], 100: null });
    expect(await owned(1)).toEqual([IDS[30]]);
  });
});
