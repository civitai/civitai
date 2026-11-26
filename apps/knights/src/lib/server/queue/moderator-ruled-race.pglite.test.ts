import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { lockImage, seedImage, seedPlayer } from '../../../test/seed';
import {
  castVote,
  closeModeratorRuledItems,
  enqueueItem,
  ensureVotePartitions,
  escalateExpired,
} from './queue.service';

const NOW = new Date('2026-12-15T12:00:00Z');
const LATER = new Date('2026-12-15T14:00:00Z');

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb({ serialize: true }));
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(async () => {
  await pg.close();
});

it('leaves an item another path moved off Open after the sweep read it', async () => {
  await seedPlayer(pg, 1, 'Paladin');
  await seedImage(pg, 10, { nsfwLevel: 2 });
  const id = await enqueueItem(
    db,
    {
      questionKey: 'knights.image.nsfwLevel',
      imageId: 10,
      source: 'test',
      minRank: 'Paladin',
      expiresAt: new Date('2026-12-15T13:00:00Z'),
    },
    NOW
  );
  const applyConsensus = vi.fn();
  await castVote(db, { userId: 1, itemId: id, answer: '2' }, { applyConsensus, now: () => NOW });
  await lockImage(pg, 10, { reason: 'Moderator review', level: 4 });

  // The connection is handed out in call order: the sweep reads the item Open, the expiry (one vote, below the Paladin quorum) commits, then the sweep's close runs.
  const [swept, escalated] = await Promise.all([
    closeModeratorRuledItems(db, { now: LATER }),
    escalateExpired(db, { now: LATER }),
  ]);

  expect(escalated).toMatchObject({ expired: 1 });
  expect(swept).toEqual({ closed: 0, failed: 0 });
  const row = (
    await pg.query<Record<string, unknown>>(
      `SELECT status, reason, "resolvedValue" FROM "KnightsQueueItem" WHERE id=$1`,
      [id]
    )
  ).rows[0];
  expect(row).toEqual({ status: 'Closed', reason: 'expired', resolvedValue: null });
  const votes = await pg.query<{ verdict: string; settledAt: Date | null }>(
    `SELECT verdict, "settledAt" FROM "KnightsVote" WHERE "itemId"=$1`,
    [id]
  );
  expect(votes.rows).toEqual([{ verdict: 'inconclusive', settledAt: null }]);
});

it('leaves an item a moderator claimed on the Inquisitor page after the sweep read it', async () => {
  await seedPlayer(pg, 3, 'Knight');
  await seedImage(pg, 30, { nsfwLevel: 2 });
  const id = await enqueueItem(
    db,
    { questionKey: 'knights.image.nsfwLevel', imageId: 30, source: 'test', expiresAt: null },
    NOW
  );
  const applyConsensus = vi.fn();
  await castVote(db, { userId: 3, itemId: id, answer: '2' }, { applyConsensus, now: () => NOW });
  await db
    .updateTable('KnightsQueueItem')
    .set({ status: 'Inquisitor', escalationReason: 'pushed-down' })
    .where('id', '=', id)
    .execute();
  await lockImage(pg, 30, { reason: 'Moderator review', level: 4 });

  // The connection is handed out in call order: the sweep reads the item waiting on the Inquisitors, a moderator's claim commits, then the sweep's close runs.
  const [swept] = await Promise.all([
    closeModeratorRuledItems(db, { now: LATER }),
    db
      .updateTable('KnightsQueueItem')
      .set({ status: 'Ruling', resolvedBy: 7 })
      .where('id', '=', id)
      .where('status', '=', 'Inquisitor')
      .execute(),
  ]);

  expect(swept).toEqual({ closed: 0, failed: 0 });
  const row = (
    await pg.query<Record<string, unknown>>(
      `SELECT status, reason, "resolvedValue" FROM "KnightsQueueItem" WHERE id=$1`,
      [id]
    )
  ).rows[0];
  expect(row).toEqual({ status: 'Ruling', reason: null, resolvedValue: null });
  const votes = await pg.query<{ verdict: string; settledAt: Date | null }>(
    `SELECT verdict, "settledAt" FROM "KnightsVote" WHERE "itemId"=$1`,
    [id]
  );
  expect(votes.rows).toEqual([{ verdict: 'pending', settledAt: null }]);
});

it('closes against the level the image has when the close runs, not when the sweep read it', async () => {
  await seedPlayer(pg, 2, 'Knight');
  await seedImage(pg, 20, { nsfwLevel: 2 });
  const id = await enqueueItem(
    db,
    { questionKey: 'knights.image.nsfwLevel', imageId: 20, source: 'test', expiresAt: null },
    NOW
  );
  const applyConsensus = vi.fn();
  await castVote(db, { userId: 2, itemId: id, answer: '4' }, { applyConsensus, now: () => NOW });
  await lockImage(pg, 20, { reason: 'Moderator review', level: 4 });

  // In call order: the sweep selects the item at level 4, the moderator re-rates the image to 8, then the sweep closes it.
  const [swept] = await Promise.all([
    closeModeratorRuledItems(db, { now: NOW }),
    // The moderator's write, from the main app: the Knights role cannot write "Image".
    pg.query(`UPDATE "Image" SET "nsfwLevel" = 8 WHERE id = 20`),
  ]);

  expect(swept).toEqual({ closed: 1, failed: 0 });
  const row = (
    await pg.query<Record<string, unknown>>(
      `SELECT status, reason, "resolvedValue" FROM "KnightsQueueItem" WHERE id=$1`,
      [id]
    )
  ).rows[0];
  expect(row).toEqual({ status: 'Closed', reason: 'moderator-ruled', resolvedValue: '8' });
  const votes = await pg.query<{ verdict: string }>(
    `SELECT verdict FROM "KnightsVote" WHERE "itemId"=$1`,
    [id]
  );
  expect(votes.rows).toEqual([{ verdict: 'failed' }]);
});
