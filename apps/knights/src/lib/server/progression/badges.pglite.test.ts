import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedGradedVotes, seedImage, seedPlayer } from '../../../test/seed';
import { promoteToKnight } from '../apprenticeship/apprenticeship.service';
import {
  castVote,
  enqueueItem,
  ensureVotePartitions,
  type QueueDeps,
} from '../queue/queue.service';
import { RANK_BADGE_IDS, grantRankBadges } from './badges';
import { PROGRESSION } from './config';
import { expForLevel } from './levels';

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');
const KNIGHT = RANK_BADGE_IDS.Knight;
const TEMPLAR = RANK_BADGE_IDS.Templar;

let pg: PGlite;
let db: Kysely<DB>;
const deps: QueueDeps = {
  applyConsensus: vi.fn(async () => ({ outcome: 'applied' as const })),
  now: () => NOW,
  mirrorXp: vi.fn(async () => undefined),
};

const owned = async (userId: number) =>
  (
    await pg.query<{ cosmeticId: number }>(
      `SELECT "cosmeticId" FROM "UserCosmetic" WHERE "userId"=$1 ORDER BY "cosmeticId"`,
      [userId]
    )
  ).rows.map((row) => row.cosmeticId);

async function settleCorrect(userId: number, imageId: number) {
  await seedImage(pg, imageId);
  const itemId = await enqueueItem(
    db,
    { questionKey: Q, imageId, source: 'test', expiresAt: null },
    NOW
  );
  for (let i = 0; i < 4; i++) {
    await seedPlayer(pg, 9000 + i + imageId * 10, 'Knight');
    await castVote(db, { userId: 9000 + i + imageId * 10, itemId, answer: '4' }, deps);
  }
  await castVote(db, { userId, itemId, answer: '4' }, deps);
}

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","Image","Post","UserCosmetic","Cosmetic" RESTART IDENTITY CASCADE`
  );
  await pg.exec(
    `INSERT INTO "Cosmetic" ("id","source") VALUES (${KNIGHT},'Trophy'),(${TEMPLAR},'Trophy')`
  );
});

describe('rank badges', () => {
  it('grants the Knight and Templar badges when a settle promotes a Knight to Templar, once', async () => {
    await seedPlayer(pg, 1, 'Knight');
    await seedGradedVotes(pg, 1, { correct: 100 });
    await pg.query(`UPDATE "NewOrderPlayer" SET "exp"=$1 WHERE "userId"=1`, [
      expForLevel(21) - PROGRESSION.voteXp - PROGRESSION.correctXp,
    ]);

    await settleCorrect(1, 100);
    expect(await owned(1)).toEqual([KNIGHT, TEMPLAR]);

    await settleCorrect(1, 101);
    expect(await owned(1)).toEqual([KNIGHT, TEMPLAR]);
  });

  it('grants nothing when a settle does not change the rank', async () => {
    await seedPlayer(pg, 1, 'Knight');
    await seedGradedVotes(pg, 1, { correct: 100 });

    await settleCorrect(1, 100);

    expect(await owned(1)).toEqual([]);
  });

  it('grants the Knight badge when the apprenticeship promotes an Acolyte, and not for a Knight already', async () => {
    await seedPlayer(pg, 1, 'Acolyte');
    await seedPlayer(pg, 2, 'Templar');

    await promoteToKnight(db, 1);
    await promoteToKnight(db, 1);
    await promoteToKnight(db, 2);

    expect(await owned(1)).toEqual([KNIGHT]);
    expect(await owned(2)).toEqual([]);
  });

  it('gives a Paladin the badges below it, as the original game has none for Paladin', async () => {
    await grantRankBadges(db, 1, 'Paladin');
    expect(await owned(1)).toEqual([KNIGHT, TEMPLAR]);
  });

  it('skips a cosmetic that is not a Trophy, and never duplicates one the player holds', async () => {
    await pg.exec(`UPDATE "Cosmetic" SET "source"='Purchase' WHERE "id"=${TEMPLAR}`);
    await pg.exec(
      `INSERT INTO "UserCosmetic" ("userId","cosmeticId","claimKey") VALUES (1,${KNIGHT},'other')`
    );

    await grantRankBadges(db, 1, 'Templar');

    expect(await owned(1)).toEqual([KNIGHT]);
  });

  it('never throws and leaves the surrounding transaction usable when the grant fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await pg.exec(`ALTER TABLE "UserCosmetic" RENAME TO "UserCosmeticGone"`);
    try {
      const rows = await db.transaction().execute(async (trx) => {
        await grantRankBadges(trx, 1, 'Templar');
        return trx.selectFrom('NewOrderPlayer').select('userId').execute();
      });
      expect(rows).toEqual([]);
      expect(error).toHaveBeenCalled();
    } finally {
      await pg.exec(`ALTER TABLE "UserCosmeticGone" RENAME TO "UserCosmetic"`);
      error.mockRestore();
    }
  });
});
