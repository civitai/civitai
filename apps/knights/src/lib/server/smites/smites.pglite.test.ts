import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { castVote, ensureVotePartitions, enqueueItem } from '../queue/queue.service';
import { getPlayerStatus } from '../player-status';
import { SMITES } from './config';
import {
  activeSmiteCount,
  dismissResetNotice,
  expireSmites,
  hasUnseenReset,
  issueSmite,
  playersDueForReset,
  resetPendingPlayers,
} from './smites.service';

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');
let pg: PGlite;
let db: Kysely<DB>;
const deps = { applyConsensus: async () => ({ outcome: 'applied' as const }), now: () => NOW };

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","KnightsPlayer","NewOrderPlayer","NewOrderSmite","Image","Post" RESTART IDENTITY CASCADE`
  );
});

const smiteRows = async (id: number) =>
  (
    await pg.query<{ remaining: number; cleansedAt: Date | null; cleansedReason: string | null }>(
      `SELECT remaining, "cleansedAt", "cleansedReason" FROM "NewOrderSmite" WHERE "targetPlayerId"=$1 ORDER BY id`,
      [id]
    )
  ).rows;

async function resolveItemWith(correctVoters: number[], wrongVoters: number[], imageId = 10) {
  await seedImage(pg, imageId);
  const id = await enqueueItem(
    db,
    { questionKey: Q, imageId, source: 'test', expiresAt: null },
    NOW
  );
  for (const u of correctVoters) await castVote(db, { userId: u, itemId: id, answer: '4' }, deps);
  for (const u of wrongVoters) await castVote(db, { userId: u, itemId: id, answer: '8' }, deps);
}

describe('smites', () => {
  it('shows the hearts left in the player status', async () => {
    await seedPlayer(pg, 1);
    await pg.query(`INSERT INTO "NewOrderSmite" ("targetPlayerId") VALUES (1),(1)`);
    await pg.query(`INSERT INTO "NewOrderSmite" ("targetPlayerId","cleansedAt") VALUES (1, now())`);
    expect(await getPlayerStatus(db, 1)).toMatchObject({ smites: 2, maxSmites: SMITES.max });
  });

  it('works every active smite of a correct voter down by one when the item settles', async () => {
    for (const u of [1, 2, 3, 4, 5]) await seedPlayer(pg, u);
    await pg.query(
      `INSERT INTO "NewOrderSmite" ("targetPlayerId","remaining") VALUES (1,5),(1,1),(5,5)`
    );
    await resolveItemWith([1, 2, 3, 4], [5]);
    const rows = await smiteRows(1);
    expect(rows[0]).toMatchObject({ remaining: 4, cleansedAt: null });
    expect(rows[1]).toMatchObject({ remaining: 0, cleansedReason: 'Smite expired' });
    expect(rows[1].cleansedAt).not.toBeNull();
    expect((await smiteRows(5))[0].remaining).toBe(5);
  });

  it('lapses a smite after the expiry days', async () => {
    await seedPlayer(pg, 1);
    await pg.query(
      `INSERT INTO "NewOrderSmite" ("targetPlayerId","createdAt") VALUES (1,$1),(1,$2)`,
      [
        new Date(NOW.getTime() - (SMITES.expireAfterDays + 1) * 86_400_000),
        new Date(NOW.getTime() - 86_400_000),
      ]
    );
    expect(await expireSmites(db, NOW)).toBe(1);
    expect(await activeSmiteCount(db, 1)).toBe(1);
  });

  it('refuses a vote while a reset is due', async () => {
    await seedPlayer(pg, 1);
    await seedImage(pg, 10);
    const id = await enqueueItem(
      db,
      { questionKey: Q, imageId: 10, source: 'test', expiresAt: null },
      NOW
    );
    await pg.query(`INSERT INTO "NewOrderSmite" ("targetPlayerId") VALUES (1),(1),(1)`);
    expect(await castVote(db, { userId: 1, itemId: id, answer: '4' }, deps)).toEqual({
      status: 'rejected',
      reason: 'reset-pending',
    });
  });

  it('issues a smite as the system player and reports the active count', async () => {
    await seedPlayer(pg, 1);
    expect(await issueSmite(db, { playerId: 1, reason: 'x', now: NOW })).toBe(1);
    expect(await issueSmite(db, { playerId: 1, reason: 'x', now: NOW })).toBe(2);
    const row = (
      await pg.query<{ givenById: number; size: number }>(
        `SELECT "givenById", size FROM "NewOrderSmite" LIMIT 1`
      )
    ).rows[0];
    expect(row).toEqual({ givenById: SMITES.systemGiverId, size: SMITES.size });
  });
});

describe('career reset retry', () => {
  it('retries every player still at the limit, and not those under it', async () => {
    for (const u of [1, 2, 3]) await seedPlayer(pg, u);
    await pg.query(
      `INSERT INTO "NewOrderSmite" ("targetPlayerId") VALUES (1),(1),(1),(2),(2),(3),(3),(3),(3)`
    );
    await pg.query(
      `UPDATE "NewOrderSmite" SET "cleansedAt"=now() WHERE "targetPlayerId"=3 AND id > 8`
    );
    expect(await playersDueForReset(db)).toEqual([1, 3]);

    const resetPlayer = vi.fn<(id: number) => Promise<void>>(async (id) => {
      if (id === 3) throw new Error('main app down');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await resetPendingPlayers(db, { resetPlayer })).toEqual({ due: 2, failed: 1 });
    expect(resetPlayer.mock.calls.map((c) => c[0])).toEqual([1, 3]);
  });
});

describe('career reset notice', () => {
  const startAt = (id: number, at: Date) =>
    pg.query(`UPDATE "NewOrderPlayer" SET "startAt"=$2 WHERE "userId"=$1`, [id, at]);
  const later = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

  it('stays quiet about a reset from before the player first looked', async () => {
    await seedPlayer(pg, 1, 'Knight', { startAt: '2026-12-10 00:00:00' });
    expect(await hasUnseenReset(db, 1, NOW)).toBe(false);
    expect(await hasUnseenReset(db, 1, NOW)).toBe(false);
  });

  it('shows a reset that lands after the first look until dismissed, whoever or whenever did it', async () => {
    await seedPlayer(pg, 1);
    await hasUnseenReset(db, 1, NOW);
    await startAt(1, later(1));
    expect(await hasUnseenReset(db, 1, later(2))).toBe(true);
    await dismissResetNotice(db, 1, later(2));
    expect(await hasUnseenReset(db, 1, later(2))).toBe(false);
    await startAt(1, later(3));
    expect(await hasUnseenReset(db, 1, later(4))).toBe(true);
  });

  it('has nothing to show a user who has not joined', async () => {
    expect(await hasUnseenReset(db, 99, NOW)).toBe(false);
  });
});
