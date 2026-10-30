import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { ledgerOf } from '../progression/progression';
import { castVote, enqueueItem, ensureVotePartitions } from '../queue/queue.service';
import { importYesNo } from './import';
import { castYesNoVote } from './vote';

const NOW = new Date('2026-12-21T12:00:00Z');
const RATING = 'knights.test.rate';

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","KnightsPlayerDay","Image","Post" RESTART IDENTITY CASCADE; DELETE FROM "KnightsQuestion" WHERE key LIKE 'knights.yesno.%' OR key = '${RATING}'`
  );
  await pg.exec(`INSERT INTO "KnightsQuestion" ("key","kind","prompt","options")
    VALUES ('${RATING}','choice','Rate?','[{"value":"a","label":"A"},{"value":"b","label":"B"}]')`);
});

const wallet = async (id: number) =>
  (
    await pg.query<Record<string, unknown>>(
      `SELECT exp, "goldPending", "goldEarned", fervor, "rankType" FROM "NewOrderPlayer" WHERE "userId"=$1`,
      [id]
    )
  ).rows[0];
const ballot = async (itemId: number, playerId: number) =>
  (
    await pg.query<Record<string, unknown>>(
      `SELECT verdict, gold, xp, "settledAt" IS NOT NULL AS settled FROM "KnightsVote" WHERE "itemId"=$1 AND "playerId"=$2`,
      [itemId, playerId]
    )
  ).rows[0];
const smite = async (target: number) =>
  (
    await pg.query<{ remaining: number }>(
      `SELECT remaining FROM "NewOrderSmite" WHERE "targetPlayerId"=$1`,
      [target]
    )
  ).rows[0].remaining;

describe('a yes/no answer and a rating vote with the same outcome', () => {
  it('earn the same XP, gold, accuracy, fervor and smite work-off, right or wrong', async () => {
    await seedImage(pg, 10);
    await seedImage(pg, 11);
    for (const id of [1, 2, 3, 4, 5, 11, 12, 13, 14, 15]) await seedPlayer(pg, id);
    await pg.exec(`INSERT INTO "NewOrderSmite" ("targetPlayerId") VALUES (1),(11),(5),(15)`);

    await importYesNo(db, [
      {
        externalId: 'q-a',
        imageId: 10,
        axis: 'violence',
        audience: 'players',
        prompt: 'Is it?',
        yesEffect: null,
        noEffect: null,
        meta: {},
      },
    ]);
    const yesNoItem = (
      await pg.query<{ id: number }>(`SELECT id FROM "KnightsQueueItem" WHERE "externalId"='q-a'`)
    ).rows[0].id;
    const ratingItem = await enqueueItem(
      db,
      { questionKey: RATING, imageId: 11, source: 'test', expiresAt: null },
      NOW
    );

    const deps = { applyConsensus: async () => ({ outcome: 'applied' as const }), now: () => NOW };
    // Three of five agree. Players 4 and 5 (14 and 15) are with the minority.
    for (const [yn, rate, agree] of [
      [1, 11, true],
      [2, 12, true],
      [3, 13, true],
      [4, 14, false],
      [5, 15, false],
    ] as const) {
      expect(
        await castYesNoVote(
          db,
          { userId: yn, itemId: yesNoItem, answer: agree ? 'yes' : 'no' },
          deps
        )
      ).toEqual({ status: 'recorded' });
      expect(
        await castVote(db, { userId: rate, itemId: ratingItem, answer: agree ? 'a' : 'b' }, deps)
      ).not.toMatchObject({ status: 'rejected' });
    }

    for (let i = 0; i < 5; i++) {
      expect(await wallet(1 + i)).toEqual(await wallet(11 + i));
      expect(await ballot(yesNoItem, 1 + i)).toEqual(await ballot(ratingItem, 11 + i));
      expect(await ledgerOf(db, 1 + i)).toEqual(await ledgerOf(db, 11 + i));
    }
    expect(await ballot(yesNoItem, 1)).toMatchObject({ verdict: 'correct', settled: true });
    expect(await ballot(yesNoItem, 5)).toMatchObject({ verdict: 'failed', gold: 0, settled: true });
    expect(await ledgerOf(db, 1)).toEqual({ correct: 1, graded: 1 });

    // A right answer works a smite off; a wrong one does not. Both kinds of vote do the same.
    expect(await smite(1)).toBe(await smite(11));
    expect(await smite(1)).toBeLessThan(10);
    expect(await smite(5)).toBe(10);
    expect(await smite(15)).toBe(10);
  });

  it('forfeit an answer given before a career reset alike', async () => {
    await seedImage(pg, 10);
    await seedImage(pg, 11);
    for (const id of [1, 2, 3, 4, 5, 11, 12, 13, 14, 15]) await seedPlayer(pg, id);
    await importYesNo(db, [
      {
        externalId: 'q-a',
        imageId: 10,
        axis: 'violence',
        audience: 'players',
        prompt: 'Is it?',
        yesEffect: null,
        noEffect: null,
        meta: {},
      },
    ]);
    const yesNoItem = (
      await pg.query<{ id: number }>(`SELECT id FROM "KnightsQueueItem" WHERE "externalId"='q-a'`)
    ).rows[0].id;
    const ratingItem = await enqueueItem(
      db,
      { questionKey: RATING, imageId: 11, source: 'test', expiresAt: null },
      NOW
    );
    const deps = { applyConsensus: async () => ({ outcome: 'applied' as const }), now: () => NOW };
    await castYesNoVote(db, { userId: 1, itemId: yesNoItem, answer: 'yes' }, deps);
    await castVote(db, { userId: 11, itemId: ratingItem, answer: 'a' }, deps);
    for (const id of [1, 11]) {
      await pg.query(
        `UPDATE "NewOrderPlayer" SET "startAt" = '2026-12-21 12:00:30', "goldPending" = 0 WHERE "userId" = $1`,
        [id]
      );
    }
    const later = { ...deps, now: () => new Date('2026-12-21T12:05:00Z') };
    for (const [yn, rate] of [
      [2, 12],
      [3, 13],
      [4, 14],
      [5, 15],
    ] as const) {
      await castYesNoVote(db, { userId: yn, itemId: yesNoItem, answer: 'yes' }, later);
      await castVote(db, { userId: rate, itemId: ratingItem, answer: 'a' }, later);
    }

    expect(await wallet(1)).toEqual(await wallet(11));
    expect(await wallet(1)).toMatchObject({ exp: 10, goldEarned: 0, goldPending: 0 });
    expect(await ballot(yesNoItem, 1)).toEqual(await ballot(ratingItem, 11));
  });
});
