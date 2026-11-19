import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../test/pglite-kysely';
import { seedPlayer, setGold } from '../../test/seed';
import { getGoldBalance } from './conversion/balance';
import { getPlayerStatus } from './player-status';

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(`TRUNCATE "KnightsGoldConversion", "NewOrderPlayer", "User" RESTART IDENTITY`);
});

describe('the gold in a player status', () => {
  it('is what the shop calls spendable, so gold the shop took no longer counts', async () => {
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { pending: 3_100, earned: 60_200, converted: 60_000 });

    const status = await getPlayerStatus(db, 1);

    expect(status).toMatchObject({ goldEarned: 60_200, goldPending: 3_100, goldSpendable: 200 });
    expect(status?.goldSpendable).toBe((await getGoldBalance(db, 1)).convertible);
  });

  it('is 0 while the player is held, as in the shop', async () => {
    await seedPlayer(pg, 1);
    await setGold(pg, 1, { earned: 5_000 });
    await pg.exec(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt"='2026-12-19' WHERE "userId"=1`);

    expect(await getPlayerStatus(db, 1)).toMatchObject({ goldSpendable: 0 });
  });
});
