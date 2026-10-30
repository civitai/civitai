import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { ensureVotePartitions } from '../queue/queue.service';
import { importYesNo, type YesNoRow } from './import';
import { closeStrandedYesNo } from './sweep';
import { castYesNoVote } from './vote';

const NOW = new Date('2026-12-21T12:00:00Z');
const LATER = new Date('2027-01-10T12:00:00Z'); // 20 days on

let pg: PGlite;
let db: Kysely<DB>;

const row = (id: string, imageId: number, o: Partial<YesNoRow> = {}): YesNoRow => ({
  externalId: id,
  imageId,
  axis: 'violence',
  audience: 'players',
  prompt: `Question ${id}?`,
  yesEffect: 'R4',
  noEffect: 'R3',
  meta: {},
  ...o,
});
async function seed(rows: YesNoRow[]) {
  for (const imageId of new Set(rows.map((r) => r.imageId))) await seedImage(pg, imageId);
  await importYesNo(db, rows);
  return Object.fromEntries(
    (
      await pg.query<{ id: number; externalId: string }>(
        `SELECT id, "externalId" FROM "KnightsQueueItem"`
      )
    ).rows.map((r) => [r.externalId, r.id])
  );
}
const answer = (userId: number, itemId: number, value = 'yes') =>
  castYesNoVote(db, { userId, itemId, answer: value }, { now: () => NOW });
const sweep = (now = NOW) => closeStrandedYesNo(db, { now, maxAgeDays: 14 });
const item = async (id: number) =>
  (await pg.query<Record<string, unknown>>(`SELECT * FROM "KnightsQueueItem" WHERE id=$1`, [id]))
    .rows[0];
const player = async (id: number) =>
  (
    await pg.query<{ goldPending: number; goldEarned: number; exp: number }>(
      `SELECT "goldPending","goldEarned",exp FROM "NewOrderPlayer" WHERE "userId"=$1`,
      [id]
    )
  ).rows[0];

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","KnightsPlayerDay","Image","Post" RESTART IDENTITY CASCADE; DELETE FROM "KnightsQuestion" WHERE key LIKE 'knights.yesno.%'`
  );
  for (const p of [1, 2]) await seedPlayer(pg, p);
});

