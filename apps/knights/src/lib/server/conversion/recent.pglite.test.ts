import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedPlayer } from '../../../test/seed';
import { RECENT_CONVERSIONS_LIMIT, listRecentConversions } from './recent';

let pg: PGlite;
let db: Kysely<DB>;

const insert = (
  playerId: number,
  key: string,
  createdAt: string,
  {
    status = 'paid',
    gold = 1000,
    buzz = 10,
  }: { status?: string; gold?: number; buzz?: number } = {}
) =>
  pg.query(
    `INSERT INTO "KnightsGoldConversion" ("playerId","gold","buzz","status","externalTransactionId","createdAt") VALUES ($1,$2,$3,$4,$5,$6)`,
    [playerId, gold, buzz, status, key, createdAt]
  );

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(`TRUNCATE "KnightsGoldConversion", "NewOrderPlayer", "User" RESTART IDENTITY`);
});

describe('listRecentConversions', () => {
  it('returns only the asked player conversions, newest first, with their real status', async () => {
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    await insert(1, 'a', '2026-12-01 10:00:00', { status: 'paid', gold: 3000, buzz: 30 });
    await insert(1, 'b', '2026-12-03 10:00:00', { status: 'pending', gold: 500, buzz: 5 });
    await insert(1, 'c', '2026-12-02 10:00:00', { status: 'failed', gold: 700, buzz: 7 });
    await insert(2, 'd', '2026-12-04 10:00:00');

    const rows = await listRecentConversions(db, 1);

    expect(rows.map((r) => [r.status, r.gold, r.buzz])).toEqual([
      ['pending', 500, 5],
      ['failed', 700, 7],
      ['paid', 3000, 30],
    ]);
    expect(rows[0].at).toEqual(new Date('2026-12-03T10:00:00Z'));
  });

  it('keeps the latest ten, breaking a tie on creation time by newest id', async () => {
    await seedPlayer(pg, 1);
    for (let i = 0; i < RECENT_CONVERSIONS_LIMIT + 3; i++) {
      await insert(1, `k${i}`, '2026-12-01 10:00:00', { gold: 100 + i });
    }

    const rows = await listRecentConversions(db, 1);

    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.gold)).toEqual([112, 111, 110, 109, 108, 107, 106, 105, 104, 103]);
  });

  it('is empty for a player with no conversions', async () => {
    await seedPlayer(pg, 1);
    expect(await listRecentConversions(db, 1)).toEqual([]);
  });
});