describe('closing stranded questions', () => {
  it('closes an answered question whose image is no longer shown, dropping the gold of its answers but keeping the XP', async () => {
    const ids = await seed([row('a', 10), row('b', 11)]);
    await answer(1, ids.a);
    await answer(2, ids.a, 'no');
    await answer(1, ids.b);
    await pg.exec(`UPDATE "Image" SET "blockedFor" = 'x' WHERE id = 10`);

    expect(await sweep()).toEqual({ unplayable: 1, stale: 0, failed: 0 });

    expect(await item(ids.a)).toMatchObject({ status: 'Closed', reason: 'unplayable' });
    expect(await item(ids.b)).toMatchObject({ status: 'Open' });
    const votes = await pg.query(
      `SELECT "playerId", verdict, gold, "settledAt" IS NOT NULL AS settled FROM "KnightsVote" WHERE "itemId"=$1 ORDER BY "playerId"`,
      [ids.a]
    );
    expect(votes.rows).toEqual([
      { playerId: 1, verdict: 'inconclusive', gold: 0, settled: true },
      { playerId: 2, verdict: 'inconclusive', gold: 0, settled: true },
    ]);
    // Player 1 still holds item b's pending gold; player 2 holds none. XP was paid at vote time and stays.
    expect(await player(1)).toMatchObject({ goldPending: 100, goldEarned: 0, exp: 20 });
    expect(await player(2)).toMatchObject({ goldPending: 0, goldEarned: 0, exp: 10 });
  });

  it('closes a question whose axis was switched off', async () => {
    const ids = await seed([row('a', 10)]);
    await answer(1, ids.a);
    await pg.exec(
      `UPDATE "KnightsQuestion" SET active = false WHERE key = 'knights.yesno.violence'`
    );

    expect(await sweep()).toMatchObject({ unplayable: 1 });
    expect(await item(ids.a)).toMatchObject({ status: 'Closed', reason: 'unplayable' });
  });

  it('closes a question nobody has answered for the maximum age, and leaves a recent one', async () => {
    const ids = await seed([row('old', 10), row('recent', 11)]);
    await answer(1, ids.old);
    await answer(1, ids.recent);
    await pg.exec(
      `UPDATE "KnightsQueueItem" SET "updatedAt" = '2027-01-08' WHERE id = ${ids.recent}`
    );

    expect(await sweep(LATER)).toEqual({ unplayable: 0, stale: 1, failed: 0 });
    expect(await item(ids.old)).toMatchObject({ status: 'Closed', reason: 'stale' });
    expect(await item(ids.recent)).toMatchObject({ status: 'Open' });
    expect(await player(1)).toMatchObject({ goldPending: 100 });
  });

  it("leaves alone questions with no answers, moderators' questions, and closed ones; and a repeat finds nothing", async () => {
    const ids = await seed([
      row('fresh', 10),
      row('policy', 11, { audience: 'moderators' }),
      row('done', 12),
    ]);
    await pg.exec(`UPDATE "KnightsQueueItem" SET "updatedAt" = '2026-01-01'`);
    await pg.exec(`UPDATE "Image" SET "blockedFor" = 'x'`);
    await pg.exec(
      `UPDATE "KnightsQueueItem" SET status = 'Consensus', "voteCount" = 5 WHERE id = ${ids.done}`
    );

    expect(await sweep(LATER)).toEqual({ unplayable: 0, stale: 0, failed: 0 });
    expect(await item(ids.fresh)).toMatchObject({ status: 'Open' });
    expect(await item(ids.policy)).toMatchObject({ status: 'Open' });

    await pg.exec(`UPDATE "Image" SET "blockedFor" = NULL`);
    await answer(1, ids.fresh);
    await pg.exec(`UPDATE "Image" SET "blockedFor" = 'x'`);
    expect(await sweep()).toMatchObject({ unplayable: 1 });
    expect(await sweep()).toEqual({ unplayable: 0, stale: 0, failed: 0 });
  });

  it('does not touch labels that were already written', async () => {
    const ids = await seed([row('a', 10)]);
    await answer(1, ids.a);
    await pg.exec(`UPDATE "KnightsVote" SET labelled = true`);
    await pg.exec(`UPDATE "Image" SET "blockedFor" = 'x'`);
    await sweep();
    expect((await pg.query(`SELECT labelled FROM "KnightsVote"`)).rows).toEqual([
      { labelled: true },
    ]);
  });

  it('steps over a question it cannot close, so the others still are, across pages and within the cap', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ids = await seed(
      Array.from({ length: 6 }, (_, i) => row(`q${i}`, 10 + i)) // ids 1..6
    );
    for (const id of Object.values(ids)) await answer(1, id);
    await pg.exec(`UPDATE "Image" SET "blockedFor" = 'x'`);
    await pg.exec(`
      CREATE OR REPLACE FUNCTION refuse_close() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'cannot close'; END $$;
      CREATE TRIGGER refuse_close BEFORE UPDATE ON "KnightsQueueItem"
        FOR EACH ROW WHEN (OLD.id IN (${ids.q0}, ${ids.q1}) AND NEW.status = 'Closed') EXECUTE FUNCTION refuse_close();`);
    try {
      const first = await closeStrandedYesNo(db, {
        now: NOW,
        maxAgeDays: 14,
        pageSize: 2,
        limit: 2,
      });
      expect(first).toEqual({ unplayable: 2, stale: 0, failed: 2 });
      const open = await pg.query<{ externalId: string }>(
        `SELECT "externalId" FROM "KnightsQueueItem" WHERE status = 'Open' ORDER BY id`
      );
      expect(open.rows.map((r) => r.externalId)).toEqual(['q0', 'q1', 'q4', 'q5']);

      const second = await closeStrandedYesNo(db, { now: NOW, maxAgeDays: 14, pageSize: 2 });
      expect(second).toEqual({ unplayable: 2, stale: 0, failed: 2 });
    } finally {
      await pg.exec(`DROP TRIGGER refuse_close ON "KnightsQueueItem"`);
    }
  });

  it('counts each close once, mirrors the XP a close pays (none for a no-outcome close), and stops when its time budget is spent', async () => {
    const ids = await seed([row('a', 10), row('b', 11)]);
    await answer(1, ids.a);
    await answer(2, ids.b);
    await pg.exec(`UPDATE "Image" SET "blockedFor" = 'x'`);
    const mirror = vi.fn(async () => undefined);

    expect(await closeStrandedYesNo(db, { now: NOW, maxAgeDays: 14, budgetMs: 0, mirror })).toEqual(
      {
        unplayable: 0,
        stale: 0,
        failed: 0,
      }
    );
    expect((await item(ids.a)).status).toBe('Open');

    expect(await closeStrandedYesNo(db, { now: NOW, maxAgeDays: 14, mirror })).toEqual({
      unplayable: 2,
      stale: 0,
      failed: 0,
    });
    // A close with no outcome pays no bulk XP; the vote XP was mirrored when each answer was given.
    expect(mirror).not.toHaveBeenCalled();
  });
});
